// 荷物をどうするか、のテスト。
//
// 泊まりの旅で、旅程はたいてい「ホテル → 観光 → 観光 → ホテル」と
// 書かれます。でも実際には、チェックアウトのあとは荷物を持って
// 歩くことになります。スーツケースを引いて石段を登るのと、
// 手ぶらで登るのは別の旅です。
//
// ここは「どこで手放せるか」を出すだけです。実際の空き状況までは
// 分かりませんし、分からないものを分かると言わないこと。

import assert from "node:assert/strict";
import test from "node:test";

import { luggagePlanFor, needsLuggagePlan } from "../packages/core/src/luggage.js";

const d = (s) => new Date(s);
const spot = (id, name, category, over = {}) => ({
  id, name, category, lat: 35.3, lng: 139.5, ...over,
});

/** 1泊2日。2日目は宿を出てから観光して帰る。 */
const ITIN = {
  days: [
    { date: d("2026-09-12T09:00"), items: [
      { id: "a", kind: "spot", start: d("2026-09-12T10:00"),
        end: d("2026-09-12T11:00"), title: "寺", place: spot("s1", "寺", "寺院") },
      { id: "l", kind: "lodging", start: d("2026-09-12T19:00"),
        end: d("2026-09-12T20:00"), title: "鎌倉に宿泊",
        near: { lat: 35.32, lng: 139.55, regionName: "鎌倉" } },
    ] },
    { date: d("2026-09-13T09:00"), items: [
      { id: "b", kind: "spot", start: d("2026-09-13T10:00"),
        end: d("2026-09-13T11:30"), title: "山", place: spot("s2", "山", "山") },
      { id: "c", kind: "spot", start: d("2026-09-13T12:00"),
        end: d("2026-09-13T13:00"), title: "海岸",
        place: spot("s3", "海岸", "海岸") },
      { id: "t", kind: "transit", start: d("2026-09-13T13:00"),
        end: d("2026-09-13T15:00"), title: "東京駅へ" },
    ] },
  ],
};

const DAYTRIP = {
  days: [{ date: d("2026-09-12T09:00"), items: [
    { id: "a", kind: "spot", start: d("2026-09-12T10:00"),
      end: d("2026-09-12T11:00"), title: "寺", place: spot("s1", "寺", "寺院") },
  ] }],
};

test("日帰りなら、荷物の話はしない", () => {
  assert.equal(needsLuggagePlan(DAYTRIP), false);
  assert.deepEqual(luggagePlanFor(DAYTRIP).days, []);
});

test("泊まりで、宿のあとに観光があるなら、荷物の話をする", () => {
  assert.equal(needsLuggagePlan(ITIN), true);
  const p = luggagePlanFor(ITIN);
  assert.equal(p.days.length, 1);
  assert.equal(p.days[0].day, 1);          // 2日目
  assert.equal(p.days[0].spots.length, 2);
});

test("預け先の候補を出す（ホテル・駅のロッカー・手荷物預かり）", () => {
  const p = luggagePlanFor(ITIN);
  const kinds = p.days[0].options.map((o) => o.kind);
  assert.ok(kinds.includes("hotel"));
  assert.ok(kinds.includes("locker"));
  for (const o of p.days[0].options) {
    assert.ok(o.label && o.text);
  }
});

test("荷物を持ったままだと つらい場所を、名指しで挙げる", () => {
  const p = luggagePlanFor(ITIN);
  // 山と海岸は、スーツケースを引いて行くところではありません
  assert.ok(p.days[0].hard.some((h) => /山/.test(h.name)), JSON.stringify(p.days[0].hard));
});

test("屋内の街なかなら、つらい場所には挙げない", () => {
  const easy = {
    days: [ITIN.days[0], { date: d("2026-09-13T09:00"), items: [
      { id: "b", kind: "spot", start: d("2026-09-13T10:00"),
        end: d("2026-09-13T11:00"), title: "美術館",
        place: spot("m1", "美術館", "美術館") },
    ] }],
  };
  assert.deepEqual(luggagePlanFor(easy).days[0].hard, []);
});

test("そのまま読める一文を返す", () => {
  const p = luggagePlanFor(ITIN);
  assert.ok(p.summary.length > 0);
  assert.match(p.summary, /荷物/);
});

test("空でも壊れない", () => {
  for (const bad of [null, undefined, {}, { days: [] }]) {
    assert.ok(Array.isArray(luggagePlanFor(bad).days));
  }
});
