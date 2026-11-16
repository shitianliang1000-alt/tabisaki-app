#!/usr/bin/env node
// 自前エンジン（own プロバイダ）のベンチ。かつての tools/otp_bench.mjs と
// 同じ組（同じ乱数・同じ抽出）で、中継（server/transit.js の transitHandler）を
// 手元ストア（OWN_ENGINE_DB の SQLite）で通して測ります。
//
//   node tools/own_bench.mjs --db data/own/kumamoto.db [--pairs 100]
//
// DB は tools/own_convert.py で作ります（28MB 級になるのでリポジトリには
// 入れません）。出発は水曜 09:00、2026-11-18 に固定します
// （フィードの有効期間に収めるため）。
// パイロット実績（2026-11-14）: 100組中 73組 (73%)、バス×鉄道/市電の混在 4組。
// 応答時間は実行環境の CPU の影響を受ける参考値です。
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { transitHandler } from "../server/transit.js";
import { OWN_REGIONS } from "../server/own-regions.mjs";
import { estimateMinutes, haversineKm } from "../packages/core/src/feasibility.js";

const args = process.argv.slice(2);
const value = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const PAIRS = Number(value("--pairs", 100));
const DATE = value("--date", "2026-11-18");
const DEPART = `${DATE}T09:00:00+09:00`;
const DB = value("--db", process.env.OWN_ENGINE_DB ?? "");
if (!DB || !existsSync(DB)) {
  console.error("使い方: node tools/own_bench.mjs --db <kumamoto.db> [--pairs 100]");
  process.exit(2);
}

const region = OWN_REGIONS[0];
const [minLng, minLat, maxLng, maxLat] = region.bbox;

// --- otp_bench と同じ組の作り方 ---
const dir = new URL("../kb/", import.meta.url).pathname;
const spots = [];
for (const f of (await readdir(dir)).filter((n) => /^spots-.*\.json$/.test(n))) {
  const doc = JSON.parse(await readFile(dir + f, "utf8"));
  for (const s of (Array.isArray(doc) ? doc : doc.spots ?? [])) {
    if (s.lat >= minLat && s.lat <= maxLat && s.lng >= minLng && s.lng <= maxLng) spots.push(s);
  }
}
let seed = 0x2545f491;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pairs = [];
for (let guard = 0; pairs.length < PAIRS && guard < PAIRS * 200; guard++) {
  const a = spots[Math.floor(rand() * spots.length)];
  const b = spots[Math.floor(rand() * spots.length)];
  const km = haversineKm(a, b);
  if (a !== b && km >= 1.5 && km <= 25) pairs.push({ a, b, km });
}
// --- ここまで otp_bench と同一 ---

const ask = (a, b) => transitHandler({
  from: a.name, to: b.name,
  fromAt: { lat: a.lat, lng: a.lng }, toAt: { lat: b.lat, lng: b.lng },
  departAt: DEPART, provider: "own",
}, { OWN_ENGINE_DB: DB });

for (const p of pairs.slice(0, 3)) await ask(p.a, p.b); // ウォームアップ

const rows = [];
for (const p of pairs) {
  const t = performance.now();
  let out = null;
  try { out = await ask(p.a, p.b); } catch { out = null; }
  const ms = performance.now() - t;
  rows.push({
    ...p, ms, routed: Boolean(out?.routed),
    minutes: out?.minutes ?? null,
    fareYen: out?.meta?.fareYen ?? null,
    estimate: estimateMinutes(p.a, p.b),
    // 中継の答えは乗り物の種別を区間から落とすので、名前で見分ける。
    // バスの区間は、名前の中か末尾の（バス）かで必ず「バス」を含む
    // （server/transit.js の labelLine）。鉄道・市電の名前には含まれない。
    rideLines: (out?.meta?.legs ?? []).filter((l) => l.kind === "ride").map((l) => l.line),
  });
}

const sorted = (xs) => [...xs].sort((x, y) => x - y);
const pct = (xs, q) => { const s = sorted(xs); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const ok = rows.filter((r) => r.routed);
const msAll = rows.map((r) => r.ms);
const withFare = ok.filter((r) => r.fareYen != null);
const mixed = ok.filter((r) => r.rideLines.some((l) => l.includes("バス"))
  && r.rideLines.some((l) => !l.includes("バス")));
const ratio = ok.map((r) => r.minutes / r.estimate);

console.log(`範囲のスポット            ${spots.length}件 (${region.name})`);
console.log(`組                        ${rows.length}組`);
console.log(`経路が引けた              ${ok.length}組 (${(100 * ok.length / rows.length).toFixed(0)}%)`);
console.log(`バス×鉄道/市電の混在      ${mixed.length}組`);
console.log(`運賃が付いた              ${withFare.length}組 (${ok.length ? (100 * withFare.length / ok.length).toFixed(1) : "-"}%)`);
console.log(`所要時間 ÷ 目安（中央値） ${f1(pct(ratio, 0.5))}`);
console.log(`応答時間 中央値/90%/最大  ${f1(pct(msAll, 0.5))}ms / ${f1(pct(msAll, 0.9))}ms / ${f1(Math.max(...msAll))}ms`);
