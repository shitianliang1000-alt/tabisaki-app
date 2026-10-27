// 宿の取りかたを選べるようにしたテスト。
//
// 同じ3泊4日でも、「1か所に泊まって日帰りで回る」旅と「泊まるたびに
// 土地を変える」旅は別の旅です。これまでは日数から勝手に決めていたので、
// 連泊したい人にも拠点を移す旅程が出ていました。
//
// 確かめたいのは3つです。
//   ・連泊を選んだら、どの日も同じ拠点になる
//   ・周遊を選んだら、1エリア1日から割り振る
//   ・おまかせは、これまでの動きのまま（既存の旅程を変えない）

import assert from "node:assert/strict";
import test from "node:test";

import {
  STAY_STYLES, allocateDays, pickBase, planStays, suggestRegionCount,
} from "../packages/core/src/stays.js";
import { makeTrip } from "../packages/core/src/trip.js";

const region = (id, name, lat, lng) => ({
  id, name, lat, lng, station: `${name}駅`,
  stationLat: lat, stationLng: lng, prefecture: "島根県",
});

const spot = (id, lat, lng) => ({
  id, name: id, category: "寺院", lat, lng, dwell: 60, open: 9, close: 17,
});

// 松江・出雲・石見銀山。西へ並んでいます。
const CHOSEN = [
  { region: region("matsue", "松江", 35.468, 133.048),
    spots: [spot("m1", 35.468, 133.048), spot("m2", 35.47, 133.05),
            spot("m3", 35.472, 133.052), spot("m4", 35.474, 133.054),
            spot("m5", 35.476, 133.056), spot("m6", 35.478, 133.058)] },
  { region: region("izumo", "出雲", 35.367, 132.755),
    spots: [spot("i1", 35.367, 132.755), spot("i2", 35.369, 132.757)] },
  { region: region("omori", "大森", 35.113, 132.436),
    spots: [spot("o1", 35.113, 132.436), spot("o2", 35.115, 132.438)] },
];

const ORIGIN = { name: "岡山駅", lat: 34.666, lng: 133.918 };

test("おまかせは、これまでどおり2日にひとつ", () => {
  assert.equal(suggestRegionCount(6), 3);
  assert.equal(suggestRegionCount(6, null, STAY_STYLES.AUTO), 3);
});

test("連泊なら、回るエリアを絞る", () => {
  // 宿を動かさないのに4エリア選ぶと、毎晩遠くから戻ることになります。
  assert.equal(suggestRegionCount(6, null, STAY_STYLES.BASE), 2);
  assert.equal(suggestRegionCount(12, null, STAY_STYLES.BASE), 3);
});

test("周遊なら、泊まるたびに土地が変わる", () => {
  assert.equal(suggestRegionCount(6, null, STAY_STYLES.TOUR), 6);
  assert.equal(suggestRegionCount(3, null, STAY_STYLES.TOUR), 3);
});

test("周遊の割り振りは、1エリア1日から", () => {
  // 収録の多いエリアに何日も積むと、選んだ意味がありません。
  const counts = [12, 2, 2];
  const auto = allocateDays([1, 2, 3], 5, counts, 5, STAY_STYLES.AUTO);
  const tour = allocateDays([1, 2, 3], 5, counts, 5, STAY_STYLES.TOUR);
  assert.equal(auto.reduce((a, b) => a + b), 5);
  assert.equal(tour.reduce((a, b) => a + b), 5);
  // おまかせは収録の多いエリアに寄せます。周遊は寄せません。
  assert.ok(Math.max(...tour) - Math.min(...tour) <= 1);
  assert.ok(Math.max(...auto) >= Math.max(...tour));
});

test("連泊では、どの日も同じ拠点になる", () => {
  const plan = planStays(CHOSEN, {
    days: 4, origin: ORIGIN, end: ORIGIN, stayStyle: STAY_STYLES.BASE,
  });
  assert.equal(plan.baseByDay.length, 4);
  const names = new Set(plan.baseByDay.map((b) => b.name));
  assert.equal(names.size, 1);
  assert.equal(plan.basedAt.name, plan.baseByDay[0].name);
});

