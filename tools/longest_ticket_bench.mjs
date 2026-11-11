#!/usr/bin/env node
// 最長片道切符のソルバーが、制限時間内に答えを返すかを測ります（Issue #431）。
//
//     node tools/longest_ticket_bench.mjs            全国と、代表的な出発駅を測って表にする
//     node tools/longest_ticket_bench.mjs --check    制限時間内に候補が返らなければ失敗で終わる（CI 用）
//     node tools/longest_ticket_bench.mjs --md       Markdown の表で出す（docs/longest-ticket.md 用）
//     node tools/longest_ticket_bench.mjs --from 松本 --legs   1駅だけ測って、乗る線の順も出す
//
// 測るのは「網を縮める → ソルバー → 駅の並びに戻す」の全部です
// （路線網と WebAssembly の読み込みは、はじめの1回だけ別に測ります）。

import { loadGraph, loadSolver, createLongestTicketSolver } from "../packages/core/longest-ticket.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);

// 制限時間（ミリ秒）。全国の網は最長と確かめきれないので、ソルバーは時間いっぱい経路を伸ばします。
// 既定はアプリと同じ 5秒。--check では、網を縮める・駅の並びに戻すぶんの余裕（SLACK）も見ます。
const LIMIT = Number(value("--limit", 5000));
const SLACK = 3000;
// これより短い候補しか出なければ、組み替えの探索が壊れたとみなします（5秒で 8,600km を超えます）。
const MIN_KM = 8000;
const STARTS = value("--from", null)?.split(",") ?? [
  null, "稚内", "札幌", "函館", "青森", "仙台", "新潟", "東京", "新宿", "松本", "名古屋", "金沢",
  "京都", "大阪", "岡山", "松江", "広島", "高松", "高知", "博多", "長崎", "鹿児島中央", "枕崎",
];

const t0 = performance.now();
const graph = await loadGraph();
const solver = await loadSolver();
const loadMs = performance.now() - t0;
const solve = await createLongestTicketSolver({ graph, solver, limitMs: LIMIT });

const rows = [];
for (const kind of ["oneway", "round"]) {
  for (const from of (kind === "round" ? [null] : STARTS)) {
    const t = performance.now();
    const r = await solve(kind, { from });
    rows.push({
      kind, from: from ?? "（全国）", ms: performance.now() - t, km: r.km, first: r.stations[0], last: r.stations.at(-1),
      stations: r.stations.length, proven: r.proven, width: r.stats?.width, states: r.stats?.states, legs: r.legs,
    });
  }
}

const fmt = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}秒`);
if (flag("--md")) {
  console.log("| 出発駅 | 営業キロ | 経路 | 駅の数 | 時間 | 最長と確かめたか |");
  console.log("| --- | ---: | --- | ---: | ---: | --- |");
  for (const r of rows) {
    console.log(`| ${r.from}${r.kind === "round" ? "・往復" : ""} | ${r.km.toFixed(1)} | ${r.first} → ${r.last} | ${r.stations} | ${fmt(r.ms)} | ${r.proven ? "はい" : "いいえ（候補）"} |`);
  }
} else {
  console.log(`路線網: 駅 ${graph.stations.length}・辺 ${graph.edges.length}（${graph.asOf} 時点）。読み込み ${fmt(loadMs)}`);
  for (const r of rows) {
    console.log(`${(r.from + (r.kind === "round" ? "・往復" : "")).padEnd(10, "　")} ${r.km.toFixed(1).padStart(8)}km  ${fmt(r.ms).padStart(7)}  `
      + `${r.proven ? "最長" : "候補"}  ${r.first} → ${r.last}（${r.stations}駅、境目の幅 ${r.width}、状態 ${r.states}）`);
    if (flag("--legs")) for (const l of r.legs) console.log(`    ${l.line}  ${l.from} → ${l.to}  ${l.km}km`);
  }
}

if (flag("--check")) {
  const slow = rows.filter((r) => r.ms > LIMIT + SLACK);
  const short = rows.filter((r) => (r.kind === "round" ? r.km / 2 : r.km) < MIN_KM);
  if (slow.length || short.length) {
    for (const r of slow) console.error(`制限時間（${fmt(LIMIT)}）を超えました: ${r.from} ${fmt(r.ms)}`);
    for (const r of short) console.error(`候補が短すぎます: ${r.from} ${r.km}km`);
    process.exit(1);
  }
  const proven = rows.filter((r) => r.proven).length;
  console.log(`\n${rows.length}通りとも、制限時間（${fmt(LIMIT)}）内に候補が出ました（最長と確かめきれたもの ${proven}通り）。`
    + `いちばん遅いもので ${fmt(Math.max(...rows.map((r) => r.ms)))}、いちばん短い候補で ${Math.min(...rows.map((r) => r.km)).toFixed(1)}km。`);
}
