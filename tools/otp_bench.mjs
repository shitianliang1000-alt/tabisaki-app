#!/usr/bin/env node
// 手元の OpenTripPlanner（Issue #429）の速さと、距離からの目安とのずれを測ります。
//
//     node tools/otp_bench.mjs                      熊本の収録スポットどうし 60組
//     node tools/otp_bench.mjs --pairs 200 --md     組を増やして Markdown の表で（docs/otp.md 用）
//     node tools/otp_bench.mjs --url http://127.0.0.1:8080 --region otp/regions/kumamoto.json
//
// 先に OTP を動かしておきます（docker compose --profile otp up -d otp。docs/otp.md）。
//
// 測ること
//   - 1回の問い合わせの時間（中継の server/transit.js を通した、読み替えまで込みの時間）
//   - 経路が返った割合と、乗り物の組み合わせ（徒歩だけの答えは「経路なし」扱い）
//   - 旅程づくりが今使っている距離からの目安（feasibility.js の estimateMinutes）と、
//     OTP の所要時間（乗っている時間・待ちを含めた時間）の比
//
// 組は収録のスポットから、直線で 1.5〜25km 離れたものを決まった乱数で選びます
// （毎回同じ組になります）。出発は平日の朝9時です。

import { readFile, readdir } from "node:fs/promises";
import { transitHandler } from "../server/transit.js";
import { estimateMinutes, haversineKm } from "../packages/core/src/feasibility.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

const URL_ = value("--url", "http://127.0.0.1:8080");
const PAIRS = Number(value("--pairs", 60));
const regionPath = value("--region", "otp/regions/kumamoto.json");
const region = JSON.parse(await readFile(new URL(`../${regionPath}`, import.meta.url), "utf8"));
const [minLng, minLat, maxLng, maxLat] = region.osm.bbox;

/** 次の水曜日（東京の日付）の朝9時。 */
function nextWednesday() {
  const now = new Date(Date.now() + 9 * 3600e3);
  const add = ((3 - now.getUTCDay() + 7) % 7) || 7;
  const d = new Date(now.getTime() + add * 86400e3);
  return `${d.toISOString().slice(0, 10)}T09:00:00+09:00`;
}
const DEPART = value("--depart", nextWednesday());

// 収録から、範囲の中のスポット
const dir = new URL("../kb/", import.meta.url);
const spots = [];
for (const f of (await readdir(dir)).filter((n) => /^spots-.*\.json$/.test(n))) {
  const doc = JSON.parse(await readFile(new URL(f, dir), "utf8"));
  for (const s of (Array.isArray(doc) ? doc : doc.spots ?? [])) {
    if (s.lat >= minLat && s.lat <= maxLat && s.lng >= minLng && s.lng <= maxLng) spots.push(s);
  }
}

// 決まった乱数（毎回同じ組）
let seed = 0x2545f491;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pairs = [];
for (let guard = 0; pairs.length < PAIRS && guard < PAIRS * 200; guard++) {
  const a = spots[Math.floor(rand() * spots.length)];
  const b = spots[Math.floor(rand() * spots.length)];
  const km = haversineKm(a, b);
  if (a !== b && km >= 1.5 && km <= 25) pairs.push({ a, b, km });
}

const env = { OTP_URL: URL_ };
const ask = (a, b) => transitHandler({
  provider: "otp", from: a.name, to: b.name, departAt: DEPART,
  fromAt: { lat: a.lat, lng: a.lng }, toAt: { lat: b.lat, lng: b.lng },
}, env);

// 温める（はじめの数回は Java の最適化前で遅い）
for (const p of pairs.slice(0, 3)) await ask(p.a, p.b).catch(() => null);

const rows = [];
for (const p of pairs) {
  const t = performance.now();
  let out = null;
  try { out = await ask(p.a, p.b); } catch (e) { out = { routed: false, reason: e.message }; }
  const ms = performance.now() - t;
  const legs = out.meta?.legs ?? [];
  rows.push({
    ...p, ms, routed: Boolean(out.routed), minutes: out.minutes, ride: out.rideMinutes,
    estimate: estimateMinutes(p.a, p.b),
    kinds: [...new Set(legs.filter((l) => l.kind === "ride").map((l) => (/バス/.test(l.line) ? "バス" : /市電|電車|路面/.test(l.line) ? "路面電車" : "鉄道")))],
    walkFirst: legs[0]?.kind === "walk", walkLast: legs.at(-1)?.kind === "walk",
  });
}

const sorted = (xs) => [...xs].sort((x, y) => x - y);
const pct = (xs, q) => { const s = sorted(xs); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const ok = rows.filter((r) => r.routed);
const msAll = rows.map((r) => r.ms);
const ratio = ok.map((r) => r.minutes / r.estimate);
const rideRatio = ok.map((r) => r.ride / r.estimate);
const mixed = ok.filter((r) => r.kinds.includes("バス") && r.kinds.some((k) => k !== "バス"));
const under = ok.filter((r) => r.minutes > r.estimate * 1.3);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "-");
const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : "-");

const summary = [
  ["範囲のスポット", `${spots.length}件（${region.name}）`],
  ["組", `${rows.length}組（直線 1.5〜25km、出発 ${DEPART}）`],
  ["経路が返った", `${ok.length}組（${f1((ok.length / rows.length) * 100)}%）`],
  ["バスと鉄道・路面電車を乗り継ぐ経路", `${mixed.length}組`],
  ["応答時間 中央値", `${Math.round(pct(msAll, 0.5))}ms`],
  ["応答時間 90%", `${Math.round(pct(msAll, 0.9))}ms`],
  ["応答時間 いちばん遅い", `${Math.round(Math.max(...msAll))}ms`],
  ["OTP（待ち込み）÷ 距離の目安 中央値", f2(pct(ratio, 0.5))],
  ["OTP（乗っている時間）÷ 距離の目安 中央値", f2(pct(rideRatio, 0.5))],
  ["目安より3割以上長くかかる組", `${under.length}組（${f1((under.length / Math.max(1, ok.length)) * 100)}%）`],
];

if (flag("--md")) {
  console.log("| | |\n| --- | --- |");
  for (const [k, v] of summary) console.log(`| ${k} | ${v} |`);
  console.log("\n| 出発 → 到着 | 直線 | 目安 | OTP（待ち込み） | 乗り物 | 時間 |\n| --- | ---: | ---: | ---: | --- | ---: |");
  for (const r of rows.slice(0, 12)) {
    console.log(`| ${r.a.name} → ${r.b.name} | ${f1(r.km)}km | ${r.estimate}分 | ${r.routed ? `${r.minutes}分` : "なし"} | ${r.kinds.join("・") || "-"} | ${Math.round(r.ms)}ms |`);
  }
} else {
  for (const [k, v] of summary) console.log(`${k.padEnd(28, "　")} ${v}`);
}
if (flag("--check") && !ok.length) {
  console.error("1組も経路が返りませんでした（OTP が動いているか、時刻表の期間か）");
  process.exit(1);
}
