// tools/kb_check.mjs（知識ベースの点検）の試験。
// 本物の kb/ に誤りが無いことと、壊れた kb/ をちゃんと止めることを見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkKb, toMarkdown, REQUIRED } from "../tools/kb_check.mjs";

test("本物の kb/ に誤りが無い", () => {
  const { errors, stats } = checkKb();
  assert.deepEqual(errors.slice(0, 5), [], `誤り ${errors.length} 件`);
  assert.ok(stats.spots > 10000);
});

function fakeKb(spots, { count = spots.length, counts } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "kb-"));
  writeFileSync(path.join(dir, "regions.json"), JSON.stringify({ regions: [{ id: "r1", name: "エリア" }] }));
  writeFileSync(path.join(dir, "spots-x.json"), JSON.stringify({ spots }));
  writeFileSync(path.join(dir, "index.json"), JSON.stringify({
    regionsFile: "regions.json",
    shards: [{ file: "spots-x.json", count, prefecture: "テスト県", regions: ["r1"] }],
    counts: counts ?? { spots: spots.length, regions: 1 },
    sources: [{ name: "テスト" }],
  }));
  return dir;
}

const good = { id: "a", regionId: "r1", name: "清水寺", category: "寺院", lat: 35, lng: 135.7, fame_tier: "major", open: 6, close: 18 };

test("正しい形なら誤りは出ない", () => {
  const dir = fakeKb([good]);
  try {
    assert.deepEqual(checkKb(dir).errors, []);
  } finally { rmSync(dir, { recursive: true }); }
});

test("必須の項目・座標・id・営業時間・エリア・件数の誤りを拾う", () => {
  const dir = fakeKb([
    good,
    { ...good },                                       // id が重なる
    { ...good, id: "b", lat: 10 },                     // 日本の外
    { ...good, id: "c", open: 19, close: 9 },          // 開く方が後
    { ...good, id: "d", regionId: "nowhere" },         // 無いエリア
    { ...good, id: "e", fame_tier: "super" },          // 知らない値
    (({ name, ...rest }) => ({ ...rest, id: "f" }))(good), // name が無い
  ], { count: 99 });
  try {
    const { errors } = checkKb(dir);
    const has = (re) => assert.ok(errors.some((e) => re.test(e)), `${re} が出ていません: ${errors}`);
    has(/a .*id が重なっています/);
    has(/b .*日本の範囲の外/);
    has(/c .*開く時刻/);
    has(/d .*エリア nowhere がありません/);
    has(/e .*fame_tier/);
    has(/ f: name がありません/);
    has(/索引の件数 99/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("必須の項目は、アプリが読む項目と同じ", () => {
  assert.deepEqual(REQUIRED, ["id", "regionId", "name", "category", "lat", "lng", "fame_tier"]);
});

test("Markdown のまとめに、件数と誤りが出る", () => {
  const md = toMarkdown({ errors: ["x: id が重なっています"], warnings: [], stats: { spots: 1, regions: 1 } });
  assert.match(md, /誤り 1 件/);
  assert.match(md, /\| スポット \| 1 \|/);
});
