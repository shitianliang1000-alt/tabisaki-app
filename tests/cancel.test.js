// 組み立ての「やめる」。
//
// AIや経路の呼び出しは、失敗すると目安に落ちて先へ進む作りです。
// やめるもその「失敗」に見えるので、signal を渡しただけでは止まらず、
// 最後まで走って旅程が出てきていました。段の切れ目で確かめているかを
// 固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";

const kb = await loadKnowledgeBase();

function trip() {
  return makeTrip({
    origin: findPlace("東京駅"),
    departAt: new Date("2026-11-13T08:00"),
    arriveBy: new Date("2026-11-13T19:00"),
    note: "温泉でゆっくり",
    interests: [],
    budgetYen: 999999,
  });
}

test("はじめからやめてあれば、旅程を作らずに止まる", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(planTrip({ trip: trip(), kb, signal: ctrl.signal }),
                       (e) => e?.name === "AbortError");
});

test("途中でやめても、旅程を返さずに止まる", async () => {
  const ctrl = new AbortController();
  const steps = [];
  const run = planTrip({
    trip: trip(), kb, signal: ctrl.signal,
    // 2段目（候補を選ぶ）に入ったところで、やめるを押します。
    onProgress: (step) => { steps.push(step); if (step === 2) ctrl.abort(); },
  });
  await assert.rejects(run, (e) => e?.name === "AbortError");
  assert.ok(steps.includes(2), `2段目まで進んでいません（${steps.join(",")}）`);
  assert.ok(!steps.includes(4), "やめたあとも経路の確認まで進んでいます");
});

test("やめなければ、これまでどおり旅程ができる", async () => {
  const ctrl = new AbortController();
  const itin = await planTrip({ trip: trip(), kb, signal: ctrl.signal });
  assert.ok(itin.days.length >= 1);
});
