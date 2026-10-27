// 旅程の成立率ベンチマーク（Issue #374）。
//
// 決まった頼みごとの組（bench/requests.json）と、シードを固定した
// ランダムな頼みごとで旅程を組み、1本ずつ「成り立っているか」を調べます。
// 通信はしません（AI・経路・天気は使わず、距離からの目安で組みます）。
// 同じ kb/ と同じ js/ なら、何度走らせても同じ結果になります。
//
// 調べること（1本の旅程に1つでもあれば「不成立」）
//   ・crash      … 組めなかった（例外。「この日程では往復できない」と断ったものは
//                  unreachable に分けます。頼みごとの方が無理なので、正しい答えです）
//   ・hours      … 営業時間の外・最終入場の後・休みの日に立ち寄る
//                  （実データの時刻。分類ごとの目安は hoursEstimated に分けます）
//   ・travel     … 帰りの時刻を過ぎる・出発より前に動く・ありえない速さの移動・
//                  1本で12時間を超える移動
//   ・duplicate  … 同じ場所に2回（同じ id、または 100m 以内）
//   ・empty      … 立ち寄りが1つも無い（移動だけの旅程）
//   ・constraint … 予定が重なる・時刻が逆・日数が頼んだ数と違う
//
//     node tools/plan_bench.mjs                 # 結果を出す
//     node tools/plan_bench.mjs --md            # Markdown（CI のまとめ欄に貼る用）
//     node tools/plan_bench.mjs --check         # 基準（bench/baseline.json）より悪ければ終了コード 1
//     node tools/plan_bench.mjs --write-baseline  # 今の結果を基準にする
//     node tools/plan_bench.mjs --random 40 --seed 7   # ランダムの本数とシード
//     node tools/plan_bench.mjs --only fixed-03 # 1件だけ（失敗ケースの再現）
//     node tools/plan_bench.mjs --out bench-out # 失敗ケースを1件ずつ JSON で保存
//
// 判定の関数（auditItinerary など）は tests/plan-bench.test.js から直接呼びます。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = path.join(ROOT, "bench");

export const KINDS = ["crash", "unreachable", "empty", "hours", "hoursEstimated", "travel", "duplicate", "constraint"];
// 不成立に数える種類。目安の営業時間（hoursEstimated）は、実際の時刻が
// 分からないので数だけ出し、成立・不成立には入れません。「往復できない」
// （unreachable。札幌から倉敷へ日帰り、など）と断るのは正しい答えなので、
// これも数だけ出します。
export const HARD_KINDS = ["crash", "empty", "hours", "travel", "duplicate", "constraint"];

// 新幹線より速い地上の移動は、時間の見積もりの誤りです（飛行機は除きます）。
const MAX_GROUND_KMH = 320;
const MAX_AIR_KMH = 900;
const SAME_PLACE_M = 100;
const MAX_LEG_HOURS = 12;

const t = (d) => new Date(d).getTime();
const hm = (d) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d));

