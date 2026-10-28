// Journey as Code: 旅程を YAML のファイルに書いて、組む・確かめる・比べる・文にする。
//
//     ./tabisaki build examples/trips/hakone.yaml
//     ./tabisaki test examples/trips/hakone.yaml
//     ./tabisaki diff plan-a.yaml plan-b.yaml
//     ./tabisaki narrate examples/trips/hakone.yaml --style=diary
//
// 旅程を組むのは packages/core（Web 版と同じエンジン）です。ここは、ファイルを読んで
// 条件にし、組んだ旅程が条件を守っているかを確かめるところを受け持ちます。
// 書きかたは docs/journey-as-code.md にあります。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseYaml, YamlError } from "./yaml.mjs";
import { validate, withDefaults, SCHEMA_VERSION, STYLES } from "./schema.mjs";

export { parseYaml, stringifyYaml, YamlError } from "./yaml.mjs";
export { validate, withDefaults, fieldOrder, FIELDS, SCHEMA_VERSION, STYLES, FORMATS } from "./schema.mjs";

/** 旅程ファイルのまちがい。problems に {path, message, line} が並びます。 */
export class JourneyError extends Error {
  constructor(file, problems) {
    super(problems.map((p) => `${file}${p.line ? `:${p.line}` : ""}: ${p.path ? `${p.path}: ` : ""}${p.message}`).join("\n"));
    this.name = "JourneyError";
    this.file = file;
    this.problems = problems;
    this.exitCode = 2;
  }
}

/**
 * 項目の場所（"constraints.budget_yen"）が、ファイルの何行目かを探します。
 * 見つからなければ null（書いていない項目のとき）。
 */
export function lineOf(text, where) {
  const lines = String(text).split(/\r?\n/);
  const keys = where.replace(/\[\d+\]/g, "").split(".").filter(Boolean);
  let from = 0;
  let found = null;
  for (const k of keys) {
    const re = new RegExp(`^\\s*(?:-\\s+)?["']?${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`);
    const i = lines.findIndex((l, j) => j >= from && re.test(l));
    if (i < 0) return found;
    found = i + 1;
    from = i + 1;
  }
  return found;
}

/** 文字列を読んで確かめます。まちがいがあれば JourneyError。 */
export function parseJourney(text, file = "trip.yaml") {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    if (e instanceof YamlError) throw new JourneyError(file, [{ path: "", message: e.reason, line: e.line }]);
    throw e;
  }
  const problems = validate(doc).map((p) => ({ ...p, line: lineOf(text, p.path) }));
  if (problems.length) throw new JourneyError(file, problems);
  return { doc, def: withDefaults(doc) };
}

/** ファイルを読んで確かめます。 */
export async function loadJourney(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    throw new JourneyError(file, [{ path: "", message: e.code === "ENOENT" ? "ファイルがありません" : `読めません（${e.code ?? e.message}）` }]);
  }
  return { ...parseJourney(text, file), text, file, dir: path.dirname(path.resolve(file)) };
}

// ---- スポットの名前を、収録のスポットに当てる ----

const norm = (s) => String(s).replace(/[\s　・･]/g, "").normalize("NFKC");

/**
 * 名前から収録のスポットを探します。同じ名前が複数あれば、よく知られた方を選びます。
 * @returns {{spot: object|null, others: number, near: string[]}}
 */
export function findSpot(kb, name) {
  const all = [...kb.spotsById.values()];
  const q = norm(name);
  const byFame = (a, b) => (b.fame_score ?? 0) - (a.fame_score ?? 0) || String(a.id).localeCompare(String(b.id));
  let hits = all.filter((s) => s.name === name);
  if (!hits.length) hits = all.filter((s) => norm(s.name) === q);
  if (hits.length) {
    hits.sort(byFame);
    return { spot: hits[0], others: hits.length - 1, near: [] };
  }
  const near = all.filter((s) => norm(s.name).includes(q) || (q.length >= 3 && q.includes(norm(s.name)) && norm(s.name).length >= 3))
    .sort(byFame).slice(0, 3).map((s) => `${s.name}（${s.region ?? s.prefecture ?? ""}）`);
  return { spot: null, others: 0, near };
}

