// 天気・日没・混雑を見て、旅程を見直すテスト。
//
// ここもAIには任せません。「雨の時間に屋外のスポットが入っているか」は
// 数えれば分かることです。AIに聞くと、聞くたびに違う答えが返ります。
//
// 出すのは**変更案**であって、旅程そのものではありません。
// 採用されたら、これまでと同じエンジン（verify.js）が組み直します。
//
// 何より大事なのは「黙って変えない」ことです。雨だからと勝手に
// 行き先を差し替えられたら、楽しみにしていた場所が消えます。
// 理由を添えて提案し、押されたときだけ組み直します。

import assert from "node:assert/strict";
import test from "node:test";

import { indoorness, pickIndoorAlternative, suggestReplan, applyReplan }
  from "../packages/core/src/replan.js";
import { makeTrip } from "../packages/core/src/trip.js";

const d = (s) => new Date(s);

const spot = (id, name, category, over = {}) => ({
  id, name, category, lat: 33.84, lng: 132.76,
  genres: [], description: `${name}です。`, fame_tier: "known", ...over,
});

/** 14時から16時に屋外スポットがある1日。 */
const ITIN = {
  days: [{ date: d("2026-09-12T09:00"), items: [
    { id: "a", kind: "spot", spotId: "s1",
      start: d("2026-09-12T10:00"), end: d("2026-09-12T11:00"),
      title: "松山城", place: spot("s1", "松山城", "城") },
    { id: "b", kind: "spot", spotId: "s2",
      start: d("2026-09-12T14:00"), end: d("2026-09-12T15:30"),
      title: "桂浜", place: spot("s2", "桂浜", "海岸") },
    { id: "c", kind: "spot", spotId: "s3",
      start: d("2026-09-12T16:00"), end: d("2026-09-12T17:00"),
      title: "展望台", place: spot("s3", "展望台", "展望台") },
  ] }],
};

/** 14時〜16時に雨。 */
const RAINY = {
  ok: true, date: "2026-09-12",
  rows: [14, 15, 16].map((h) => ({
    iso: `2026-09-12T${h}:00`, rain: 85, temp: 21, code: 61,
  })).concat([10, 11, 12, 13].map((h) => ({
    iso: `2026-09-12T${String(h).padStart(2, "0")}:00`, rain: 5, temp: 24, code: 1,
  }))),
};

const DRY = { ok: true, date: "2026-09-12",
  rows: Array.from({ length: 24 }, (_, h) => ({
    iso: `2026-09-12T${String(h).padStart(2, "0")}:00`,
    rain: 5, temp: 23, code: 1 })) };

const CANDIDATES = [
  spot("i1", "県立美術館", "美術館"),
  spot("i2", "郷土博物館", "博物館"),
  spot("i3", "道後温泉本館", "温泉"),
  spot("o1", "海岸公園", "海岸"),
];

// --- 屋内かどうか -----------------------------------------------------------

test("分類から、屋内・屋外を見分ける", () => {
  assert.ok(indoorness({ category: "美術館" }) > 0.8);
  assert.ok(indoorness({ category: "博物館" }) > 0.8);
  assert.ok(indoorness({ category: "海岸" }) < 0.2);
  assert.ok(indoorness({ category: "山" }) < 0.2);
  // 温泉は屋内寄り（露天もありますが、雨でも入れます）
  assert.ok(indoorness({ category: "温泉" }) > 0.6);
  // 知らない分類は、決めつけません
  const mid = indoorness({ category: "謎の分類" });
  assert.ok(mid > 0.2 && mid < 0.8);
});

// --- 雨を避ける -------------------------------------------------------------

test("雨の時間に入っている屋外スポットを見つけて、入れ替えを提案する", () => {
  const r = suggestReplan(ITIN, { weather: { 0: RAINY }, candidates: CANDIDATES });
  const rain = r.suggestions.filter((s) => s.kind === "rain");
  assert.ok(rain.length >= 1, "雨の提案が出ていません");
  const forBeach = rain.find((s) => s.spotId === "s2");
  assert.ok(forBeach, "雨の時間の海岸を見つけていません");
  assert.match(forBeach.text, /桂浜/);
  assert.match(forBeach.text, /雨|降水/);
  assert.ok(forBeach.alternative, "代わりの候補を出していません");
  assert.ok(indoorness(forBeach.alternative) > 0.6);
});

test("晴れの日には、何も提案しない", () => {
  const r = suggestReplan(ITIN, { weather: { 0: DRY }, candidates: CANDIDATES });
  assert.equal(r.suggestions.filter((s) => s.kind === "rain").length, 0);
});

test("雨でも、屋内のスポットは入れ替えない", () => {
  const indoor = { days: [{ date: d("2026-09-12T09:00"), items: [
    { id: "a", kind: "spot", spotId: "m1",
      start: d("2026-09-12T14:00"), end: d("2026-09-12T15:30"),
      title: "県立美術館", place: spot("m1", "県立美術館", "美術館") },
  ] }] };
  const r = suggestReplan(indoor, { weather: { 0: RAINY }, candidates: CANDIDATES });
  assert.equal(r.suggestions.filter((s) => s.kind === "rain").length, 0);
});

