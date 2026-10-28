// tools/perf_bench.mjs・tools/perf_web.mjs（速さの計測）の判定の試験。
// 実際に測るのは CI の「Performance」で、ここでは上限・基準との比べかただけを見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { judge, median, METRICS, toMarkdown } from "../tools/perf_bench.mjs";

const budget = JSON.parse(readFileSync(new URL("../bench/perf-budget.json", import.meta.url), "utf8"));
const baseline = JSON.parse(readFileSync(new URL("../bench/perf-baseline.json", import.meta.url), "utf8"));

test("中央値", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 3);
});

test("上限を超えたら over、基準の 1.5 倍を超えたら slower", () => {
  const r = { cli: { startupMs: 50, planMs: 5000, planRssMb: 100 }, kb: { indexMs: 5, loadMs: 400, shardMaxMs: 10, heapMb: 80 } };
  const v = judge(r, budget, { cli: { startupMs: 20 } });
  assert.deepEqual(v.over.length, 1);
  assert.match(v.over[0], /旅程を組む.*5000ms（上限 4000ms）/);
  assert.match(v.slower[0], /起動.*2\.5 倍/);
});

test("基準は、どれも上限の内側にある（基準を作り直したら上限も見直す）", () => {
  const v = judge(baseline, budget, null);
  assert.deepEqual(v.over, []);
  for (const [key] of METRICS) {
    const [a, b] = key.split(".");
    assert.equal(typeof baseline[a][b], "number", `基準に ${key} がありません`);
    assert.equal(typeof budget[a][b], "number", `上限に ${key} がありません`);
  }
  for (const k of ["lcpMs", "inpMs", "cls"]) assert.equal(typeof budget.web[k], "number");
  for (const [page, m] of Object.entries(baseline.web ?? {})) {
    for (const k of ["lcpMs", "inpMs", "cls"]) assert.ok(m[k] <= budget.web[k], `${page} の ${k} ${m[k]} が上限 ${budget.web[k]} を超えています`);
  }
});

test("Markdown の表に、今回・基準・上限が並ぶ", () => {
  const md = toMarkdown(baseline, budget, baseline, { over: [], slower: [] });
  assert.match(md, /\| CLI の起動（--version） \| \d+ms \| \d+ms \| 300ms \|/);
});