function km(a, b) {
  const R = 6371;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const isAir = (it) => /飛行機|空港|✈|flight|plane/i.test(`${it.vehicle ?? ""} ${it.title ?? ""} ${it.detail ?? ""}`);

/**
 * 1本の旅程を調べて、見つかった違反を返します。
 * @param {object} itinerary planTrip の結果
 * @param {{departAt: Date, arriveBy: Date, days: number}} request
 * @param {{hoursFor: Function}} helpers js/hours.js の hoursFor（営業時間の判定）
 * @returns {{kind: string, msg: string}[]}
 */
export function auditItinerary(itinerary, request, { hoursFor }) {
  const out = [];
  const flag = (kind, msg) => out.push({ kind, msg });
  const days = itinerary?.days ?? [];
  const all = days.flatMap((d, di) => (d.items ?? []).map((it) => ({ ...it, di })));

  if (!all.some((i) => i.kind === "spot")) flag("empty", "立ち寄りが1つもありません");
  if (request.days && days.length !== request.days) {
    flag("constraint", `日数が ${days.length} 日（頼んだのは ${request.days} 日）`);
  }

  for (const it of all) {
    const s = t(it.start);
    const e = t(it.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) {
      flag("constraint", `${it.di + 1}日目 ${it.title}: 時刻がありません`);
      continue;
    }
    if (e < s) flag("constraint", `${it.di + 1}日目 ${it.title}: 終わりが始まりより前`);
    if (request.departAt && s < t(request.departAt) - 60000) {
      flag("travel", `${it.di + 1}日目 ${hm(it.start)} ${it.title}: 出発 ${hm(request.departAt)} より前`);
    }
    if (request.arriveBy && e > t(request.arriveBy) + 60000) {
      flag("travel", `${it.di + 1}日目 ${hm(it.end)} ${it.title}: 帰りの時刻 ${hm(request.arriveBy)} を過ぎる`);
    }

    if (it.kind === "transit") {
      const min = (e - s) / 60000;
      const dist = Number.isFinite(it.km) ? it.km : 0;
      const cap = isAir(it) ? MAX_AIR_KMH : MAX_GROUND_KMH;
      if (dist > 0.5 && min > 0 && dist / (min / 60) > cap) {
        flag("travel", `${it.title}: ${dist.toFixed(1)}km を ${Math.round(min)} 分（時速 ${Math.round(dist / (min / 60))}km）`);
      }
      if (dist > 1 && min <= 0) flag("travel", `${it.title}: ${dist.toFixed(1)}km を 0 分`);
      if (min > MAX_LEG_HOURS * 60) flag("travel", `${it.title}: 1本で ${Math.round(min / 60)} 時間の移動`);
    }

    if (it.kind === "spot" && it.place) {
      const h = hoursFor(it.place, new Date(it.start));
      const kind = h.estimated ? "hoursEstimated" : "hours";
      if (h.closed) {
        flag(kind, `${it.di + 1}日目 ${it.title}: ${h.reason}`);
      } else if (!h.alwaysOpen) {
        if (s < t(h.open) - 60000) flag(kind, `${it.di + 1}日目 ${hm(it.start)} ${it.title}: 開く ${hm(h.open)} より前`);
        else if (h.lastEntry && s > t(h.lastEntry) + 60000) flag(kind, `${it.di + 1}日目 ${hm(it.start)} ${it.title}: 最終入場 ${hm(h.lastEntry)} の後`);
        if (e > t(h.close) + 60000) flag(kind, `${it.di + 1}日目 ${hm(it.end)} ${it.title}: 閉まる ${hm(h.close)} の後まで`);
      }
    }
  }

  // 予定の重なり（日ごと、始まりの順に並べて隣どうし）
  for (const [di, d] of days.entries()) {
    const items = [...(d.items ?? [])].sort((a, b) => t(a.start) - t(b.start));
    for (let i = 0; i + 1 < items.length; i++) {
      if (t(items[i + 1].start) < t(items[i].end) - 60000) {
        flag("constraint", `${di + 1}日目 ${items[i].title}（〜${hm(items[i].end)}）と ${items[i + 1].title}（${hm(items[i + 1].start)}〜）が重なる`);
      }
    }
  }

  // 同じ場所に2回
  const spots = all.filter((i) => i.kind === "spot" && i.place);
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      const a = spots[i].place;
      const b = spots[j].place;
      if (a.id && a.id === b.id) flag("duplicate", `${a.name} に2回（${spots[i].di + 1}日目・${spots[j].di + 1}日目）`);
      else if (Number.isFinite(a.lat) && Number.isFinite(b.lat) && km(a, b) * 1000 < SAME_PLACE_M) {
        flag("duplicate", `${a.name} と ${b.name} が ${Math.round(km(a, b) * 1000)}m（同じ場所）`);
      }
    }
  }
  return out;
}

// --- 頼みごとの組 -------------------------------------------------------------

