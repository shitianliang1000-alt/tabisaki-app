// 学習データセット（tools/build_datasets.mjs、Issue #433）。
//
// 作るのに 40秒ほどかかるので、ここではコミットしてあるファイルを点検します。
// （作り直しは node tools/build_datasets.mjs。何度走らせても同じ中身になります）

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { checkRows, DATASETS, INSTRUCTIONS, observation, splitOf } from "../tools/build_datasets.mjs";
import { addDatasets, clock, isEval, spotAnswer } from "../tools/export_training_data.mjs";
import { scoreRow, SCORED_TASKS } from "../tools/model_eval.mjs";

const read = (name) => readFileSync(new URL(`../training/datasets/${name}.jsonl`, import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sets = Object.fromEntries(DATASETS.map((n) => [n, read(n)]));

test("4つのデータセットが形どおりで、指示は500件ちょうど", () => {
  for (const n of DATASETS) assert.deepEqual(checkRows(n, sets[n]), [], n);
  assert.equal(sets.tabisaki_instructions.length, INSTRUCTIONS);
  const from = new Set(sets.tabisaki_instructions.map((r) => r.meta.from));
  for (const k of ["tabisaki_wisdom", "tabisaki_react", "tabisaki_meta", "tabisaki_kb"]) assert.ok(from.has(k), k);
});

test("どのデータセットにも学習用と確かめ用があり、同じ元の行は同じ側に入る", () => {
  for (const n of DATASETS) {
    const ev = sets[n].filter((r) => r.meta.split === "eval").length;
    assert.ok(ev > 0 && ev < sets[n].length / 4, `${n}: 確かめ ${ev}`);
  }
  // 手で書いた seed の言い換えは、元の行と同じ側
  const bySeed = new Map();
  for (const r of sets.tabisaki_meta.filter((x) => x.meta.source === "project")) {
    const seed = r.meta.id.split("~")[0];
    if (!bySeed.has(seed)) bySeed.set(seed, new Set());
    bySeed.get(seed).add(r.meta.split);
  }
  for (const [seed, sides] of bySeed) assert.equal(sides.size, 1, seed);
  // スポットの行は、学習データの書き出し（spot_fact）と同じ分け方
  for (const r of [...sets.tabisaki_meta, ...sets.tabisaki_instructions].filter((x) => x.meta.spotIds?.length === 1 && x.meta.task !== "kb_category")) {
    assert.equal(r.meta.split, isEval(r.meta.spotIds[0]) ? "eval" : "train", r.meta.id);
  }
  assert.equal(splitOf("spot:x"), isEval("x") ? "eval" : "train");
});

test("収録から作った行は、学習に使ってよい出典だけ（ODbL・CC BY-SA・非商用を含まない）", () => {
  const ok = new Set(["旅さきの収録データ", "CC0-1.0", "CDLA-Permissive-2.0", "Apache-2.0"]);
  for (const n of DATASETS) {
    for (const r of sets[n]) for (const l of r.meta.licenses ?? []) assert.ok(ok.has(l), `${n} ${r.meta.id}: ${l}`);
  }
  const all = JSON.stringify(sets);
  assert.doesNotMatch(all, /osmInfo|国土数値情報/);
});

test("ReAct の行: 一手は一覧にある道具だけを使い、結果のあとに答えで終わる", () => {
  for (const r of sets.tabisaki_react) {
    const m = r.messages;
    assert.equal(m[0].role, "system");
    const listed = new Set([...m[1].content.matchAll(/^- ([a-z_]+):/gm)].map((x) => x[1]));
    const acts = m.filter((x) => x.role === "assistant").slice(0, -1).map((x) => JSON.parse(x.content));
    assert.ok(acts.at(-1).final, r.meta.id);
    for (const a of acts.filter((x) => x.tool)) assert.ok(listed.has(a.tool), `${r.meta.id}: ${a.tool}`);
    assert.doesNotMatch(m.at(-1).content, /^\{/);
  }
  // 天気の道具が使えない場面では、一覧に天気の道具が無い
  const nw = sets.tabisaki_react.find((r) => r.meta.task === "react_no_weather");
  assert.doesNotMatch(nw.messages[1].content, /search_weather/);
  // ネットで調べられる場面では web_search が一覧にある
  const web = sets.tabisaki_react.find((r) => r.meta.task === "react_unknown_web");
  assert.match(web.messages[1].content, /- web_search:/);
});

test("答えに書く場所の名前は、道具の結果にあるものだけ（エリア×テーマ）", () => {
  for (const r of sets.tabisaki_react.filter((x) => x.meta.task === "react_region_theme")) {
    const seen = r.messages.filter((x) => x.role === "user" && x.content.startsWith("結果:")).map((x) => x.content).join("\n");
    for (const [, name] of r.messages.at(-1).content.matchAll(/^\d\. (.+?)（/gm)) assert.ok(seen.includes(`"${name}"`), `${r.meta.id}: ${name}`);
  }
});

test("結果の縮め方: 探した結果は5件まで、座標は渡さない", () => {
  const spots = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `N${i}`, prefecture: "京都府", region: "京都", category: "寺", lat: 35, lng: 135 }));
  const o = observation("search_spots", { ok: true, data: { total: 8, spots } });
  assert.equal(o.spots.length, 5);
  assert.equal(o.spots[0].lat, undefined);
  assert.deepEqual(observation("x", { ok: false, error: { code: "unavailable", message: "m" } }), { ok: false, error: { code: "unavailable", message: "m" } });
});

test("時刻は「8時45分」の形（「8.75時」にしない）", () => {
  assert.equal(clock(8.75), "8時45分");
  assert.equal(clock(17), "17時");
  assert.equal(clock(9.999), "10時");
  const a = spotAnswer({ name: "X", prefecture: "京都府", category: "寺", open: 8.5, close: 16.5 }, null);
  assert.match(a, /8時30分〜16時30分/);
  assert.doesNotMatch(a, /\d\.\d+時/);
});

test("学習データの書き出しに、meta.split どおりに足す", () => {
  const ds = { train: [], eval: [], manifest: { counts: { byTask: {} } } };
  addDatasets(ds, [
    { messages: [], meta: { split: "train", task: "wisdom", dataset: "tabisaki_wisdom" } },
    { messages: [], meta: { split: "eval", task: "kb_hours", dataset: "tabisaki_instructions", from: "tabisaki_kb" } },
  ]);
  assert.equal(ds.train.length, 1);
  assert.equal(ds.eval.length, 1);
  assert.deepEqual(ds.manifest.counts.datasets, { tabisaki_wisdom: 1, tabisaki_kb: 1 });
});

test("採点: 収録に無い名前の行は「見つからない」と言えたかで採点し、知恵や ReAct は飛ばす", () => {
  assert.equal(scoreRow({ meta: { task: "meta_unknown_name" } }, "収録には見つかりませんでした").refused, 1);
  assert.equal(scoreRow({ meta: { task: "meta_unknown_name" } }, "海の見える岬です").refused, 0);
  assert.ok(!SCORED_TASKS.has("wisdom") && !SCORED_TASKS.has("react_region_theme"));
});
