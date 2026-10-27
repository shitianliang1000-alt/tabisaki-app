// 3案を出して、選べるようにするテスト。
//
// 旅行に「唯一の正解」はありません。同じ希望でも、ゆっくり2か所と
// 詰めて6か所では、向いている人が違います。1案だけ出して
// 「これが最適です」と言うより、3案並べて選んでもらうほうが正直です。
//
// ただし、**どれがおすすめかは言います**。3つ並べて放り出すのは、
// 選ぶ手間を押しつけているだけです。おすすめは score.js が決めます
// （AIには決めさせません）。

import assert from "node:assert/strict";
import test from "node:test";

import { VARIANTS, distinguishOf, recommendOf, summaryOf, tripsFor }
  from "../js/variants.js";
import { makeTrip } from "../packages/core/src/trip.js";

const d = (s) => new Date(s);
const TRIP = () => makeTrip({
  origin: { name: "東京駅", lat: 35.681, lng: 139.767 },
  departAt: d("2026-09-12T09:00"),
  arriveBy: d("2026-09-14T19:00"),
  interests: ["sea"],
});

test("3案ある（ゆったり・王道・探索）", () => {
  assert.deepEqual(Object.keys(VARIANTS), ["relaxed", "classic", "explore"]);
  for (const v of Object.values(VARIANTS)) {
    assert.ok(v.label && v.icon && v.blurb);
  }
});

test("案ごとに、条件が実際に変わる", () => {
  const t = TRIP();
  const list = tripsFor(t);
  assert.equal(list.length, 3);

  const by = Object.fromEntries(list.map((x) => [x.key, x.trip]));
  assert.equal(by.relaxed.pace, "relaxed");
  assert.equal(by.explore.pace, "packed");
  // 探索は穴場寄り、王道は定番寄り
  assert.ok(by.explore.hiddenBias > by.classic.hiddenBias,
    "探索のほうが穴場寄りになっていません");
  assert.ok(by.classic.hiddenBias <= 0.5);
});

test("元の条件は書き換えない", () => {
  const t = TRIP();
  tripsFor(t);
  assert.equal(t.pace, "balanced");
  assert.equal(t.hiddenBias, 0.5);
});

test("必ず行く場所や日程は、どの案でも変えない", () => {
  const t = makeTrip({
    origin: { name: "東京駅", lat: 35.681, lng: 139.767 },
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-14T19:00"),
    must: { spotIds: ["s1"] },
  });
  for (const { trip } of tripsFor(t)) {
    assert.deepEqual(trip.must.spotIds, ["s1"]);
    assert.equal(+trip.departAt, +t.departAt);
    assert.equal(+trip.arriveBy, +t.arriveBy);
  }
});

// --- おすすめを決める -------------------------------------------------------

const plan = (key, over = {}) => ({
  key,
  itin: {
    days: [{ date: d("2026-09-12T09:00"), items: [] }],
    spotCount: 0,
    score: { total: 60, fatigue: 40 },
    ...over,
  },
});

test("点がいちばん高い案を、おすすめにする", () => {
  const r = recommendOf([
    plan("relaxed", { score: { total: 82, fatigue: 20 } }),
    plan("classic", { score: { total: 61, fatigue: 45 } }),
    plan("explore", { score: { total: 55, fatigue: 70 } }),
  ]);
  assert.equal(r.key, "relaxed");
  assert.match(r.reason, /無理|ゆっくり|点/);
});

test("疲労が過密の案は、点が高くてもおすすめにしない", () => {
  // 「回れる数が多い＝良い」ではありません。人にはきつい旅程を
  // おすすめとして出すのは、無責任です。
  const r = recommendOf([
    plan("explore", { score: { total: 88, fatigue: 85 } }),
    plan("classic", { score: { total: 70, fatigue: 45 } }),
  ]);
  assert.equal(r.key, "classic");
});

test("全部が過密なら、そのなかで点が高いものを出しつつ、そう言う", () => {
  const r = recommendOf([
    plan("explore", { score: { total: 60, fatigue: 90 } }),
    plan("classic", { score: { total: 55, fatigue: 85 } }),
  ]);
  assert.equal(r.key, "explore");
  assert.match(r.reason, /きつい|過密|余裕/);
});

test("案がひとつでも、空でも壊れない", () => {
  assert.equal(recommendOf([plan("classic")]).key, "classic");
  assert.equal(recommendOf([]), null);
});

