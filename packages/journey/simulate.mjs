// 旅の模擬実行（tabisaki simulate）。
//
// 組んだ旅程を、時計を進めながら頭から順にたどります。通信はしません。
// 「電車が2割遅れたら」「15分寝坊したら」「この美術館が休みだったら」を、
// 出かける前に確かめるためのものです。
//
// 時間の決まり（docs/journey-as-code.md「模擬実行」）:
//   - 予定より早くは動かない（早く着いたら、予定の時刻まで待つ）
//   - 移動   予定の長さ × (1 + 遅れ)。前が押していれば、そのぶん後ろへずれる
//   - 立ち寄り 開く前に着いたら開くまで待つ。最終入場・閉まる時刻を過ぎたら入れない。
//             閉まる時刻で切り上げる（半分も居られなければ「短い」と数える）
//   - 食事・荷物 長さは変えない。後ろへずれるだけ
//   - 自由時間 遅れを吸う（押したぶんだけ縮む）
//   - 宿     着いたらその日は終わり。次の日は予定の時刻から始まる
//   - 最終日の最後が、帰りの時刻（back）を過ぎたら成り立たない

import { hoursFor } from "../core/src/hours.js";

const MIN = 60000;
const JST = 9 * 3600000;
const pad = (n) => String(n).padStart(2, "0");
/** 日本の時刻で HH:MM。日をまたいだら「翌」を付けます。 */
export function hm(d, base = null) {
  const t = new Date(new Date(d).getTime() + JST);
  const s = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  if (!base) return s;
  const b = new Date(new Date(base).getTime() + JST);
  const days = Math.floor(t.getTime() / 86400000) - Math.floor(b.getTime() / 86400000);
  return days > 0 ? `翌${s}` : s;
}
const dateJ = (d) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short" }).format(new Date(d));
const mins = (ms) => Math.round(ms / MIN);

/** 種から決まる乱数（同じ種なら、いつも同じ結果）。 */
export function prng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** 平均 0・ばらつき 1 の正規分布。 */
  next.normal = () => {
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return next;
}

export const SIM_DEFAULTS = Object.freeze({ delay: 0, late: 0, dwell: 1, jitter: 0.15, runs: 0, seed: 1 });
export const SIM_LIMITS = Object.freeze({ delay: [-0.5, 5], late: [0, 720], dwell: [0.1, 3], jitter: [0, 1], runs: [0, 10000] });

/** "20%"・"0.2"・"+20%" を 0.2 にします。 */
export function parseRatio(text, name) {
  const m = /^([+-]?\d+(?:\.\d+)?)(%?)$/.exec(String(text).trim());
  if (!m) throw Object.assign(new Error(`--${name} は 20% か 0.2 のように書いてください`), { exitCode: 2 });
  return m[2] ? Number(m[1]) / 100 : Number(m[1]);
}

/**
 * 旅程を1回たどります。
 *
 * @param {{days: object[]}} itinerary core.plan の返す itinerary
 * @param {{arriveBy: Date|string}} request
 * @param {{delay?: number, late?: number, dwell?: number, closed?: Set<string>|string[],
 *          shiftDays?: number, random?: (() => number) & {normal: () => number}, jitter?: number,
 *          hours?: (spot: object, date: Date) => object}} [opts]
 *   delay   移動の遅れ（0.2 = 2割長くかかる）
 *   late    毎日の出発の遅れ（分）
 *   dwell   立ち寄りの長さの倍率
 *   closed  休みだったことにするスポット（id か名前）
 *   shiftDays 旅程を丸ごと何日ずらすか（別の日に行ったら、を確かめる）
 *   random  渡すと、移動と立ち寄りの長さを毎回ばらつかせる
 * @returns {{ok: boolean, days: object[], problems: object[], returnAt: Date|null, deadline: Date, overMin: number}}
 */
