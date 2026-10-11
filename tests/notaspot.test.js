// 行き先ではないものを、行き先として並べない。
//
// 琵琶湖の岸には浜がいくつもあり、それぞれ収録にあります。それなのに
// 「琵琶湖（海水浴場）」という1件が湖のまん中に置かれ、エリアの定番に
// 並んでいました。宿（東横イン・ビジネスホテル）も「観光名所」として
// 並んでいました。

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { namedSpotAreas } from "../js/areas.js";
import { insideOf } from "../js/shapes.js";
import { isInfoDesk, isLodging, isNotAPlace, isUmbrella, whyNotASpot }
  from "../js/notaspot.js";

const at = (name, category = "観光名所", extra = {}) =>
  ({ id: name, name, category, lat: 35, lng: 136, ...extra });

test("宿は、行き先にしない", () => {
  for (const name of ["東横イン京都琵琶湖大津", "長浜ビジネスホテル",
    "琵琶湖グランドホテル", "長浜ドーム宿泊研修館", "かんぽの宿 寄居",
    "和の宿ホテル祖谷温泉", "TOYOTA SHARE エクシブ琵琶湖"]) {
    assert.equal(isLodging(at(name)), true, name);
  }
});

test("観光案内所は、行き先にしない", () => {
  // 「宮島に行きたい」の1か所目が、45分の「広島駅総合案内所」でした。
  for (const name of ["広島駅総合案内所", "下関駅観光案内所",
    "まちなかインフォメーションセンター", "山ノ内インフォメーション センター",
    "佐野SAインフォメーション"]) {
    assert.equal(isInfoDesk(at(name)), true, name);
    assert.equal(whyNotASpot(at(name)), "案内所", name);
  }
});

test("案内所の字があっても、見どころなら残す", () => {
  for (const name of [
    "倉吉白壁土蔵群・赤瓦観光案内所",   // 見どころの名前とつないだもの
    "奥津湖総合案内所 みずの郷奥津湖 ビジターセンター",
    "中禅寺観光センター",              // 観光センターは物産館などを兼ねる
    "尾瀬沼ビジターセンター",
    "案内所跡"]) {
    assert.equal(isInfoDesk(at(name)), false, name);
  }
});

test("宿の字があっても、行き先なら残す", () => {
  for (const [name, cat] of [
    ["妻籠宿", "史跡"],                       // 宿場
    ["湯宿温泉", "温泉"],                     // 温泉の名前
    ["白山温泉(永井旅館)", "温泉"],            // 行き先は温泉
    ["青荷温泉旅館", "温泉"],                 // 一軒宿の温泉
    ["休暇村近江八幡キャンプ場", "観光名所"],  // キャンプ場
    ["休暇村妙高スキー場", "スキー場"],
    ["豊鹿里パーク(クラインガルデン)/宿泊なし", "観光名所"],
    ["旧鴻池家住宅旅館", "建築"],              // 保存された建物
    ["おおま宿坊 普賢院", "寺院"],             // 寺
    ["太宰の宿ふかうら文学館", "博物館"],
    ["AKAGI GLAMPING VILLAGE", "観光名所"],    // villa ではない
    ["ヴィラデストワイナリー", "観光名所"],
    ["道の駅うつのみや ろまんちっく村ヴィラ・デ・アグリ", "観光名所"],
  ]) {
    assert.equal(isLodging(at(name, cat)), false, name);
  }
});

test("一覧から張られていた、町や会社の記事は外す", () => {
  for (const s of [
    at("伊達市 (北海道)", "海水浴場", { src: "wikipedia" }),
    at("西区 (新潟市)", "海水浴場", { src: "wikipedia" }),
    at("山陽新聞社", "海水浴場", { src: "wikipedia" }),
    at("北海道電力", "湖", { src: "wikipedia" }),
    at("環境省", "海水浴場", { src: "wikipedia" }),
    at("帝国書院", "海水浴場", { src: "wikipedia",
      description: "株式会社帝国書院は、地図帳を主力商品とする出版社。" }),
  ]) {
    assert.equal(isNotAPlace(s), true, s.name);
  }
});

test("町並みや文化財の建物は、記事の形が似ていても残す", () => {
  for (const s of [
    at("今井町 (橿原市)", "観光名所", { src: "wikipedia" }),  // 重伝建
    at("荻町 (白川村)", "観光名所", { src: "wikipedia" }),
    at("東京都庁", "観光名所", { src: "wikipedia" }),          // 展望室
    at("藤樹書院", "寺院", { src: "wikipedia-tourlist" }),
    at("大井川鐵道", "観光名所", { src: "wikipedia",
      description: "大井川鐵道株式会社は、静岡県の鉄道会社。" }),
    at("桜市(宮代町)", "観光名所", { src: "kokudo" }),
  ]) {
    assert.equal(isNotAPlace(s), false, s.name);
  }
});

