// 点ではないものを、点として案内しない。
//
// 収録のスポットは、どれも「1つの座標」として入っています。お寺や
// 美術館ならそれで足りますが、道と広い場所は足りません。
//
//   道      入口と出口があります。通り抜ける道では、帰りに乗る場所は
//           入口ではなく出口の最寄りです。
//   広い場所  座標は代表の1点で、入口ではありません。
//
// ここで確かめたいのは「持っていないものを推し量らない」ことです。
// 道らしい名前は144件あり、両端が分かるのは1本だけ（山背古道）です。

import assert from "node:assert/strict";
import test from "node:test";

import { attachShapes, insideOf, shapeOf, trailCore, trailEnds, trailPoints }
  from "../packages/core/src/shapes.js";

const at = (name, lat, lng, category = "観光名所") =>
  ({ id: name, name, lat, lng, category });

test("道らしい名前を、道として見分ける", () => {
  assert.equal(shapeOf(at("山背古道", 34.8, 135.8)), "trail");
  assert.equal(shapeOf(at("熊野古道大門坂", 33.6, 135.9)), "trail");
  assert.equal(shapeOf(at("伊豆スカイライン", 35.0, 139.0)), "trail");
  assert.equal(shapeOf(at("山背古道ウォーキング", 34.7, 135.8, "山")), "trail");
});

test("「道」で終わっても、道でないものは道にしない", () => {
  // 北海道は地方の名前、国道○号は行政の道路名です。
  assert.equal(shapeOf(at("北海道", 43.0, 141.0)), "point");
  assert.equal(shapeOf(at("国道58号", 26.0, 127.0)), "point");
  assert.equal(shapeOf(at("北海道立近代美術館", 43.0, 141.0, "美術館")), "point");
});

test("広い場所を、分類と名前から見分ける", () => {
  assert.equal(shapeOf(at("舞洲", 34.66, 135.39, "島")), "wide");
  assert.equal(shapeOf(at("美ヶ原", 36.2, 138.1, "高原")), "wide");
  assert.equal(shapeOf(at("阿蘇くじゅう国立公園", 32.9, 131.1, "公園")), "wide");
  // お寺は点です。
  assert.equal(shapeOf(at("高徳院（鎌倉大仏）", 35.3, 139.5, "寺院")), "point");
});

test("同じ道の別名を、1本として集める", () => {
  assert.equal(trailCore("山背古道ウォーキング"), "山背古道");
  assert.equal(trailCore("山背古道"), "山背古道");
  const spots = [
    at("山背古道ウォーキング", 34.73716, 135.82012, "山"),
    at("山背古道", 34.85301, 135.77997, "山"),
    at("別の道", 35.0, 135.0),
  ];
  assert.equal(trailPoints(spots[0], spots).length, 2);
});

test("両端が分かる道は、入口と出口を出す", () => {
  const spots = [
    at("山背古道ウォーキング", 34.73716, 135.82012, "山"),
    at("山背古道", 34.85301, 135.77997, "山"),
  ];
  // 南から来るなら、南の点が入口です。
  const fromSouth = trailEnds(spots[0], spots, { lat: 34.70, lng: 135.82 });
  assert.equal(fromSouth.entry.name, "山背古道ウォーキング");
  assert.equal(fromSouth.exit.name, "山背古道");
  assert.ok(fromSouth.km > 13 && fromSouth.km < 14, `${fromSouth.km}km`);
  // 北から来るなら、逆です。
  const fromNorth = trailEnds(spots[0], spots, { lat: 34.90, lng: 135.78 });
  assert.equal(fromNorth.entry.name, "山背古道");
});

test("1点しか無い道では、入口も出口も言わない", () => {
  // 推し量ると、行けない旅程ができます。
  const spots = [at("熊野古道大門坂", 33.67147, 135.89899)];
  assert.equal(trailEnds(spots[0], spots, { lat: 33.6, lng: 135.9 }), null);
});

