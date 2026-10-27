// 国内の距離と移動手段のテスト。
//
// 国内でも「陸路か空路か」「島をまたぐか」で所要時間はまるで変わります。
// ここを外すと、行けるはずの旅先が候補から消えます。

import assert from "node:assert/strict";
import test from "node:test";

import { estimateMinutes, haversineKm, isSlowTerrain, taxiMinutes }
  from "../packages/core/src/feasibility.js";
import {
  airportDistanceKm, islandOf, onEarth, travelLabel, travelMinutes,
} from "../packages/core/src/geo.js";

const TOKYO = { name: "東京駅", lat: 35.6812, lng: 139.7671 };
const HAKATA = { name: "博多", lat: 33.5897, lng: 130.4207 };
const ISHIGAKI = { name: "石垣島", lat: 24.34, lng: 124.16 };

test("座標として成立しないものは弾く", () => {
  assert.ok(onEarth(35.68, 139.77));
  assert.ok(!onEarth(200, 999));
  assert.ok(!onEarth(NaN, 0));
});

test("国内でも、遠すぎる区間は空路として見積もる", () => {
  // 東京〜石垣は約1950km。陸路の式のままなら20時間を超えて
  // 「時間内に行けません」で弾かれます。
  const hours = estimateMinutes(TOKYO, ISHIGAKI) / 60;
  assert.ok(hours > 3 && hours < 9, hours.toFixed(1) + "時間");
});

test("国内の長距離は、現実的な所要時間になる", () => {
  const h = estimateMinutes(TOKYO, HAKATA) / 60;
  assert.ok(h > 3.5 && h < 6.5, `${h.toFixed(1)}時間`);   // 新幹線5時間・空路4.5時間
});

test("近距離の見積もりは、これまでと変わらない", () => {
  const near = { lat: 35.6820, lng: 139.7680 };
  assert.equal(estimateMinutes(TOKYO, near), estimateMinutes(TOKYO, near));
  assert.ok(estimateMinutes(TOKYO, near) < 15);
});

test("登山道は、街なかの徒歩より遅い速さで見積もる", () => {
    // 五合目→山頂のような、車も公共交通も通らない距離7kmの区間。
  const base = { lat: 35.36, lng: 138.73 };
  const summit = { lat: 35.36, lng: 138.80 };  // 直線距離 約6.4km
  const normal = estimateMinutes(base, summit);
  const slow = estimateMinutes(base, summit, { slow: true });
  // 平地の式（22km/hの車寄り）なら20分程度で出てしまうが、
  // 登山の目安（2.2km/h）ならその5倍以上かかる。
  assert.ok(slow > normal * 4, `normal=${normal} slow=${slow}`);
});

test("isSlowTerrain は、山まわりのカテゴリだけ拾う", () => {
  assert.ok(isSlowTerrain({ category: "登山" }));
  assert.ok(isSlowTerrain({ category: "高原" }));
  assert.ok(!isSlowTerrain({ category: "公園" }));
  assert.ok(!isSlowTerrain(undefined));
});

test("移動手段の呼び名が距離に対応している", () => {
  assert.equal(travelLabel(0.8), "徒歩");
  assert.equal(travelLabel(20), "在来線・バス");
  assert.equal(travelLabel(300), "新幹線・特急");
  assert.equal(travelLabel(9000), "空路");
});

// --- 空港が無いところから飛ばない ------------------------------------------
// これが無いと、どこからでも飛行機に乗れることになります。
// 「松本から網走へ4時間」は、ここが抜けていたせいでした。

const MATSUMOTO = { name: "松本", lat: 36.2306, lng: 137.9653 };
const ABASHIRI = { name: "網走", lat: 44.0206, lng: 144.2734 };
const SAPPORO = { name: "札幌", lat: 43.0686, lng: 141.3508 };
const OKAYAMA = { name: "岡山", lat: 34.6664, lng: 133.9182 };
const TAKAMATSU = { name: "高松", lat: 34.3401, lng: 134.0466 };
const SHIRETOKO = { name: "知床", lat: 44.15, lng: 145.05 };
// 山の中。いちばん近い空港からも遠い。
const OKUCHICHIBU = { name: "奥秩父", lat: 35.90, lng: 138.75 };

test("地方どうしの長距離は、乗り継ぎのぶんだけ長くなる", () => {
  const min = travelMinutes(MATSUMOTO, ABASHIRI);
  assert.ok(min > 6 * 60,
    `松本から網走が ${(min / 60).toFixed(1)}時間 です（短すぎます）`);
});