/** シードから同じ並びの乱数を出す（mulberry32）。 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const PLACES = ["京都", "奈良", "金沢", "箱根", "日光", "鎌倉", "札幌", "函館", "仙台", "松本",
  "伊勢", "広島", "松山", "高知", "長崎", "熊本", "鹿児島", "那覇", "富山", "長野", "新潟", "福岡",
  "別府", "出雲", "高山", "倉敷", "姫路", "横浜", "名古屋", "大阪"];
const WANTS = ["寺と庭園を見たい", "温泉でのんびり", "海を見たい", "城と城下町", "美術館めぐり",
  "山歩きと滝", "食べ歩き", "子どもと水族館", "歴史を学びたい", "景色のいい展望台"];
const ORIGINS = ["東京駅", "新大阪駅", "名古屋駅", "博多駅", "仙台駅", "札幌駅", "広島駅"];
const TRANSPORTS = ["any", "any", "any", "transit", "car"];
const STARTS = ["06:30", "07:00", "08:00", "09:00", "10:00"];
const BACKS = ["18:00", "19:00", "20:00", "21:00"];

/**
 * シードを固定したランダムな頼みごと。同じシードなら同じ並びです。
 * @param {number} seed
 * @param {number} n
 */
export function randomRequests(seed, n) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const base = Date.UTC(2026, 10, 2); // 2026-11-02（月）から 8 週のどこか
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = new Date(base + Math.floor(r() * 56) * 86400000).toISOString().slice(0, 10);
    out.push({
      id: `random-${seed}-${String(i + 1).padStart(2, "0")}`,
      wish: `${pick(PLACES)}で${pick(WANTS)}`,
      from: pick(ORIGINS),
      days: 1 + Math.floor(r() * 4),
      date,
      start: pick(STARTS),
      back: pick(BACKS),
      transport: pick(TRANSPORTS),
    });
  }
  return out;
}

export function loadFixedRequests(file = path.join(BENCH, "requests.json")) {
  return JSON.parse(readFileSync(file, "utf8")).requests;
}

// --- 集計と比較 ---------------------------------------------------------------

/**
 * 1件ずつの結果から、指標を出します。
 * @param {{id: string, violations: {kind: string}[]}[]} results
 */
export function summarize(results) {
  const total = results.length;
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));       // その種類が1つでもあった旅程の数
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));       // 違反の数そのもの
  const failed = [];
  for (const r of results) {
    const kinds = new Set(r.violations.map((v) => v.kind));
    for (const k of kinds) byKind[k]++;
    for (const v of r.violations) counts[v.kind]++;
    if (r.violations.some((v) => HARD_KINDS.includes(v.kind))) failed.push(r.id);
  }
  const rate = (n) => (total ? Math.round((n / total) * 1000) / 1000 : 0);
  return {
    total,
    ok: total - failed.length,
    successRate: rate(total - failed.length),
    rates: Object.fromEntries(KINDS.map((k) => [k, rate(byKind[k])])),
    itineraries: byKind,
    violations: counts,
    failed,
  };
}

export const DEFAULT_TOLERANCE = { successRate: 0.03, itineraries: 1 };

/**
 * 基準と比べて、悪くなったところを返します（空なら合格）。
 * @param {object} baseline bench/baseline.json の suites
 * @param {object} current 今回の suites
 * @param {{successRate: number, itineraries: number}} [tol]
 */
export function compare(baseline, current, tol = DEFAULT_TOLERANCE) {
  const worse = [];
  const better = [];
  for (const [name, cur] of Object.entries(current)) {
    const base = baseline?.[name];
    if (!base) continue;
    if (base.total !== cur.total) {
      worse.push(`${name}: 件数が基準（${base.total}）と違います（${cur.total}）。--write-baseline で基準を作り直してください`);
      continue;
    }
    if (cur.successRate < base.successRate - tol.successRate - 1e-9) {
      worse.push(`${name}: 成立率 ${pct(cur.successRate)}（基準 ${pct(base.successRate)}）`);
    } else if (cur.successRate > base.successRate + 1e-9) {
      better.push(`${name}: 成立率 ${pct(cur.successRate)}（基準 ${pct(base.successRate)}）`);
    }
    for (const k of HARD_KINDS) {
      const b = base.itineraries?.[k] ?? 0;
      const c = cur.itineraries?.[k] ?? 0;
      if (c > b + tol.itineraries) worse.push(`${name}: ${LABEL[k]} が ${c} 本（基準 ${b} 本）`);
      else if (c < b) better.push(`${name}: ${LABEL[k]} が ${c} 本（基準 ${b} 本）`);
    }
    const newly = cur.failed.filter((id) => !base.failed?.includes(id));
    if (newly.length) worse.push(`${name}: 新しく不成立になった頼みごと ${newly.join(", ")}`);
  }
  return { worse, better };
}