function resolveSpots(kb, def, file, text) {
  const problems = [];
  const notes = [];
  const pick = (list, key) => list.map((name, i) => {
    const r = findSpot(kb, name);
    if (!r.spot) {
      problems.push({
        path: `constraints.${key}[${i}]`, line: lineOf(text ?? "", `constraints.${key}`),
        message: `「${name}」が収録にありません${r.near.length ? `（近い名前: ${r.near.join("・")}）` : ""}`,
      });
      return null;
    }
    if (r.others) notes.push(`「${name}」は収録に${r.others + 1}か所あります。よく知られた ${r.spot.region ?? r.spot.prefecture ?? ""} の方を使います`);
    return { name, spot: r.spot };
  });
  const must = pick(def.constraints.must_visit, "must_visit");
  const avoid = pick(def.constraints.avoid, "avoid");
  if (problems.length) throw new JourneyError(file, problems);
  return { must, avoid, notes };
}

// ---- 組む ----

/**
 * 旅程を組みます。core は packages/core の createCore() で作ったもの。
 * @returns {Promise<{def, result, spots, notes}>} result は core.plan の返す形
 */
export async function buildJourney(core, journey) {
  const { def } = journey;
  const spots = resolveSpots(core.kb, def, journey.file ?? "trip.yaml", journey.text);
  const result = await core.plan({
    wish: def.wish, from: def.from, days: def.days, date: def.date ?? undefined,
    start: def.start, back: def.back, transport: def.transport,
    must: { spotIds: spots.must.map((m) => m.spot.id), avoidSpotIds: spots.avoid.map((m) => m.spot.id) },
  });
  result.itinerary.title = def.title;
  return { def, result, spots, notes: spots.notes };
}

// ---- 確かめる（tabisaki test） ----

