// 「荷物を預ける」を、その日の最初の一手として旅程に入れるテスト。
//
// 案は前から出していました（旅程の下の囲み）。ただ、現地では旅程の行を
// 上から追うので、下の囲みは読まれません。**朝いちに何をするかは、
// 旅程の側に書いていないと動けません。**
//
// 確かめたいのは3つです。
//   ・同じ宿にもう1泊する日には、何も入れない（部屋に置けます）
//   ・入れた10分は、あとの予定をずらさない（出発の前に置きます）
//   ・二度入れない（組み直しで何度も通ります）

import assert from "node:assert/strict";
import test from "node:test";

import { LUGGAGE_MIN, attachLuggage } from "../packages/core/src/luggage.js";

const d = (s) => new Date(s);

const spotItem = (id, name, category, start, mins = 60) => ({
  id, kind: "spot", spotId: id, title: name,
  start: d(start), end: new Date(d(start).getTime() + mins * 60000),
  place: { id, name, category, lat: 35.0, lng: 135.0 },
});

const lodging = (start, regionName = "松江") => ({
  id: `l-${start}`, kind: "lodging", title: "宿", start: d(start),
  end: d(start), near: { regionName },
});

/** 1泊2日。2日目は宿を出たあとに城へ寄ります。 */
const itinTwoDays = () => ({
  days: [
    { date: d("2026-09-12T09:00"), items: [
      spotItem("s1", "松江城", "城", "2026-09-12T10:00"),
      lodging("2026-09-12T19:00"),
    ] },
    { date: d("2026-09-13T09:00"), items: [
      spotItem("s2", "出雲大社", "神社", "2026-09-13T09:30"),
    ] },
  ],
});

test("宿を出たあとに立ち寄りがある日に、最初の一手を入れる", () => {
  const itin = itinTwoDays();
  assert.equal(attachLuggage(itin), 1);
  const first = itin.days[1].items[0];
  assert.equal(first.kind, "luggage");
  assert.match(first.title, /荷物を預ける/);
});

test("預ける時間は、出発の前に置く（あとの予定をずらさない）", () => {
  const itin = itinTwoDays();
  const wasStart = itin.days[1].items[0].start.getTime();
  attachLuggage(itin);
  const [step, spot] = itin.days[1].items;
  // もとの予定の時刻は動いていません
  assert.equal(spot.start.getTime(), wasStart);
  // 手数はその前に入ります
  assert.equal(step.end.getTime(), wasStart);
  assert.equal((step.end - step.start) / 60000, LUGGAGE_MIN.locker);
});

test("同じ宿にもう1泊する日には、何も入れない", () => {
  const itin = itinTwoDays();
  // 2日目の夜も同じ宿に泊まるなら、荷物は部屋に置いておけます
  itin.days[1].items.push(lodging("2026-09-13T19:00"));
  assert.equal(attachLuggage(itin), 0);
  assert.equal(itin.days[1].items[0].kind, "spot");
});

test("最後の日は、駅のロッカーを先に書く", () => {
  // 宿に預けると取りに戻ることになります。帰りに通る駅のほうが早いです。
  const itin = itinTwoDays();
  attachLuggage(itin);
  assert.match(itin.days[1].items[0].title, /ロッカー/);
  assert.match(itin.days[1].items[0].detail, /取りに戻る/);
});

test("土地が変わる日は、ロッカーか宅配（持って回らない）", () => {
  const itin = {
    days: [
      { date: d("2026-09-12T09:00"), items: [
        spotItem("s1", "松江城", "城", "2026-09-12T10:00"),
        lodging("2026-09-12T19:00"),
      ] },
      { date: d("2026-09-13T09:00"), items: [
        spotItem("s2", "石見銀山", "史跡", "2026-09-13T10:00"),
        // その日の夜は別の土地の宿
        lodging("2026-09-13T19:00", "大森"),
      ] },
      { date: d("2026-09-14T09:00"), items: [
        spotItem("s3", "出雲大社", "神社", "2026-09-14T10:00"),
      ] },
    ],
  };
  assert.equal(attachLuggage(itin), 2);
  // 2日目は松江から大森へ移ります。宿に預けたら取りに戻ることになるので、
  // ロッカーか宅配を先に書きます。
  assert.match(itin.days[1].items[0].title, /ロッカー/);
  assert.match(itin.days[1].items[0].detail, /宅配/);
  assert.match(itin.days[2].items[0].title, /ロッカー/);
});

test("同じ土地の別の宿に移る日は、宿のフロントに預けられる", () => {
  // 夕方そのまま受け取れます。取りに戻ることになりません。
  const itin = {
    days: [
      { date: d("2026-09-12T09:00"), items: [
        spotItem("s1", "松江城", "城", "2026-09-12T10:00"),
        lodging("2026-09-12T19:00", "松江"),
      ] },
      { date: d("2026-09-13T09:00"), items: [
        spotItem("s2", "出雲大社", "神社", "2026-09-13T10:00"),
        { ...lodging("2026-09-13T19:00", "松江"), title: "別の宿" },
      ] },
    ],
  };
  assert.equal(attachLuggage(itin), 1);
  assert.match(itin.days[1].items[0].title, /宿/);
  assert.equal((itin.days[1].items[0].end - itin.days[1].items[0].start) / 60000,
               LUGGAGE_MIN.hotel);
});

test("荷物がつらい行き先があれば、理由にそれを書く", () => {
  const itin = itinTwoDays();
  attachLuggage(itin);
  // 神社は石段や砂利道があります（luggage.js の表）
  assert.match(itin.days[1].items[0].reason, /出雲大社/);
});

test("二度入れない", () => {
  const itin = itinTwoDays();
  assert.equal(attachLuggage(itin), 1);
  assert.equal(attachLuggage(itin), 0);
  assert.equal(itin.days[1].items.filter((x) => x.kind === "luggage").length, 1);
});

test("泊まりでない旅程には、何も入れない", () => {
  const itin = { days: [{ date: d("2026-09-12T09:00"), items: [
    spotItem("s1", "松江城", "城", "2026-09-12T10:00"),
  ] }] };
  assert.equal(attachLuggage(itin), 0);
});