export const LABEL = {
  crash: "組めない",
  unreachable: "往復できないと断る（正しい答え）",
  empty: "立ち寄りが無い",
  hours: "営業時間の外（実データ）",
  hoursEstimated: "営業時間の外（目安）",
  travel: "移動時間の超過",
  duplicate: "同じ場所に2回",
  constraint: "その他の制約違反",
};

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

export function toMarkdown(suites, cmp, { limit = 30, results = [] } = {}) {
  const out = ["## 旅程の成立率", ""];
  const names = Object.keys(suites);
  out.push(`| 指標 | ${names.join(" | ")} |`, `| --- | ${names.map(() => "---:").join(" | ")} |`);
  out.push(`| 旅程の数 | ${names.map((n) => suites[n].total).join(" | ")} |`);
  out.push(`| **成立率** | ${names.map((n) => `**${pct(suites[n].successRate)}**`).join(" | ")} |`);
  for (const k of KINDS) {
    out.push(`| ${LABEL[k]} | ${names.map((n) => `${pct(suites[n].rates[k])}（${suites[n].itineraries[k]}本）`).join(" | ")} |`);
  }
  out.push("");
  if (cmp) {
    if (cmp.worse.length) out.push("### 基準より悪くなったところ", "", ...cmp.worse.map((w) => `- ${w}`), "");
    else out.push("基準（`bench/baseline.json`）より悪くなったところはありません。", "");
    if (cmp.better.length) {
      out.push("### 基準より良くなったところ", "", ...cmp.better.map((w) => `- ${w}`), "",
        "良くなったら `node tools/plan_bench.mjs --write-baseline` で基準を上げてください。", "");
    }
  }
  const bad = results.filter((r) => r.violations.some((v) => HARD_KINDS.includes(v.kind)));
  if (bad.length) {
    out.push("### 不成立の旅程", "");
    for (const r of bad.slice(0, limit)) {
      const v = r.violations.filter((x) => HARD_KINDS.includes(x.kind));
      out.push(`- **${r.id}**（${r.request.wish}・${r.request.from}・${r.request.days}日）: ${v.slice(0, 3).map((x) => x.msg).join(" / ")}${v.length > 3 ? ` …ほか ${v.length - 3} 件` : ""}`);
    }
    if (bad.length > limit) out.push(`- …ほか ${bad.length - limit} 本`);
    out.push("");
  }
  return out.join("\n");
}

// --- 走らせる -----------------------------------------------------------------

/**
 * 頼みごとを順に組んで調べます。
 * @param {object[]} requests
 * @param {{core: object, hoursFor: Function}} deps
 */