export function simulateOnce(itinerary, request, opts = {}) {
  const o = { ...SIM_DEFAULTS, ...opts };
  const shift = (o.shiftDays ?? 0) * 86400000;
  const at = (d) => new Date(new Date(d).getTime() + shift);
  const closedSet = new Set([...(o.closed ?? [])].map(String));
  const getHours = o.hours ?? hoursFor;
  const problems = [];
  const days = [];
  let clock = null;

  (itinerary.days ?? []).forEach((day, di) => {
    const rows = [];
    const items = day.items ?? [];
    if (!items.length) { days.push({ n: di + 1, date: day.date ? at(day.date) : null, rows }); return; }
    // その日は、予定の出発 + 寝坊ぶん から始まります（前の日の遅れは宿で切れます）
    clock = new Date(at(items[0].start).getTime() + o.late * MIN);
    const dayDate = at(day.date ?? items[0].start);

    for (const it of items) {
      const pStart = at(it.start);
      const pEnd = at(it.end);
      const planned = Math.max(0, pEnd - pStart);
      const row = { kind: it.kind, title: it.title, plannedStart: pStart, plannedEnd: pEnd, status: "ok", note: "" };
      const begin = new Date(Math.max(clock.getTime(), pStart.getTime()));

      if (it.kind === "transit") {
        let f = 1 + o.delay;
        if (o.random) f *= Math.exp(o.random.normal() * o.jitter);
        f = Math.max(0.5, f);
        row.start = begin;
        row.end = new Date(begin.getTime() + Math.round(planned * f / MIN) * MIN);
      } else if (it.kind === "spot") {
        const place = it.place ?? {};
        const forced = closedSet.has(String(it.spotId ?? place.id)) || closedSet.has(String(it.title)) || closedSet.has(String(place.name));
        const h = forced ? { closed: true, reason: "休みだったことにしました（--closed）" } : getHours(place, dayDate);
        row.estimated = !forced && !!(h.estimated ?? it.estimated);
        row.start = begin;
        let end = begin;
        if (h.closed) {
          row.status = "closed";
          row.note = h.reason ?? "休みです";
        } else {
          let enter = begin;
          if (h.open && enter < h.open) { enter = new Date(h.open); row.waitMin = mins(enter - begin); }
          const last = h.lastEntry ?? null;
          if (h.close && enter >= h.close) {
            row.status = "missed";
            row.note = `${hm(h.close)} に閉まっています`;
          } else if (last && enter > last) {
            row.status = "missed";
            row.note = `最終入場 ${hm(last)} を過ぎています`;
          } else {
            let want = planned * o.dwell;
            if (o.random) want *= Math.exp(o.random.normal() * o.jitter / 2);
            want = Math.round(want / MIN) * MIN;
            end = new Date(enter.getTime() + want);
            if (h.close && end > h.close) {
              end = new Date(h.close);
              const got = end - enter;
              row.cutMin = mins(want - got);
              if (got < want / 2) {
                row.status = "short";
                row.note = `${hm(h.close)} に閉まるので、${mins(got)}分しか居られません（予定 ${mins(want)}分）`;
              } else row.note = `${hm(h.close)} に閉まるので、${row.cutMin}分早く切り上げます`;
            }
            row.enter = enter;
          }
        }
        row.end = end;
        if (row.status !== "ok") {
          problems.push({ kind: row.status, day: di + 1, title: it.title, spotId: it.spotId ?? place.id ?? null,
            at: begin, estimated: row.estimated, message: `${di + 1}日目 ${hm(begin)}「${it.title}」: ${row.note}` });
        }
      } else if (it.kind === "free") {
        // 自由時間は遅れを吸います
        row.start = begin;
        row.end = new Date(Math.max(begin.getTime(), pEnd.getTime()));
        if (clock > pStart) row.note = `遅れを ${mins(Math.min(clock, pEnd) - pStart)}分 吸いました`;
      } else {
        row.start = begin;
        row.end = new Date(begin.getTime() + planned);
      }
      row.lateMin = mins(row.end - pEnd);
      rows.push(row);
      clock = row.end;
    }
    days.push({ n: di + 1, date: dayDate, rows });
  });

  const deadline = at(request.arriveBy);
  const returnAt = clock;
  const overMin = returnAt ? mins(returnAt - deadline) : 0;
  if (returnAt && overMin > 0) {
    problems.push({ kind: "late_return", day: days.length, title: "帰り", at: returnAt, estimated: false,
      message: `帰りが ${hm(returnAt, deadline)} になり、${hm(deadline)} を ${overMin}分 過ぎます` });
  }
  return { ok: problems.length === 0, days, problems, returnAt, deadline, overMin };
}

