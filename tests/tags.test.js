// スポットのタグ（packages/core/src/tags.js）の試験。

import assert from "node:assert/strict";
import test from "node:test";

import { TAGS, spotTags, spotProfile } from "../packages/core/src/tags.js";
import { searchSpotsByKeyword } from "../packages/core/src/kb.js";

test("分類・名前・説明からタグが付く", () => {
  assert.deepEqual(spotTags({ name: "華厳滝", category: "滝" }), ["waterfall"]);
  assert.ok(spotTags({ name: "秋芳洞", category: "観光名所", description: "日本有数の鍾乳洞" }).includes("cave"));
  assert.ok(spotTags({ name: "函館山", category: "展望台", description: "夜景で知られる" }).includes("night_view"));
  assert.ok(spotTags({ name: "東山動植物園", category: "動物園" }).includes("zoo"));
  assert.deepEqual(spotTags({ name: "新宿アイランドタワー", category: "観光名所" }), []);
});

test("人が足したタグは残し、知らないタグは捨てる", () => {
  const t = spotTags({ name: "清水寺", category: "寺院", tags: ["world_heritage", "autumn_foliage", "nonsense"] });
  assert.deepEqual(t, ["temple", "world_heritage", "autumn_foliage"]);
  for (const id of t) assert.ok(id in TAGS);
});

test("時間帯・同行者・体の負担の見立て", () => {
  const night = spotProfile({ name: "稲佐山", category: "展望台", tags: ["night_view"] });
  assert.deepEqual(night.bestTime, ["night"]);
  assert.ok(night.suitableFor.includes("couple"));
  assert.equal(spotProfile({ name: "海遊館", category: "水族館" }).suitableFor[0], "kids");
  assert.equal(spotProfile({ name: "槍ヶ岳", category: "山" }).effort, "hard");
  assert.equal(spotProfile({ name: "兼六園", category: "庭園" }).effort, "easy");
});

test("「紅葉」で、分類が寺院の紅葉の名所も見つかる", () => {
  const kb = { spots: [
    { name: "東福寺", category: "寺院", tags: ["autumn_foliage"], fame_score: 80 },
    { name: "どこかの寺", category: "寺院", fame_score: 80 },
  ] };
  const hits = searchSpotsByKeyword(kb, ["紅葉"]).map((h) => h.spot.name);
  assert.deepEqual(hits, ["東福寺"]);
});