test("広い場所の中の行き先を、名前から挙げる", () => {
  const spots = [
    at("舞洲", 34.66422, 135.39514, "島"),
    at("舞洲スポーツアイランド", 34.66422, 135.39514, "公園"),
    // 名前が「舞洲」から始まらない近所は、島の中とは限りません。
    at("ユニバーサル・スタジオ・ジャパン", 34.6654, 135.4323, "遊園地"),
  ];
  const inside = insideOf(spots[0], spots);
  assert.deepEqual(inside.map((x) => x.spot.name), ["舞洲スポーツアイランド"]);
});

test("旅程に書き足すのは、説明だけ", async () => {
  const spots = [
    at("山背古道ウォーキング", 34.73716, 135.82012, "山"),
    at("山背古道", 34.85301, 135.77997, "山"),
    at("舞洲", 34.66422, 135.39514, "島"),
    at("舞洲スポーツアイランド", 34.66422, 135.39514, "公園"),
  ];
  const itin = {
    days: [{
      items: [
        { kind: "transit", to: { name: "駅", lat: 34.70, lng: 135.82 } },
        { kind: "spot", place: spots[0], start: "2026-09-20T10:00" },
        { kind: "spot", place: spots[2], start: "2026-09-20T14:00" },
        { kind: "spot", place: at("お寺", 35.0, 135.0, "寺院") },
      ],
    }],
  };
  const before = itin.days[0].items[1].start;
  const n = await attachShapes(itin, {
    spots,
    // 最寄りの停留所。試験では固定の答えを返します。
    nearestStop: async (p) => ({ name: `${p.name ?? "ここ"}前`, km: 0.4 }),
  });
  assert.equal(n, 2);
  const trail = itin.days[0].items[1].shape;
  assert.equal(trail.kind, "trail");
  assert.equal(trail.entry.name, "山背古道ウォーキング");
  assert.equal(trail.exit.name, "山背古道");
  // 出口の最寄りが出ていること（「帰りはここから」の答えです）。
  assert.equal(trail.exitStop.name, "山背古道前");
  const wide = itin.days[0].items[2].shape;
  assert.equal(wide.kind, "wide");
  assert.deepEqual(wide.inside.map((x) => x.name), ["舞洲スポーツアイランド"]);
  // 点の場所には何も付きません。
  assert.equal(itin.days[0].items[3].shape, undefined);
  // 時刻は動かしません。
  assert.equal(itin.days[0].items[1].start, before);
});

test("停留所が引けなくても、案内は出る", async () => {
  const spots = [at("熊野古道大門坂", 33.67147, 135.89899)];
  const itin = { days: [{ items: [{ kind: "spot", place: spots[0] }] }] };
  await attachShapes(itin, {
    spots,
    nearestStop: async () => { throw new Error("圏外"); },
  });
  assert.equal(itin.days[0].items[0].shape.kind, "trail");
  assert.equal(itin.days[0].items[0].shape.entryStop, null);
});

// --- 広い場所の名前を増やしたとき ---------------------------------------------

test("山地・山脈・湾・海峡・平野・盆地・自然公園も、広い場所として扱う", () => {
  // 収録に「飛騨山脈」「東京湾」「〇〇自然公園」を入れるようになりました
  // （tools/import_wikipedia_lists.py の WIDE_BY_SUFFIX）。分類だけでは
  // 「自然」や「海岸」に落ちて、広い場所の案内が付きません。
  for (const name of ["飛騨山脈", "中国山地", "東京湾", "関門海峡", "関東平野",
                      "甲府盆地", "阿蘇くじゅう国立公園", "秋吉台国定公園",
                      "県立〇〇自然公園", "伊豆半島", "五島列島", "利根川水系"]) {
    assert.equal(shapeOf({ name, category: "自然" }), "wide",
      `${name} が広い場所になっていません`);
  }
});

test("「湾」は語尾だけで見る（港湾・湾岸を巻き込まない）", () => {
  // 「湾」を含むだけで広い場所にすると、「湾岸ドライブ」「港湾博物館」まで
  // 「代表の1点で入口ではありません」と書かれます。
  assert.equal(shapeOf({ name: "東京湾", category: "海岸" }), "wide");
  for (const name of ["湾岸ドライブ", "港湾博物館", "横浜港湾ミュージアム"]) {
    assert.notEqual(shapeOf({ name, category: "博物館" }), "wide",
      `${name} が広い場所になっています`);
  }
});