test("天気が分からない日には、天気の話をしない", () => {
  const r = suggestReplan(ITIN,
    { weather: { 0: { ok: false, reason: "先すぎます" } }, candidates: CANDIDATES });
  assert.equal(r.suggestions.filter((s) => s.kind === "rain").length, 0);
  assert.match(r.notes.join(""), /先すぎ|分かりません/);
});

// --- 日没 -------------------------------------------------------------------

test("日没より後に展望台が入っていたら、前に動かすよう提案する", () => {
  const late = { days: [{ date: d("2026-09-12T09:00"), items: [
    { id: "v", kind: "spot", spotId: "s3",
      start: d("2026-09-12T19:30"), end: d("2026-09-12T20:15"),
      title: "展望台", place: spot("s3", "展望台", "展望台") },
  ] }] };
  const r = suggestReplan(late, {
    weather: {}, candidates: CANDIDATES,
    sunset: { 0: d("2026-09-12T18:12") },
  });
  const s = r.suggestions.find((x) => x.kind === "sunset");
  assert.ok(s, "日没の提案が出ていません");
  assert.match(s.text, /日没|暗/);
  assert.match(s.text, /18:12/);
});

test("日没前に着く展望台には、何も言わない", () => {
  const r = suggestReplan(ITIN, {
    weather: {}, candidates: CANDIDATES,
    sunset: { 0: d("2026-09-12T18:12") },
  });
  assert.equal(r.suggestions.filter((s) => s.kind === "sunset").length, 0);
});

// --- 混雑 -------------------------------------------------------------------

test("混みやすい時間に入っている有名どころは、朝いちを提案する", () => {
  const noon = { days: [{ date: d("2026-09-13T09:00"), items: [   // 日曜
    { id: "x", kind: "spot", spotId: "f1",
      start: d("2026-09-13T12:00"), end: d("2026-09-13T13:30"),
      title: "有名な城", place: spot("f1", "有名な城", "城",
                                     { fame_tier: "major" }) },
  ] }] };
  const r = suggestReplan(noon, { weather: {}, candidates: CANDIDATES });
  const s = r.suggestions.find((x) => x.kind === "crowd");
  assert.ok(s, "混雑の提案が出ていません");
  assert.match(s.text, /有名な城/);
});

// --- 代わりの候補を選ぶ -----------------------------------------------------

test("代わりは、近くて屋内で、まだ旅程に入っていないものから選ぶ", () => {
  const alt = pickIndoorAlternative(spot("s2", "桂浜", "海岸"), CANDIDATES,
                                    { exclude: new Set(["i1"]) });
  assert.ok(alt);
  assert.notEqual(alt.id, "i1", "除外したものを選んでいます");
  assert.ok(indoorness(alt) > 0.6);
});

test("屋内の候補が無ければ、無理に差し替えない", () => {
  const alt = pickIndoorAlternative(spot("s2", "桂浜", "海岸"),
                                    [spot("o1", "別の海岸", "海岸")], {});
  assert.equal(alt, null);
});

// --- 提案を条件に当てる -----------------------------------------------------

test("採用すると、外す場所と入れる場所が条件に入る", () => {
  const trip = makeTrip({ origin: { name: "東京駅", lat: 35.6, lng: 139.7 },
                          departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T21:00") });
  const r = suggestReplan(ITIN, { weather: { 0: RAINY }, candidates: CANDIDATES });
  const rain = r.suggestions.find((s) => s.kind === "rain");
  const next = applyReplan(trip, [rain]);
  assert.ok(next.must.avoidSpotIds.includes("s2"), "雨の屋外を外していません");
  assert.ok(next.must.spotIds.includes(rain.alternative.id),
    "代わりの場所を入れていません");
  // 元の条件は書き換えません
  assert.deepEqual(trip.must.avoidSpotIds, []);
});

test("日没・混雑の提案は、場所を差し替えない（順番の話だから）", () => {
  const trip = makeTrip({ origin: { name: "東京駅", lat: 35.6, lng: 139.7 },
                          departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T21:00") });
  const next = applyReplan(trip, [
    { kind: "sunset", spotId: "s3", apply: { pinFirst: "s3" } },
  ]);
  assert.deepEqual(next.must.avoidSpotIds, []);
  assert.ok(next.must.spotIds.includes("s3"));
});

test("提案が無ければ、条件は変わらない", () => {
  const trip = makeTrip({ origin: { name: "東京駅", lat: 35.6, lng: 139.7 },
                          departAt: d("2026-09-12T09:00"),
                          arriveBy: d("2026-09-12T21:00") });
  const next = applyReplan(trip, []);
  assert.deepEqual(next.must.spotIds, []);
  assert.deepEqual(next.must.avoidSpotIds, []);
});

test("旅程が空でも壊れない", () => {
  for (const bad of [null, undefined, {}, { days: [] }]) {
    const r = suggestReplan(bad, { weather: {}, candidates: [] });
    assert.ok(Array.isArray(r.suggestions));
  }
});

test("屋根があるとは限らないものを、雨の代わりに出さない", () => {
  // 高知の日曜市のように、屋外の市場もあります。「市場だから屋内」と
  // 決めつけて差し替えると、雨の中を歩かせることになります。
  const alt = pickIndoorAlternative(spot("s2", "桂浜", "海岸"),
    [spot("m1", "日曜市", "市場"), spot("s1", "商店街", "商店街")], {});
  assert.equal(alt, null, "屋根があるとは限らない場所を選んでいます");
});