test("案ごとの見出し（何か所・移動・自由時間）を作れる", () => {
  const s = summaryOf({
    days: [{ date: d("2026-09-12T09:00"), items: [
      { kind: "spot", start: d("2026-09-12T10:00"), end: d("2026-09-12T11:30") },
      { kind: "transit", start: d("2026-09-12T11:30"), end: d("2026-09-12T12:00") },
      { kind: "free", start: d("2026-09-12T12:00"), end: d("2026-09-12T13:00") },
    ] }],
    spotCount: 1,
  });
  assert.match(s, /1か所/);
  assert.match(s, /移動/);
});

test("3案を作るとき、希望文の読み取りは1回でよい", async () => {
  // 変わるのはペースと穴場の割合だけで、希望文は同じです。
  // 案ごとに読み取り直すと、同じ文をモデルに3回投げることになります。
  const { loadKnowledgeBase } = await import("../packages/core/src/kb.js");
  const { planTrip } = await import("../packages/core/src/pipeline.js");
  const { findPlace } = await import("../packages/core/src/places.js");
  const kb = await loadKnowledgeBase();
  const base = makeTrip({
    origin: findPlace("東京駅"),
    departAt: d("2026-09-12T09:00"),
    arriveBy: d("2026-09-14T19:00"),
    note: "四国で海を見たい",
  });

  const first = await planTrip({ trip: base, kb, useWeather: false });
  assert.ok(first.query, "読み取り結果を持ち出していません");

  // 2案目以降は、その読み取りを渡して作れます
  const [, second] = tripsFor(base);
  const again = await planTrip({
    trip: second.trip, kb, useWeather: false,
    query: first.query, vector: first.vector,
  });
  assert.ok(again.days.length > 0);
});

// --- 3案の「違い」を、実際の旅程から拾う -----------------------------------
// 「ゆったり／王道／探索」という名前だけでは、何が違うのかが分かりません。
// 名前に付いた説明は「作る前の方針」であって、出来上がったものとは限りません。

/** 案を1つ組み立てる。移動の分数と、穴場の件数を指定します。 */
function planOf(key, { spots, moveMin, hidden = 0 }) {
  const items = [
    { kind: "transit", start: new Date(0), end: new Date(moveMin * 60000) },
    ...Array.from({ length: hidden }, () => ({
      kind: "spot", start: new Date(0), end: new Date(0),
      spot: { fame_tier: "hidden" },
    })),
  ];
  return { key, itin: { spotCount: spots, days: [{ items }] } };
}

test("移動がはっきり短い案には、そう書く", () => {
  const d = distinguishOf([
    planOf("relaxed", { spots: 3, moveMin: 120 }),
    planOf("classic", { spots: 3, moveMin: 200 }),
  ]);
  assert.equal(d.get("relaxed"), "移動がいちばん短い");
  assert.equal(d.has("classic"), false, "負けたほうにも何か書いています");
});

test("差がわずかなら、何も書かない", () => {
  // 5分の差で「いちばん短い」と書くと、選ぶ側を迷わせるだけです。
  const d = distinguishOf([
    planOf("relaxed", { spots: 3, moveMin: 120 }),
    planOf("classic", { spots: 3, moveMin: 125 }),
  ]);
  assert.equal(d.size, 0, `違いが無いのに書いています: ${[...d.values()]}`);
});

test("同じ案に、2つの札を付けない", () => {
  // 移動も短く、数も多い案。良いところは1つだけ言います。
  const d = distinguishOf([
    planOf("relaxed", { spots: 6, moveMin: 60 }),
    planOf("classic", { spots: 3, moveMin: 200 }),
  ]);
  assert.equal(d.get("relaxed"), "移動がいちばん短い");
  assert.equal(d.size, 1);
});

test("回れる数が多い案は、そう言う", () => {
  const d = distinguishOf([
    planOf("relaxed", { spots: 2, moveMin: 100 }),
    planOf("explore", { spots: 5, moveMin: 100 }),
  ]);
  assert.equal(d.has("relaxed"), false,
    "移動が同じなのに、移動の札が付いています");
  assert.equal(d.get("explore"), "いちばん多く回れる");
});

test("穴場の多さも見る", () => {
  const d = distinguishOf([
    planOf("classic", { spots: 3, moveMin: 100, hidden: 0 }),
    planOf("explore", { spots: 3, moveMin: 100, hidden: 3 }),
  ]);
  assert.equal(d.get("explore"), "穴場がいちばん多い");
});

test("案が1つしか無いときは、比べようがない", () => {
  assert.equal(distinguishOf([planOf("classic", { spots: 3, moveMin: 100 })]).size, 0);
  assert.equal(distinguishOf([]).size, 0);
  assert.equal(distinguishOf(null).size, 0);
});
