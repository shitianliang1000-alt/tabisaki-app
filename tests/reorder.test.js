// 回る順と、いる時間を、こちらで決められるようにしたテスト。
//
// 並びは道順と混雑から決めています（crowd.js）。それでも「先に海へ
// 行きたい」は好みの問題で、プログラムには決められません。
// いる時間も、分類ごとの目安（美術館70分）が合わないことがあります。
//
// いちばん大事なのは、**指定に無いものを動かさない**ことです。
// 1か所動かしたら並びが全部変わる、では何が起きたのか分かりません。
// そして時刻は必ず組み直します（並べ替えただけで時刻を据え置くと、
// 開館前に着く旅程ができます）。

import assert from "node:assert/strict";
import test from "node:test";

import { applyChosenOrder, spreadCrowds } from "../packages/core/src/crowd.js";
import { makeTrip } from "../packages/core/src/trip.js";

const spot = (id, lat, over = {}) => ({
  id, name: id, category: "寺院", lat, lng: 135.0,
  dwell: 60, open: 9, close: 17, fee: 0, ...over,
});

test("指定が無ければ、並びは変わらない", () => {
  const list = [spot("a", 35.0), spot("b", 35.1), spot("c", 35.2)];
  assert.deepEqual(applyChosenOrder(list, []).map((s) => s.id),
                   ["a", "b", "c"]);
  assert.deepEqual(applyChosenOrder(list, ["a"]).map((s) => s.id),
                   ["a", "b", "c"]);
});

test("押された順を勝たせる", () => {
  const list = [spot("a", 35.0), spot("b", 35.1), spot("c", 35.2)];
  assert.deepEqual(
    applyChosenOrder(list, ["c", "b", "a"]).map((s) => s.id),
    ["c", "b", "a"]);
});

test("指定に無い場所は、その位置から動かない", () => {
  // b と d だけを入れ替えます。a と c はそのままの位置です。
  const list = [spot("a", 35.0), spot("b", 35.1), spot("c", 35.2),
                spot("d", 35.3)];
  assert.deepEqual(
    applyChosenOrder(list, ["d", "b"]).map((s) => s.id),
    ["a", "d", "c", "b"]);
});

test("その日に無い場所を指定されても、壊れない", () => {
  const list = [spot("a", 35.0), spot("b", 35.1)];
  assert.deepEqual(
    applyChosenOrder(list, ["z", "b", "a", "y"]).map((s) => s.id),
    ["b", "a"]);
});

test("日ごとに、その日のぶんだけ並べ替える", () => {
  // 1日目 a,b／2日目 c,d。2日目だけを入れ替えます。
  const list = [spot("a", 35.0), spot("b", 35.02),
                spot("c", 35.04), spot("d", 35.06)];
  const dayFloorById = new Map([["a", 0], ["b", 0], ["c", 1], ["d", 1]]);
  const out = spreadCrowds(list, {
    dayFloorById,
    start: { lat: 35.0, lng: 135.0 },
    baseByDay: [{ lat: 35.0, lng: 135.0 }, { lat: 35.04, lng: 135.0 }],
    useCrowd: false,
    orderedIds: ["d", "c"],
  });
  const ids = out.map((s) => s.id);
  // 1日目は自動の並びのまま、2日目だけが指定どおり
  assert.deepEqual(ids.slice(0, 2), ["a", "b"]);
  assert.deepEqual(ids.slice(2), ["d", "c"]);
});

test("条件に、回る順といる時間が入る", () => {
  const t = makeTrip({
    must: { orderedSpotIds: ["b", "a"], dwellById: { a: 120 } },
  });
  assert.deepEqual(t.must.orderedSpotIds, ["b", "a"]);
  assert.equal(t.must.dwellById.a, 120);
  // 既定では、どちらも空です（自動のまま）
  const d = makeTrip({});
  assert.deepEqual(d.must.orderedSpotIds, []);
  assert.deepEqual(d.must.dwellById, {});
});
