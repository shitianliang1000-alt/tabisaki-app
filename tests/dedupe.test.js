// 同じ場所を、2つの場所として並べない。
//
// 収録は3つの出どころを混ぜています（国土数値情報、手作業の収録、
// Wikidata）。同じものが、出どころごとに別の名前で入っていました。
//
//   高徳院（鎌倉大仏）   35.3167, 139.5358
//   鎌倉大仏 高徳院      35.3167, 139.5358
//
// 座標が1桁も違いません。それぞれ別のスポットとして扱っていたので、
// 旅程に両方入り、「高徳院（鎌倉大仏）40分 → 移動0分 → 鎌倉大仏
// 高徳院 40分」という並びができます。同じ大仏の前に80分立つことに
// なります。
//
// ただし**座標が同じ＝同じ場所ではありません**。全国に498組ありますが、
// そこには「小樽美術館 | 小樽文学館」（同じ建物の別の施設）や
// 「黒石よされ | 旧正マッコ市」（同じ会場の別の祭り）が含まれます。
// 座標だけで潰すと、行けたはずの場所が消えます。

import assert from "node:assert/strict";
import test from "node:test";

import { coLocated, dedupeSpots, sameThing, samePoint } from "../packages/core/src/dedupe.js";

const at = (name, lat, lng, over = {}) =>
  ({ id: name, name, lat, lng, ...over });

test("語を並べ替えただけの名前は、同じもの", () => {
  assert.equal(sameThing("高徳院（鎌倉大仏）", "鎌倉大仏 高徳院"), true);
});

test("飾りが前に付いただけの名前は、同じもの", () => {
  assert.equal(sameThing("観光神楽 高千穂神社", "高千穂神社"), true);
  assert.equal(sameThing("市立小樽文学館", "小樽文学館"), true);
});

test("別のものは、まとめない", () => {
  assert.equal(sameThing("小樽美術館", "小樽文学館"), false);
  assert.equal(sameThing("黒石よされ", "旧正マッコ市"), false);
  // 同じ座標の別名（九重山と久住山）も、名前からは同じと言えません。
  // **決められないことを決めません。**
  assert.equal(sameThing("九重山", "久住山"), false);
});

test("短い名前で、包含を当てにいかない", () => {
  // 「山」が「高尾山」に含まれるからといって、同じものではありません。
  assert.equal(sameThing("山", "高尾山"), false);
  assert.equal(sameThing("城", "松江城"), false);
});

test("同じ場所の同じものを、1つにまとめる", () => {
  const { spots, merged } = dedupeSpots([
    at("高徳院（鎌倉大仏）", 35.3167, 139.5358, { description: "大仏" }),
    at("鎌倉大仏 高徳院", 35.3167, 139.5358, { source: "external" }),
  ]);
  assert.equal(merged, 1);
  assert.equal(spots.length, 1);
  // 手作業の収録（営業時間と料金を持っています）を残します。
  assert.equal(spots[0].name, "高徳院（鎌倉大仏）");
  // まとめた側の名前は別名に残します（「鎌倉大仏」で探した人が
  // たどり着けなくなると、直したつもりで壊れます）。
  assert.deepEqual(spots[0].aka, ["鎌倉大仏 高徳院"]);
});

test("残す名前は、長いほうではなく分かるほう", () => {
  // 前に付いた飾り（催しの名前）は落とします。
  const { spots } = dedupeSpots([
    at("観光神楽 高千穂神社", 32.70667, 131.30167),
    at("高千穂神社", 32.70667, 131.30167),
  ]);
  assert.equal(spots[0].name, "高千穂神社");
  assert.ok(spots[0].aka.includes("観光神楽 高千穂神社"));
});

test("まとめても、持っている情報が減らない", () => {
  // 手作業の収録は営業時間と料金を、Wikidata は説明とリンクを
  // 持っています。どちらかを捨てると、まとめたことで情報が減ります。
  const { spots } = dedupeSpots([
    at("高徳院（鎌倉大仏）", 35.3167, 139.5358,
       { open: 8, close: 17, fee: 300 }),
    at("鎌倉大仏 高徳院", 35.3167, 139.5358,
       { source: "external", description: "阿弥陀如来坐像", wikipedia: "高徳院" }),
  ]);
  assert.equal(spots[0].open, 8);
  assert.equal(spots[0].fee, 300);
  assert.equal(spots[0].description, "阿弥陀如来坐像");
  assert.equal(spots[0].wikipedia, "高徳院");
});

test("同じ建物の別の施設は、まとめない", () => {
  const { spots, merged } = dedupeSpots([
    at("小樽美術館", 43.1979, 140.9944),
    at("小樽文学館", 43.1979, 140.9944),
  ]);
  assert.equal(merged, 0);
  assert.equal(spots.length, 2);
});

test("少しでも座標が違えば、まとめない", () => {
  // 同じ名前でも、離れていれば別の場所です（どちらかの座標が誤って
  // いる可能性もありますが、**こちらでは決められません**）。
  const { merged } = dedupeSpots([
    at("久住山", 32.97385, 131.39778),
    at("久住山", 33.08222, 131.24083),
  ]);
  assert.equal(merged, 0);
});

test("まとめなかった「同じ地点」を、組として取り出せる", () => {
  // 九重山と久住山は同じ座標の別名です。どちらが正しいかは決められない
  // ので、決めずに「同じ場所にあります」と伝えます。
  const groups = coLocated([
    at("九重山", 33.08222, 131.24083),
    at("久住山", 33.08222, 131.24083),
    at("別の場所", 35.0, 135.0),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((s) => s.name).sort(), ["久住山", "九重山"]);
});

test("同じ地点かどうかは、約11mで見る", () => {
  assert.equal(samePoint({ lat: 35.3167, lng: 139.5358 },
                         { lat: 35.3167, lng: 139.5358 }), true);
  assert.equal(samePoint({ lat: 35.3167, lng: 139.5358 },
                         { lat: 35.3180, lng: 139.5358 }), false);
});