const jstHour = (d) => { const t = new Date(new Date(d).getTime() + 9 * 3600000); return t.getUTCHours() + t.getUTCMinutes() / 60; };
const hmOf = (d) => { const t = new Date(new Date(d).getTime() + 9 * 3600000); return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`; };
const minutes = (it) => Math.round((new Date(it.end) - new Date(it.start)) / 60000);
const yen = (n) => `${Math.round(n).toLocaleString("ja-JP")}円`;

/**
 * 組んだ旅程が、ファイルに書いた条件を守っているかを確かめます。
 * @returns {{name: string, ok: boolean, skipped?: boolean, detail: string}[]}
 */
export function checkJourney({ def, result, spots }) {
  const { itinerary, request } = result;
  const c = def.constraints;
  const days = itinerary.days ?? [];
  const items = days.flatMap((d, i) => (d.items ?? []).map((it) => ({ ...it, day: i + 1 })));
  const spotItems = items.filter((it) => it.kind === "spot");
  const visited = new Set(spotItems.map((it) => it.spotId ?? it.place?.id));
  const out = [];
  const add = (name, ok, detail, skipped = false) => out.push({ name, ok, detail, skipped });

  add("日数", days.length === def.days, `${days.length}日（書いたのは ${def.days}日）`);

  const last = items.at(-1);
  const backOk = last ? new Date(last.end) <= new Date(request.arriveBy) : false;
  add("帰りの時刻", backOk, last ? `${hmOf(last.end)} に着く（${def.back} まで）` : "予定がありません");

  let overlap = null;
  for (const d of days) {
    const its = d.items ?? [];
    for (let i = 1; i < its.length; i++) {
      if (new Date(its[i].start) < new Date(its[i - 1].end) - 60000) { overlap ??= `${its[i - 1].title} と ${its[i].title}`; }
    }
  }
  add("時刻の重なり", !overlap, overlap ? `${overlap} が重なっています` : "重なりはありません");

  if (spots.must.length) {
    const missing = spots.must.filter((m) => !visited.has(m.spot.id)).map((m) => m.name);
    add("必ず立ち寄る", !missing.length, missing.length ? `入っていません: ${missing.join("・")}` : spots.must.map((m) => m.name).join("・"));
  } else add("必ず立ち寄る", true, "指定なし", true);

  if (spots.avoid.length) {
    const hit = spots.avoid.filter((m) => visited.has(m.spot.id)).map((m) => m.name);
    add("使わない", !hit.length, hit.length ? `入っています: ${hit.join("・")}` : `${spots.avoid.length}か所とも入っていません`);
  } else add("使わない", true, "指定なし", true);

  if (c.budget_yen !== null) {
    const cost = itinerary.totalCostYen;
    add("費用", Number.isFinite(cost) && cost <= c.budget_yen, Number.isFinite(cost) ? `${yen(cost)}（上限 ${yen(c.budget_yen)}）` : "費用を出せませんでした");
  } else add("費用", true, Number.isFinite(itinerary.totalCostYen) ? `${yen(itinerary.totalCostYen)}（上限なし）` : "上限なし", true);

  if (c.max_leg_minutes !== null) {
    const legs = items.filter((it) => it.kind === "transit");
    const worst = legs.reduce((a, b) => (!a || minutes(b) > minutes(a) ? b : a), null);
    const over = legs.filter((it) => minutes(it) > c.max_leg_minutes);
    add("移動の長さ", !over.length, worst
      ? `${over.length ? `${over.length}回が上限を超えています。` : ""}いちばん長いのは ${worst.day}日目「${worst.title}」${minutes(worst)}分（上限 ${c.max_leg_minutes}分）`
      : "移動がありません");
  } else add("移動の長さ", true, "上限なし", true);

  if (c.max_spots_per_day !== null) {
    const per = days.map((d) => (d.items ?? []).filter((it) => it.kind === "spot").length);
    const over = per.map((n, i) => ({ n, day: i + 1 })).filter((x) => x.n > c.max_spots_per_day);
    add("1日の立ち寄り", !over.length, over.length ? over.map((x) => `${x.day}日目 ${x.n}か所`).join("・") + `（上限 ${c.max_spots_per_day}）` : `${per.join("・")}か所（上限 ${c.max_spots_per_day}）`);
  } else add("1日の立ち寄り", true, "上限なし", true);

  if (c.respect_hours) {
    const bad = [];
    for (const it of spotItems) {
      const p = it.place ?? {};
      if (Number.isFinite(p.open) && Number.isFinite(p.close) && p.close > p.open) {
        const s = jstHour(it.start);
        let e = jstHour(it.end);
        if (e < s) e += 24;
        if (s < p.open - 1e-9 || e > p.close + 1e-9) bad.push(`${it.day}日目「${it.title}」${hmOf(it.start)}〜${hmOf(it.end)}（営業 ${it.hoursText || `${p.open}〜${p.close}時`}）`);
      }
      if (it.lastEntry && new Date(it.start) > new Date(it.lastEntry)) bad.push(`${it.day}日目「${it.title}」最終入場 ${hmOf(it.lastEntry)} を過ぎて着きます`);
    }
    for (const w of itinerary.hoursWarnings ?? []) bad.push(typeof w === "string" ? w : w?.message ?? String(w));
    const estimated = spotItems.filter((it) => it.estimated).length;
    add("営業時間", !bad.length, bad.length ? bad.join(" / ")
      : `${spotItems.length}か所とも営業時間の内です${estimated ? `（うち ${estimated}か所は分類ごとの目安）` : ""}`);
  } else add("営業時間", true, "確かめない（respect_hours: false）", true);

  return out;
}

// ---- 比べる（tabisaki diff） ----

/**
 * 2つの旅程（toJson の形）を比べます。
 * @returns {{same: boolean, lines: string[]}}
 */
export function diffJourneys(a, b, { labelA = "a", labelB = "b" } = {}) {
  const lines = [`--- ${labelA}（${a.title ?? "旅程"}）`, `+++ ${labelB}（${b.title ?? "旅程"}）`];
  const keyed = (j) => {
    const m = new Map();
    (j.days ?? []).forEach((d) => (d.items ?? []).forEach((it) => {
      if (it.kind !== "spot" && it.kind !== "lodging") return;
      const k = `${it.kind}:${it.title}`;
      if (!m.has(k)) m.set(k, { ...it, day: d.n });
    }));
    return m;
  };
  const A = keyed(a);
  const B = keyed(b);
  let changes = 0;
  const dayCount = Math.max(a.days?.length ?? 0, b.days?.length ?? 0);
  const mark = (it) => (it.kind === "lodging" ? "宿 " : "");
  for (let n = 1; n <= dayCount; n++) {
    const day = [];
    for (const [k, it] of A) {
      if (it.day !== n) continue;
      const other = B.get(k);
      if (!other) day.push(`  - ${hmOf(it.start)} ${mark(it)}${it.title}`);
      else if (other.day !== n) day.push(`  ~ ${mark(it)}${it.title}: ${n}日目 → ${other.day}日目`);
      else if (hmOf(other.start) !== hmOf(it.start) || hmOf(other.end) !== hmOf(it.end)) {
        day.push(`  ~ ${mark(it)}${it.title}: ${hmOf(it.start)}〜${hmOf(it.end)} → ${hmOf(other.start)}〜${hmOf(other.end)}`);
      }
    }
    for (const [k, it] of B) if (it.day === n && !A.has(k)) day.push(`  + ${hmOf(it.start)} ${mark(it)}${it.title}`);
    if (day.length) { lines.push(`${n}日目`, ...day); changes += day.length; }
  }
  const num = (j, f) => f(j);
  const summary = [
    ["日数", (j) => j.days?.length ?? 0, (v) => `${v}日`],
    ["立ち寄り", (j) => (j.days ?? []).reduce((s, d) => s + (d.items ?? []).filter((it) => it.kind === "spot").length, 0), (v) => `${v}か所`],
    ["移動", (j) => (j.days ?? []).reduce((s, d) => s + (d.items ?? []).filter((it) => it.kind === "transit").reduce((t, it) => t + minutes(it), 0), 0), (v) => `${v}分`],
    ["費用", (j) => j.totalCostYen ?? null, (v) => (v === null ? "不明" : yen(v))],
  ];
  for (const [name, f, show] of summary) {
    const x = num(a, f);
    const y = num(b, f);
    if (x !== y) {
      const delta = Number.isFinite(x) && Number.isFinite(y) ? `（${y - x > 0 ? "+" : ""}${name === "費用" ? yen(y - x) : y - x}）` : "";
      lines.push(`${name}: ${show(x)} → ${show(y)}${delta}`);
      changes++;
    }
  }
  if (!changes) lines.push("違いはありません");
  return { same: changes === 0, lines };
}

// ---- 文にする（tabisaki narrate） ----

const KIGO = ["", "初春", "梅の香", "春霞", "桜", "若葉", "梅雨晴れ", "夏草", "蝉しぐれ", "秋風", "秋晴れ", "紅葉", "冬木立"];
const dateJ = (d) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short" }).format(new Date(d));
const monthOf = (d) => new Date(new Date(d).getTime() + 9 * 3600000).getUTCMonth() + 1;

/**
 * 組んだ旅程を、文にします。AI は使わず、ひな形で書きます（手元の AI で書くのは #352 の後）。
 * @param {"blog"|"diary"|"guide"|"haiku"} style
 */
export function narrate({ def, result }, style = "blog") {
  if (!STYLES.includes(style)) throw Object.assign(new Error(`文体は ${STYLES.join(" / ")} のどれかです`), { exitCode: 2 });
  const { itinerary, request } = result;
  const days = itinerary.days ?? [];
  const spotsOf = (d) => (d.items ?? []).filter((it) => it.kind === "spot");
  const stayOf = (d) => (d.items ?? []).find((it) => it.kind === "lodging");
  const desc = (it) => String(it.place?.description ?? "").trim();
  const out = [];

  if (style === "blog") {
    out.push(`# ${def.title}`, "");
    out.push(`${request.origin.name}から${def.days > 1 ? `${def.days}日間` : "日帰り"}で、「${def.wish}」旅に出かけました。`, "");
    days.forEach((d, i) => {
      const s = spotsOf(d);
      out.push(`## ${i + 1}日目（${dateJ(d.items?.[0]?.start ?? request.departAt)}）`, "");
      if (!s.length) { out.push("この日は移動が中心です。", ""); return; }
      out.push(`${hmOf(d.items[0].start)}に${i === 0 ? request.origin.name : "宿"}を出て、まずは「${s[0].title}」へ。${desc(s[0])}`.trim(), "");
      for (const it of s.slice(1, -1)) out.push(`続いて「${it.title}」。${desc(it)}`.trim(), "");
      if (s.length > 1) out.push(`最後に「${s.at(-1).title}」に立ち寄りました。${desc(s.at(-1))}`.trim(), "");
      const st = stayOf(d);
      if (st) out.push(/宿泊$/.test(st.title) ? `夜は${st.title}します。` : `夜は「${st.title}」に泊まります。`, "");
    });
    if (Number.isFinite(itinerary.totalCostYen)) out.push(`費用はおよそ${yen(itinerary.totalCostYen)}でした。`, "");
  } else if (style === "diary") {
    days.forEach((d, i) => {
      const s = spotsOf(d);
      out.push(`${dateJ(d.items?.[0]?.start ?? request.departAt)}`, "");
      const body = [];
      body.push(`${hmOf(d.items?.[0]?.start ?? request.departAt)}、${i === 0 ? request.origin.name : "宿"}を出た。`);
      for (const it of s) body.push(`${hmOf(it.start)}、${it.title}。`);
      const st = stayOf(d);
      body.push(st ? `今夜は${st.title}。` : i === days.length - 1 ? `${hmOf(d.items.at(-1).end)}、${request.origin.name}に帰り着いた。` : "");
      out.push(body.filter(Boolean).join(""), "");
    });
  } else if (style === "guide") {
    out.push(`# ${def.title} 案内`, "", `- 出発: ${request.origin.name} ${hmOf(request.departAt)}`, `- 日数: ${def.days}日`, "");
    days.forEach((d, i) => {
      out.push(`## ${i + 1}日目`, "");
      for (const it of spotsOf(d)) {
        out.push(`### ${it.title}`, "");
        out.push(`- 時間: ${hmOf(it.start)}〜${hmOf(it.end)}（${minutes(it)}分）`);
        if (it.hoursText) out.push(`- 営業: ${it.hoursText}${it.estimated ? "（目安）" : ""}`);
        if (it.place?.category) out.push(`- 種類: ${it.place.category}`);
        if (desc(it)) out.push(`- ${desc(it)}`);
        if (it.backup?.text) out.push(`- ${it.backup.text}`);
        out.push("");
      }
    });
    out.push("営業時間や料金は変わることがあります。出かける前に確かめてください。", "");
  } else {
    const kigo = KIGO[monthOf(request.departAt)];
    days.forEach((d, i) => {
      const s = spotsOf(d);
      if (!s.length) return;
      // 名前の短いスポットを詠みます（長い名前は句になりません）
      const short = [...s].sort((x, y) => x.title.length - y.title.length)[0].title;
      out.push(`${i + 1}日目`, `${kigo}や`, `${short}の`, i === days.length - 1 ? "帰り道" : "旅の宿", "");
    });
    out.push("（音の数は数えていません。俳句ふうの書きかたです）", "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export const VERSION = SCHEMA_VERSION;