test("湖や海まるごとを、1つの浜にしない", () => {
  assert.equal(isUmbrella(at("琵琶湖", "海水浴場")), true);
  assert.equal(isUmbrella(at("瀬戸内海", "海水浴場")), true);
  // 浜そのものは浜です。
  assert.equal(isUmbrella(at("近江舞子水泳場", "海水浴場")), false);
  assert.equal(isUmbrella(at("由比ガ浜海水浴場", "海水浴場")), false);
  // 湖は湖として残ります（分類が浜でなければ見ません）。
  assert.equal(isUmbrella(at("琵琶湖", "湖")), false);
});

test("調べて足した場所は、判定しない", () => {
  assert.equal(whyNotASpot(at("ホテルニューオータニ", "観光名所",
    { source: "ai" })), null);
});

test("収録に、行き先ではないものが残っていない", () => {
  const dir = new URL("../kb/", import.meta.url);
  const left = [];
  for (const f of readdirSync(dir).filter((x) => /^spots-.*\.json$/.test(x))) {
    for (const s of JSON.parse(readFileSync(new URL(f, dir), "utf8")).spots) {
      if (whyNotASpot(s)) left.push(s.name);
    }
  }
  assert.deepEqual(left.slice(0, 10), [],
    "node tools/drop_not_spots.mjs --write で外してください");
});

// --- 琵琶湖のような広い場所 ---------------------------------------------

const lake = { id: "wd-Q200239", regionId: "omihachiman", name: "琵琶湖",
  category: "湖", lat: 35.255, lng: 136.08, fame_tier: "major" };
const regions = [
  { id: "omihachiman", name: "近江八幡市", prefecture: "滋賀県", lat: 35.150, lng: 136.107 },
  { id: "takashima", name: "高島市", prefecture: "滋賀県", lat: 35.367, lng: 136.001 },
  { id: "hikone", name: "彦根市", prefecture: "滋賀県", lat: 35.273, lng: 136.253 },
  { id: "otsu-n", name: "大津市", prefecture: "滋賀県", lat: 35.247, lng: 135.939 },
  { id: "kyoto", name: "京都市", prefecture: "京都府", lat: 35.011, lng: 135.768 },
];

test("琵琶湖と書いたら、岸のエリアをまとめて候補にする", () => {
  const kb = { regions, spots: [lake] };
  const [hit] = namedSpotAreas("琵琶湖に行きたい", kb);
  assert.equal(hit.term, "琵琶湖");
  assert.deepEqual(new Set(hit.regionIds),
    new Set(["omihachiman", "takashima", "hikone", "otsu-n"]));
});

test("点の場所なら、そのエリアだけ", () => {
  const temple = { id: "t", regionId: "kyoto", name: "清水寺", category: "寺院",
    lat: 34.995, lng: 135.785, fame_tier: "major" };
  const [hit] = namedSpotAreas("清水寺に行きたい", { regions, spots: [temple] });
  assert.deepEqual(hit.regionIds, ["kyoto"]);
});

test("長い名前に当たったら、短いほうには当てない", () => {
  const bridge = { id: "b", regionId: "otsu-n", name: "琵琶湖大橋", category: "建築",
    lat: 35.121, lng: 135.935, fame_tier: "known" };
  const hits = namedSpotAreas("琵琶湖大橋を渡りたい",
    { regions, spots: [lake, bridge] });
  assert.deepEqual(hits.map((h) => h.term), ["琵琶湖大橋"]);
});

test("定番の広い場所は、名前を含む岸の行き先を挙げる", () => {
  const spots = [
    lake,
    { id: "m", name: "滋賀県立琵琶湖博物館", lat: 35.074, lng: 135.935 },
    { id: "p", name: "奥琵琶湖パークウェイ", lat: 35.453, lng: 136.148 },
    { id: "far", name: "琵琶湖疏水記念館", lat: 35.011, lng: 135.79 },  // 京都、38km
  ];
  const names = insideOf(lake, spots).map((x) => x.spot.name);
  assert.deepEqual(names.sort(), ["奥琵琶湖パークウェイ", "滋賀県立琵琶湖博物館"]);
});