test("おまかせでは、拠点が日ごとに移る", () => {
  const plan = planStays(CHOSEN, { days: 4, origin: ORIGIN, end: ORIGIN });
  assert.equal(plan.basedAt, null);
  assert.ok(new Set(plan.baseByDay.map((b) => b.name)).size > 1);
});

test("連泊する場所は、長くいるエリアに寄る", () => {
  // 地図の真ん中は出雲ですが、2日いるのは松江です。日数で重みを
  // 付けないと、1日しか行かない遠いエリアのために宿が遠くなり、
  // 2日ぶん毎日余計に移動することになります。
  const stays = [
    { station: { name: "松江駅", lat: 35.468, lng: 133.048 }, days: 2 },
    { station: { name: "出雲市駅", lat: 35.367, lng: 132.755 }, days: 1 },
    { station: { name: "大森駅", lat: 35.113, lng: 132.436 }, days: 1 },
  ];
  assert.equal(pickBase(stays).name, "松江駅");
  // 日数が逆なら、寄る先も逆になります
  const flipped = [
    { station: { name: "松江駅", lat: 35.468, lng: 133.048 }, days: 1 },
    { station: { name: "出雲市駅", lat: 35.367, lng: 132.755 }, days: 1 },
    { station: { name: "大森駅", lat: 35.113, lng: 132.436 }, days: 3 },
  ];
  assert.equal(pickBase(flipped).name, "大森駅");
});

test("条件に、宿の取りかたが入る", () => {
  assert.equal(makeTrip({}).stayStyle, "auto");
  assert.equal(makeTrip({ stayStyle: "base" }).stayStyle, "base");
  assert.equal(makeTrip({ stayStyle: "hotel" }).stayStyle, "auto");
});

// --- エリア名の重なり -------------------------------------------------------
//
// 収録のエリア名は、出どころによって粒度が違います。そのまま並べると
// 旅の題が「京都・東山・京都市」になり、同じ名前が2回並んでいるように
// しか見えませんでした。

test("同じ土地を指す名前は、1つにまとめる", async () => {
  const { dedupeAreaNames, joinAreaNames } = await import("../packages/core/src/stays.js");
  assert.deepEqual(dedupeAreaNames(["京都", "東山", "京都市"]), ["京都", "東山"]);
  assert.equal(joinAreaNames(["京都", "東山", "京都市"]), "京都・東山");
  assert.equal(joinAreaNames(["出雲", "出雲市"]), "出雲");
  // 呼び名つきが先に来ても、短いほうを残します（題は短いほうが読めます）。
  assert.equal(joinAreaNames(["京都市", "京都"]), "京都");
});

test("末尾の呼び名だけを落とす（途中の字は残す）", async () => {
  const { joinAreaNames } = await import("../packages/core/src/stays.js");
  // 「市川」の「市」を落とすと、別の土地になります。
  assert.equal(joinAreaNames(["市川", "市川市"]), "市川");
  assert.equal(joinAreaNames(["市川", "川崎"]), "市川・川崎");
});

test("中に入っているだけの名前は、まとめない", async () => {
  const { joinAreaNames } = await import("../packages/core/src/stays.js");
  // 「出雲」と「出雲大社」は別のものです。ここまで寄せると、行き先が
  // 消えます。
  assert.equal(joinAreaNames(["出雲", "出雲大社"]), "出雲・出雲大社");
});

test("まとめたあとで数え直す（4つ以上は省略）", async () => {
  const { joinAreaNames } = await import("../packages/core/src/stays.js");
  // まとめる前は4つでも、まとめて3つなら全部書けます。
  assert.equal(joinAreaNames(["京都", "東山", "嵐山", "京都市"]),
    "京都・東山・嵐山");
  assert.equal(joinAreaNames(["A", "B", "C", "D"]), "A〜Dほか4エリア");
});

test("空や壊れた名前でも落ちない", async () => {
  const { dedupeAreaNames, joinAreaNames } = await import("../packages/core/src/stays.js");
  assert.deepEqual(dedupeAreaNames(null), []);
  assert.deepEqual(dedupeAreaNames(["", null, undefined, "市"]), []);
  assert.equal(joinAreaNames([]), "");
  assert.equal(joinAreaNames(null), "");
});