export async function runRequests(requests, { core, hoursFor }) {
  const results = [];
  for (const req of requests) {
    const { id, ...body } = req;
    let violations;
    let normalized = null;
    let spots = 0;
    try {
      const { request, itinerary } = await core.plan(body);
      normalized = request;
      spots = itinerary.days.flatMap((d) => d.items ?? []).filter((i) => i.kind === "spot").length;
      violations = auditItinerary(itinerary, request, { hoursFor });
    } catch (e) {
      const msg = String(e?.message ?? e);
      const kind = e?.code === "plan_failed" && /往復できません/.test(msg) ? "unreachable" : "crash";
      violations = [{ kind, msg: `${e?.code ?? "error"}: ${msg}` }];
    }
    results.push({ id, request: req, spots, violations, normalized });
  }
  return results;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { createCore } = await import(pathToFileURL(path.join(ROOT, "packages", "core", "index.mjs")).href);
  const { hoursFor } = await import(pathToFileURL(path.join(ROOT, "js", "hours.js")).href);
  const baselineFile = path.join(BENCH, "baseline.json");
  let baseline = null;
  try { baseline = JSON.parse(readFileSync(baselineFile, "utf8")); } catch { /* 基準がまだ無い */ }
  const seed = Number(arg("--seed", baseline?.random?.seed ?? 374));
  const n = Number(arg("--random", baseline?.random?.count ?? 30));
  const only = arg("--only", null);

  const suitesReq = { fixed: loadFixedRequests(), random: randomRequests(seed, n) };
  if (only) {
    for (const k of Object.keys(suitesReq)) suitesReq[k] = suitesReq[k].filter((r) => r.id === only);
  }
  const core = await createCore();
  const started = Date.now();
  const allResults = [];
  const suites = {};
  for (const [name, reqs] of Object.entries(suitesReq)) {
    if (!reqs.length) continue;
    const results = await runRequests(reqs, { core, hoursFor });
    allResults.push(...results);
    suites[name] = summarize(results);
  }
  const elapsed = Date.now() - started;

  const outDir = arg("--out", null);
  if (outDir) {
    const dir = path.resolve(outDir, "failures");
    mkdirSync(dir, { recursive: true });
    for (const r of allResults.filter((x) => x.violations.some((v) => HARD_KINDS.includes(v.kind)))) {
      writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify({
        id: r.id, request: r.request, violations: r.violations,
        reproduce: `node tools/plan_bench.mjs --only ${r.id}${r.id.startsWith("random-") ? ` --seed ${seed} --random ${n}` : ""}`,
      }, null, 2) + "\n");
    }
    writeFileSync(path.resolve(outDir, "results.json"), JSON.stringify({ seed, count: n, suites, results: allResults.map(({ normalized, ...r }) => r) }, null, 2) + "\n");
  }

  if (process.argv.includes("--write-baseline")) {
    if (only) throw new Error("--only と --write-baseline は一緒に使えません");
    writeFileSync(baselineFile, JSON.stringify({
      note: "旅程の成立率の基準。node tools/plan_bench.mjs --write-baseline で作り直します（docs/benchmarks.md）。",
      random: { seed, count: n },
      tolerance: baseline?.tolerance ?? DEFAULT_TOLERANCE,
      suites,
    }, null, 2) + "\n");
    console.log(`基準を書きました: bench/baseline.json`);
  }

  const cmp = baseline && !only ? compare(baseline.suites, suites, baseline.tolerance) : null;
  if (process.argv.includes("--md")) {
    console.log(toMarkdown(suites, cmp, { results: allResults }));
  } else {
    for (const r of allResults) {
      const hard = r.violations.filter((v) => HARD_KINDS.includes(v.kind));
      const soft = r.violations.length - hard.length;
      console.log(`${hard.length ? "✗" : "✓"} ${r.id}  ${r.request.wish}（${r.request.from}・${r.request.days}日）立ち寄り${r.spots}${soft ? `・目安の営業時間の外 ${soft}` : ""}`);
      for (const v of hard) console.log(`    [${v.kind}] ${v.msg}`);
    }
    for (const [name, s] of Object.entries(suites)) {
      console.log(`\n${name}: 成立率 ${pct(s.successRate)}（${s.ok}/${s.total}）`
        + KINDS.map((k) => ` ${k} ${s.itineraries[k]}`).join(""));
    }
    if (cmp) for (const w of cmp.worse) console.log(`悪くなった: ${w}`);
    console.log(`（${(elapsed / 1000).toFixed(1)} 秒）`);
  }
  if (process.argv.includes("--check") && cmp?.worse.length) process.exitCode = 1;
}