/** 2点のあいだの直線の距離（km）。 */
function km(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;
  const R = 6371;
  const rad = (x) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** これより速い移動は、新幹線でも無理です（直線の距離で測っているので、実際はもっと遅い）。 */
export const MAX_KMH = 320;

/**
 * 動く前の点検。時刻の重なり・移動の長さ・ありえない速さを見ます
 * （営業時間と休みは、simulateOnce が時計を進めながら見ます）。
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
export function checkMoves(itinerary, { maxLegMinutes = null } = {}) {
  const out = [];
  const overlaps = [];
  const tooFast = [];
  const tooLong = [];
  const broken = [];
  let legs = 0;
  (itinerary.days ?? []).forEach((d, di) => {
    const its = d.items ?? [];
    its.forEach((it, i) => {
      const dur = new Date(it.end) - new Date(it.start);
      if (!(dur >= 0)) broken.push(`${di + 1}日目「${it.title}」`);
      if (i && new Date(it.start) < new Date(its[i - 1].end) - MIN) overlaps.push(`${di + 1}日目「${its[i - 1].title}」と「${it.title}」`);
      if (it.kind !== "transit") return;
      legs++;
      if (maxLegMinutes !== null && mins(dur) > maxLegMinutes) tooLong.push(`${di + 1}日目「${it.title}」${mins(dur)}分`);
      const before = [...its.slice(0, i)].reverse().find((x) => x.kind === "spot" && x.place)?.place;
      const after = its.slice(i + 1).find((x) => x.kind === "spot" && x.place)?.place;
      const dist = km(before, after);
      // 間に別の移動がはさまっていないときだけ測ります
      const direct = its[i - 1]?.kind === "spot" && its[i + 1]?.kind === "spot";
      if (direct && dist !== null && dist > 2 && dur > 0 && dist / (dur / 3600000) > MAX_KMH) {
        tooFast.push(`${di + 1}日目「${it.title}」${dist.toFixed(0)}km を ${mins(dur)}分`);
      }
    });
  });
  out.push({ name: "時刻の並び", ok: !broken.length && !overlaps.length,
    detail: broken.length ? `終わりが始まりより前です: ${broken.join("・")}` : overlaps.length ? `重なっています: ${overlaps.join("・")}` : "重なりはありません" });
  out.push({ name: "移動の速さ", ok: !tooFast.length,
    detail: tooFast.length ? `速すぎます（時速 ${MAX_KMH}km を超える）: ${tooFast.join("・")}` : `${legs}回の移動とも、ありえる速さです` });
  if (maxLegMinutes !== null) {
    out.push({ name: "移動の長さ", ok: !tooLong.length,
      detail: tooLong.length ? `上限 ${maxLegMinutes}分を超えています: ${tooLong.join("・")}` : `どの移動も ${maxLegMinutes}分以内です` });
  }
  return out;
}

/** ok を返すあいだの、いちばん大きい値を探します（lo は ok、hi は探す上限）。 */
function largestOk(lo, hi, step, test) {
  if (!test(lo)) return null;
  if (test(hi)) return hi;
  let a = lo;
  let b = hi;
  while (b - a > step) {
    const m = Math.round((a + b) / 2 / step) * step;
    if (m <= a || m >= b) break;
    if (test(m)) a = m; else b = m;
  }
  return a;
}

/**
 * どこまで遅れても成り立つか（ほかの条件はそのまま）。
 * @returns {{late: number|null, delay: number|null}} late は分、delay は割合。null は、遅れなしでも成り立たない
 */
export function slack(itinerary, request, opts = {}) {
  const base = { ...opts, random: null };
  const late = largestOk(opts.late ?? 0, 240, 1, (v) => simulateOnce(itinerary, request, { ...base, late: v }).ok);
  const delay = largestOk(opts.delay ?? 0, 2, 0.01, (v) => simulateOnce(itinerary, request, { ...base, delay: v }).ok);
  return { late, delay: delay === null ? null : Math.round(delay * 100) / 100 };
}

/**
 * 何度もたどって、うまくいく割合を出します（移動と立ち寄りの長さを毎回ばらつかせる）。
 * @returns {{runs: number, okRate: number, returnP50: Date|null, returnP90: Date|null, trouble: {title: string, kind: string, rate: number}[]}}
 */
export function simulateMany(itinerary, request, opts = {}) {
  const runs = Math.max(1, Math.floor(opts.runs ?? 200));
  const random = prng(opts.seed ?? 1);
  let ok = 0;
  const returns = [];
  const count = new Map();
  for (let i = 0; i < runs; i++) {
    const r = simulateOnce(itinerary, request, { ...opts, random });
    if (r.ok) ok++;
    if (r.returnAt) returns.push(r.returnAt.getTime());
    for (const p of r.problems) {
      const k = `${p.kind}\u0000${p.title}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  returns.sort((a, b) => a - b);
  const q = (p) => (returns.length ? new Date(returns[Math.min(returns.length - 1, Math.floor(p * returns.length))]) : null);
  const trouble = [...count].map(([k, n]) => { const [kind, title] = k.split("\u0000"); return { kind, title, rate: n / runs }; })
    .sort((a, b) => b.rate - a.rate || a.title.localeCompare(b.title, "ja"));
  return { runs, okRate: ok / runs, returnP50: q(0.5), returnP90: q(0.9), trouble };
}

const KIND_J = { closed: "休み", missed: "入れない", short: "短い", late_return: "帰りが遅い" };

/** 条件を1行にします。 */
export function describeConditions(o) {
  const parts = [];
  if (o.delay) parts.push(`移動 ${o.delay > 0 ? "+" : ""}${Math.round(o.delay * 100)}%`);
  if (o.late) parts.push(`出発 ${o.late}分遅れ`);
  if (o.dwell && o.dwell !== 1) parts.push(`立ち寄り ×${o.dwell}`);
  if (o.closed?.size ?? o.closed?.length) parts.push(`休み: ${[...o.closed].join("・")}`);
  if (o.shiftDays) parts.push(`${o.shiftDays > 0 ? "+" : ""}${o.shiftDays}日ずらす`);
  return parts.length ? parts.join("・") : "予定どおり（遅れなし）";
}

/** 人が読む形。 */
export function simulationText({ title, file, conditions, run, checks, slack: sl, many }) {
  const out = [`${file}: ${title}（模擬実行）`, `条件: ${conditions}`, ""];
  for (const d of run.days) {
    out.push(`${d.n}日目${d.date ? `（${dateJ(d.date)}）` : ""}`);
    for (const r of d.rows) {
      const mark = r.status === "ok" ? " " : "✗";
      const late = r.lateMin > 0 ? `（予定より ${r.lateMin}分遅れ）` : "";
      const wait = r.waitMin ? `（開くまで ${r.waitMin}分待つ）` : "";
      const est = r.kind === "spot" && r.estimated ? "［目安の営業時間］" : "";
      const span = r.status === "closed" || r.status === "missed" ? hm(r.start) : `${hm(r.start)}〜${hm(r.end)}`;
      out.push(`  ${mark} ${span} ${r.title}${wait}${late}${r.note ? ` — ${r.note}` : ""}${r.status === "ok" ? "" : est}`);
    }
    out.push("");
  }
  for (const c of checks) out.push(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  if (run.returnAt) {
    out.push(`${run.overMin > 0 ? "✗" : "✓"} 帰り: ${hm(run.returnAt, run.deadline)}（${hm(run.deadline)} まで。${run.overMin > 0 ? `${run.overMin}分 過ぎます` : `余り ${-run.overMin}分`}）`);
  }
  const spotProblems = run.problems.filter((p) => p.kind !== "late_return");
  out.push(`${spotProblems.length ? "✗" : "✓"} 立ち寄り: ${spotProblems.length ? spotProblems.map((p) => `「${p.title}」${KIND_J[p.kind]}`).join("・") : "すべて入れます"}`);
  out.push("");
  if (sl) {
    out.push(sl.late === null || sl.delay === null ? "余裕: この条件では、もう成り立っていません"
      : `余裕: 出発は ${sl.late >= 240 ? "4時間以上" : `${sl.late}分`} の遅れまで、移動は ${sl.delay >= 2 ? "+200% 以上" : `+${Math.round(sl.delay * 100)}%`} まで成り立ちます（片方だけ変えたとき）`);
  }
  if (many) {
    out.push(`${many.runs}回たどった結果: ${Math.round(many.okRate * 100)}% が成り立ちました`
      + (many.returnP50 ? `（帰りは ふつう ${hm(many.returnP50, run.deadline)}、遅いとき ${hm(many.returnP90, run.deadline)}）` : ""));
    for (const t of many.trouble.slice(0, 5)) out.push(`  ${Math.round(t.rate * 100)}% 「${t.title}」${KIND_J[t.kind]}`);
  }
  const bad = !run.ok || checks.some((c) => !c.ok);
  out.push(bad ? "結果: この条件では成り立ちません" : "結果: 成り立ちます");
  return out.join("\n") + "\n";
}

/** 機械が読む形（時刻は ISO 8601）。 */
export function simulationJson({ title, file, options, run, checks, slack: sl, many }) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return JSON.stringify({
    version: 1, file, title,
    conditions: { delay: options.delay, lateMinutes: options.late, dwell: options.dwell, closed: [...(options.closed ?? [])], shiftDays: options.shiftDays ?? 0 },
    ok: run.ok && checks.every((c) => c.ok),
    returnAt: iso(run.returnAt), deadline: iso(run.deadline), overMinutes: Math.max(0, run.overMin),
    problems: run.problems.map((p) => ({ kind: p.kind, day: p.day, title: p.title, spotId: p.spotId ?? null, at: iso(p.at), estimatedHours: !!p.estimated, message: p.message })),
    checks,
    slack: sl ? { lateMinutes: sl.late, delay: sl.delay } : null,
    monteCarlo: many ? { runs: many.runs, okRate: many.okRate, returnP50: iso(many.returnP50), returnP90: iso(many.returnP90), trouble: many.trouble } : null,
    days: run.days.map((d) => ({ n: d.n, date: iso(d.date), items: d.rows.map((r) => ({
      kind: r.kind, title: r.title, status: r.status, start: iso(r.start), end: iso(r.end),
      plannedStart: iso(r.plannedStart), plannedEnd: iso(r.plannedEnd), lateMinutes: r.lateMin, waitMinutes: r.waitMin ?? 0, note: r.note || null,
    })) })),
  }, null, 2) + "\n";
}
