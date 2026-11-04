#!/usr/bin/env node
// 検索の控え（キャッシュ）の効きめを測ります（#438）。
//
//   node tools/cache_bench.mjs                 … 手元だけで試す（外へは行きません）
//   node tools/cache_bench.mjs --n 2000 --distinct 150 --latency 700 --cost 0.005
//   node tools/cache_bench.mjs --url https://<中継>/web/search --n 30
//                                              … 本物の中継に聞いて、X-Cache と時間を数える
//
// 手元の試しは、よく聞かれる語ほど多く出る並び（Zipf 分布）で n 回検索し、
// 外への呼び出し（遅さ latency ミリ秒・1回 cost の費用）を控えで包んだときの
// 当たりの割合・時間（中央値・95%）・減った呼び出しと費用を出します。
// --md を付けると表（Markdown）で出します。

import { createCache, cacheKey } from "../packages/core/src/cache.js";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const n = Number(opt("n", 1000));
const distinct = Number(opt("distinct", 120));
const latency = Number(opt("latency", 700));
const cost = Number(opt("cost", 0.005));
const url = opt("url", "");
const md = args.includes("--md");

/** 決まった種から作る乱数（毎回同じ結果にするため）。 */
function rng(seed = 438) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Zipf（s=1.1）で 0..k-1 を選ぶ。 */
function zipf(k, rand) {
  const w = Array.from({ length: k }, (_, i) => 1 / (i + 1) ** 1.1);
  const total = w.reduce((a, b) => a + b, 0);
  return () => {
    let r = rand() * total;
    for (let i = 0; i < k; i++) { r -= w[i]; if (r <= 0) return i; }
    return k - 1;
  };
}

const AREAS = ["箱根", "京都", "鎌倉", "日光", "金沢", "伊勢", "松本", "上高地", "函館", "別府"];
const TOPICS = ["紅葉 見頃", "営業時間", "混雑", "イベント", "温泉 日帰り", "ロープウェイ 運行", "雪", "ランチ"];
const queryOf = (i) => `${AREAS[i % AREAS.length]} ${TOPICS[Math.floor(i / AREAS.length) % TOPICS.length]}${i >= 80 ? ` ${i}` : ""}`;

function print(rows) {
  if (md) {
    console.log("| 項目 | 値 |\n|---|---|");
    for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);
  } else {
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) console.log(`${k.padEnd(w, "　")}  ${v}`);
  }
}

async function simulate() {
  let clock = 0;
  const cache = createCache({ costPerCall: cost, timer: () => clock });
  const pick = zipf(distinct, rng());
  // 遅さは latency を中心に ±30% ばらつかせます。
  const jitter = rng(7);
  for (let i = 0; i < n; i++) {
    const q = queryOf(pick());
    await cache.fetch(cacheKey(q), async () => {
      clock += latency * (0.7 + 0.6 * jitter());
      return [{ title: q, url: "https://example.jp/", snippet: "" }];
    });
    clock += 0.2; // 控えを見る手間（メモリなのでほぼ 0）
  }
  const s = cache.stats();
  const before = n * latency;
  const after = s.latency.miss.avgMs * s.misses + s.latency.hit.avgMs * s.hits;
  print([
    ["検索の回数", `${n} 回（違う語 ${distinct} 種）`],
    ["外へ聞いた回数", `${s.calls} 回`],
    ["当たりの割合", `${(s.hitRate * 100).toFixed(1)}%`],
    ["時間（当たり）", `中央値 ${s.latency.hit.p50Ms} ms / 95% ${s.latency.hit.p95Ms} ms`],
    ["時間（外れ）", `中央値 ${s.latency.miss.p50Ms} ms / 95% ${s.latency.miss.p95Ms} ms`],
    ["全体の平均時間", `${(after / n).toFixed(0)} ms（控え無しなら ${latency} ms）`],
    ["減った呼び出し", `${((1 - s.calls / n) * 100).toFixed(1)}%`],
    ["費用", `${s.costSpent.toFixed(3)}（控え無しなら ${(n * cost).toFixed(3)}）`],
    ["合計の待ち時間", `${(after / 1000).toFixed(1)} 秒（控え無しなら ${(before / 1000).toFixed(1)} 秒）`],
  ]);
}

async function live() {
  const pick = zipf(Math.min(distinct, 20), rng());
  const seen = { HIT: [], MISS: [], other: [] };
  for (let i = 0; i < n; i++) {
    const q = `${queryOf(pick())}`;
    const t0 = performance.now();
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                                   body: JSON.stringify({ q }) });
    await res.text();
    const ms = performance.now() - t0;
    (seen[res.headers.get("X-Cache")] ?? seen.other).push(ms);
  }
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(0) : "—");
  const total = seen.HIT.length + seen.MISS.length;
  print([
    ["検索の回数", `${n} 回`],
    ["当たり / 外れ / 不明", `${seen.HIT.length} / ${seen.MISS.length} / ${seen.other.length}`],
    ["当たりの割合", total ? `${((seen.HIT.length / total) * 100).toFixed(1)}%` : "—"],
    ["往復の中央値（当たり）", `${med(seen.HIT)} ms`],
    ["往復の中央値（外れ）", `${med(seen.MISS)} ms`],
  ]);
}

await (url ? live() : simulate());
