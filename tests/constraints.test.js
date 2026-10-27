// 絶対条件（hard constraint）と希望条件（soft constraint）の分離のテスト。
//
// 「静かな場所がいい」と「鎌倉大仏には必ず行く」を同じ重みで扱うと、
// 時間が足りなくなったときに、いちばん大事な予定から先に消えます。

import assert from "node:assert/strict";
import test from "node:test";

import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip, validateTrip } from "../packages/core/src/trip.js";
import { trimToFit } from "../packages/core/src/verify.js";

const BASE = { name: "鎌倉駅", lat: 35.3190, lng: 139.5500 };
const d = (s) => new Date(s);

function spot(id, over = {}) {
  return {
    id, name: id, category: "寺院", lat: 35.320, lng: 139.552,
    dwell: 90, open: 9, close: 17, fee: 0, ...over,
  };
}

test("時間が足りなくても、「必ず行く」は削られない", () => {
  const spots = [spot("a"), spot("b"), spot("c"), spot("d"), spot("e")];
  const ctx = {
    start: BASE, startAt: d("2026-09-05T10:00"),
    end: BASE, endBy: d("2026-09-05T15:00"), nights: 0,
    pinnedIds: ["e"],
  };
  const { spots: kept, dropped } = trimToFit(spots, ctx);
  assert.ok(dropped.length > 0, "そもそも削られていません（前提が崩れています）");
  assert.ok(kept.some((s) => s.id === "e"), "「必ず行く」が削られました");
  assert.ok(!dropped.some((s) => s.id === "e"));
});

test("「必ず行く」自体が営業時間に収まらないときは、黙って消さず理由を返す", () => {
  const closed = spot("night", { open: 22, close: 23.5 });
  const { conflicts, spots: kept } = trimToFit([spot("a"), closed], {
    start: BASE, startAt: d("2026-09-05T10:00"),
    end: BASE, endBy: d("2026-09-05T18:00"), nights: 0,
    pinnedIds: ["night"],
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].spotId, "night");
  assert.ok(conflicts[0].detail.length > 0);
  assert.ok(!kept.includes(closed) || true);   // 残っていても外れていてもよい
});

test("「必ず行く」が閉まったあとに着くなら、前の削ってよい場所を外して間に合わせる", () => {
  const shrine = spot("shrine", { close: 14 });
  const { result, conflicts, dropped } = trimToFit(
    [spot("a"), spot("b"), spot("c"), shrine], {
      start: BASE, startAt: d("2026-09-05T09:00"),
      end: BASE, endBy: d("2026-09-05T18:00"), nights: 0,
      pinnedIds: ["shrine"],
    });
  assert.ok(result.visits.some((v) => v.spot.id === "shrine"),
    `「必ず行く」が入っていません: ${result.visits.map((v) => v.spot.id).join("、")}`);
  assert.equal(conflicts.length, 0);
  assert.ok(dropped.length > 0 && !dropped.some((s) => s.id === "shrine"));
});

test("「必ず行く」と「行かない」に同じ場所は入れられない", () => {
  const trip = makeTrip({
    origin: findPlace("東京駅"),
    departAt: d("2026-09-05T09:00"), arriveBy: d("2026-09-05T19:00"),
    must: { spotIds: ["kamakura-2"], avoidSpotIds: ["kamakura-2"] },
  });
  assert.ok(validateTrip(trip).some((e) => /両方/.test(e)));
});

test("「必ず行く」を指定すると、そのエリアが選ばれる", async () => {
  const kb = await loadKnowledgeBase();
  const daibutsu = kb.spots.find((s) => s.name.includes("鎌倉大仏"));
  const itin = await planTrip({
    kb,
    trip: makeTrip({
      origin: findPlace("東京駅"), budgetYen: 999999,
      note: "温泉でゆっくり癒されたい",       // 本来なら草津や箱根が選ばれる希望
      departAt: d("2026-09-05T09:00"), arriveBy: d("2026-09-05T19:00"),
      must: { spotIds: [daibutsu.id] },
    }),
  });
  const names = itin.days.flatMap((x) => x.items)
    .filter((i) => i.kind === "spot").map((i) => i.title);
  assert.ok(names.includes(daibutsu.name),
    `「必ず行く」が入っていません: ${names.join("、")}`);
});

test("「行かない」に入れた場所は選ばれない", async () => {
  const kb = await loadKnowledgeBase();
  const daibutsu = kb.spots.find((s) => s.name.includes("鎌倉大仏"));
  const itin = await planTrip({
    kb,
    trip: makeTrip({
      origin: findPlace("東京駅"), budgetYen: 999999,
      note: "鎌倉で歴史ある街を歩きたい",
      departAt: d("2026-09-05T09:00"), arriveBy: d("2026-09-05T19:00"),
      must: { avoidSpotIds: [daibutsu.id] },
    }),
  });
  const names = itin.days.flatMap((x) => x.items)
    .filter((i) => i.kind === "spot").map((i) => i.title);
  assert.ok(!names.includes(daibutsu.name), "「行かない」が入っています");
});

test("「必ず行く」が地名の指定を上回ったときは、その理由を書く", async () => {
  const kb = await loadKnowledgeBase();
  const daibutsu = kb.spots.find((s) => s.name.includes("鎌倉大仏"));
  const itin = await planTrip({
    kb,
    trip: makeTrip({
      origin: findPlace("東京駅"), budgetYen: 999999,
      note: "京都のお寺をめぐりたい",
      departAt: d("2026-09-05T09:00"), arriveBy: d("2026-09-05T19:00"),
      must: { spotIds: [daibutsu.id] },
    }),
  });
  assert.match(itin.warnings.join("\n"), /必ず行く/);
});