test("拠点空港どうしなら、乗り継ぎのぶんは付かない", () => {
  // 東京〜札幌は直行便があります。松本〜網走より近いのに
  // 長くなる、ということが起きてはいけません。
  assert.ok(travelMinutes(TOKYO, SAPPORO) < travelMinutes(MATSUMOTO, ABASHIRI));
});

test("空港から遠い場所どうしは、陸路で見積もる", () => {
  // 飛行機を使えることにすると、山の中から山の中へ「空路で4時間」に
  // なります。まず空港まで出る時間がかかります。
  const far = travelMinutes(OKUCHICHIBU, SHIRETOKO);
  assert.ok(far > 9 * 60,
    `${(far / 60).toFixed(1)}時間 です。陸路で見積もれていません`);
  // 空港のある東京から札幌へ行くより、はるかに長いはずです
  // （距離は同じくらいなのに、飛行機に乗れないため）。
  assert.ok(far > travelMinutes(TOKYO, SAPPORO) * 1.5,
    "空港が使える区間と同じくらいの時間になっています");
});

test("空港までの距離を測れる", () => {
  assert.ok(airportDistanceKm(TOKYO) < 30, "東京の近くに空港が無い扱いです");
  assert.ok(airportDistanceKm(OKUCHICHIBU) > 40);
});

// --- 島をまたぐときは、渡れる場所を通る ------------------------------------

test("島の見分けがつく", () => {
  assert.equal(islandOf(SAPPORO), "hokkaido");
  assert.equal(islandOf(TOKYO), "honshu");
  assert.equal(islandOf(TAKAMATSU), "shikoku");
  assert.equal(islandOf(HAKATA), "kyushu");
  assert.equal(islandOf({ lat: 26.21, lng: 127.68 }), "okinawa");
});

test("瀬戸内海をまっすぐ突っ切らない", () => {
  // 岡山と高松は直線40kmですが、橋まで出てから渡ります。
  const min = travelMinutes(OKAYAMA, TAKAMATSU);
  assert.ok(min > 40, `${min}分 です。橋を通っていません`);
});

test("同じ島の中では、余計な上乗せをしない", () => {
  // 岡山〜高松（島をまたぐ40km）より、同じ島の40kmのほうが速いはず。
  const sameIsland = travelMinutes(OKAYAMA,
    { lat: 34.99, lng: 133.92 });   // 岡山県北へ約36km
  assert.ok(sameIsland < travelMinutes(OKAYAMA, TAKAMATSU));
});

// --- 直線距離のままにしない -------------------------------------------------

test("線路も道路も、まっすぐには通っていない", () => {
  // 直線 74km を時速55kmで割ると81分。実際の小田急は85〜100分です。
  const min = travelMinutes(
    { lat: 35.6896, lng: 139.7006 }, { lat: 35.2325, lng: 139.1063 });
  assert.ok(min > 90, `${min}分 です（直線のまま計算しています）`);
  assert.ok(min < 160, `${min}分 です（かかりすぎです）`);
});

// --- タクシー -------------------------------------------------------------
// 近くに駅もバス停も無い区間で使います。電車・バスの見積もりを当てると、
// 待ち時間や乗り換えを含んだ数字になるので、**乗り物が来ない場所ほど
// 長く出る**という逆のことが起きていました。

test("タクシーは、電車・バスの目安より速い", () => {
  // 5km。電車・バスの見積もりは待ちと乗り換えを含みます。
  const km = 5;
  const a = { lat: 35.0, lng: 135.0 };
  const b = { lat: 35.0 + km / 111, lng: 135.0 };
  assert.ok(taxiMinutes(haversineKm(a, b)) < estimateMinutes(a, b),
    `タクシー ${taxiMinutes(haversineKm(a, b))}分 / 目安 ${estimateMinutes(a, b)}分`);
});

test("距離が伸びれば、かかる時間も伸びる", () => {
  assert.ok(taxiMinutes(2) < taxiMinutes(8));
  assert.ok(taxiMinutes(8) < taxiMinutes(20));
});

test("短い区間でも、呼んで乗るぶんの数分は見ておく", () => {
  assert.ok(taxiMinutes(0.5) >= 5, `${taxiMinutes(0.5)}分`);
  assert.equal(taxiMinutes(0), 0);
  assert.equal(taxiMinutes(NaN), 0);
});

test("2kmなら10分前後。時速20kmに呼ぶ時間を足した見かた", () => {
  const m = taxiMinutes(2);
  assert.ok(m >= 10 && m <= 16, `${m}分`);
});
