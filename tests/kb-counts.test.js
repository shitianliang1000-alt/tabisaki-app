// 件数の出どころは kb/index.json の counts と shards[].count の1か所です。
// エリアのページ（tools/build_area_pages.mjs の kbCounts）もアプリも
// README と docs/knowledge-base.md もそこから引きます。中身と食い違っていたら、ここで落ちます。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { kbCounts } from "../tools/build_area_pages.mjs";

const kb = (f) => JSON.parse(readFileSync(new URL(`../kb/${f}`, import.meta.url), "utf8"));

test("kb/index.json の件数が、収録の中身と合っている", () => {
  const index = kb("index.json");
  const shards = new Map(index.shards.map((s) => [s.file, kb(s.file).spots]));
  const { total } = kbCounts(index, shards);
  assert.equal(total, [...shards.values()].reduce((n, l) => n + l.length, 0));
  const regions = kb(index.regionsFile ?? "regions.json").regions;
  assert.equal(index.counts.regions, regions.length);
});

test("知識ベースの文書と README の件数が、kb/index.json の counts と同じ", () => {
  const { counts } = kb("index.json");
  const doc = readFileSync(new URL("../docs/knowledge-base.md", import.meta.url), "utf8");
  const num = (label) => Number(new RegExp(`\\| ${label} \\| \\*\\*([0-9,]+)\\*\\* \\|`)
    .exec(doc)?.[1]?.replace(/,/g, ""));
  assert.equal(num("スポット"), counts.spots);
  assert.equal(num("エリア"), counts.regions);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const m = /エリア \*\*([0-9,]+)\*\* か所・スポット \*\*([0-9,]+)\*\* か所/.exec(readme);
  assert.ok(m, "README の Features に件数の行がありません");
  assert.equal(Number(m[1].replace(/,/g, "")), counts.regions);
  assert.equal(Number(m[2].replace(/,/g, "")), counts.spots);
});

test("kbCounts: 県の件数が中身と違えば止める", () => {
  const shards = new Map([["a.json", [{}, {}]]]);
  assert.throws(() => kbCounts({ shards: [{ file: "a.json", count: 3 }] }, shards), /3件ですが、中身は 2件/);
  assert.throws(() => kbCounts({ shards: [{ file: "a.json", count: 2 }], counts: { spots: 5 } }, shards),
    /counts\.spots は 5件/);
  assert.deepEqual(kbCounts({ shards: [{ file: "a.json" }] }, shards).total, null);
});
