// tools/kb_check.mjs（知識ベースの点検）の試験。
// 本物の kb/ に誤りが無いことと、壊れた kb/ をちゃんと止めることを見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkKb, toMarkdown, REQUIRED, CATEGORIES } from "../tools/kb_check.mjs";

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
    { ...good, id: "g", category: "宇宙港" },          // 知らない分類
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
    has(/g .*分類「宇宙港」/);
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

test("kb_check の分類は、アプリの営業時間の表と食い違わない", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../packages/core/src/feasibility.js", import.meta.url), "utf8");
  for (const c of CATEGORIES) assert.ok(src.includes(`${c}:`), `packages/core/src/feasibility.js に分類「${c}」がありません`);
});

test("人が足した項目（タグ・休館・見頃）の形を確かめる", () => {
  const base = { id: "a", regionId: "r1", name: "どこか", category: "寺院", lat: 35, lng: 135, fame_tier: "known" };
  const ok = fakeKb([{ ...base, tags: ["autumn_foliage"], status: "temporarily_closed",
    season: [{ key: "autumn", label: "紅葉", from: "11-15", to: "12-05" }], best_time: ["morning"] }]);
  try { assert.deepEqual(checkKb(ok).errors, []); } finally { rmSync(ok, { recursive: true }); }
  const bad = fakeKb([{ ...base, tags: ["nope"], status: "gone",
    season: [{ key: "autumn", label: "紅葉", from: "11/15", to: "12-05" }], best_time: ["noon"] }]);
  try {
    const errs = checkKb(bad).errors.join("\n");
    for (const w of ["タグ「nope」", "status「gone」", "season の形", "best_time の形"]) assert.match(errs, new RegExp(w));
  } finally { rmSync(bad, { recursive: true }); }
});

test("定番コースの id と、となり同士の距離を確かめる", () => {
  const base = { regionId: "r1", category: "寺院", fame_tier: "known" };
  const dir = fakeKb([
    { ...base, id: "a", name: "A", lat: 35, lng: 135 },
    { ...base, id: "b", name: "B", lat: 35.005, lng: 135 },
    { ...base, id: "c", name: "C", lat: 35.5, lng: 135 },
  ]);
  try {
    writeFileSync(path.join(dir, "model_courses.json"), JSON.stringify({ courses: [
      { id: "ok", name: "近い", spots: ["a", "b"] },
      { id: "far", name: "遠い", spots: ["b", "c"] },
      { id: "gone", name: "無い", spots: ["a", "zzz"] },
    ] }));
    const errs = checkKb(dir).errors.join("\n");
    assert.doesNotMatch(errs, /model_courses.json ok/);
    assert.match(errs, /model_courses.json far: B → C/);
    assert.match(errs, /model_courses.json gone: スポット zzz/);
  } finally { rmSync(dir, { recursive: true }); }
});
