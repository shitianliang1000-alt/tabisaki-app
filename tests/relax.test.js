// 「できません」で終わらせない、の部分のテスト。
//
// 足りないのが何分なのかは計算できます。計算できることを
// 「できません」の一言で潰していないかを見ます。

import assert from "node:assert/strict";
import test from "node:test";

import { critique, relaxForItinerary, relaxForUnreachable } from "../packages/core/src/relax.js";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip, PlanError } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";

const kb = await loadKnowledgeBase();
const tokyo = findPlace("東京駅");

function dayTrip(note = "四国の有名な観光地を巡りたい") {
  return makeTrip({
    origin: tokyo, note, budgetYen: 999999,
    departAt: new Date("2026-09-05T09:00"),
    arriveBy: new Date("2026-09-05T19:00"),
  });
}

test("届かないときは、あと何分足りないかを言う", () => {
  const trip = dayTrip();
  const opts = relaxForUnreachable({
    trip, areaTerm: "四国",
    rejected: [{ region: { name: "高松" }, oneWay: 330, toEnd: 330, need: 705 }],
  });
  const extend = opts.find((o) => o.id === "extend");
  assert.ok(extend, "延長の提案がありません");
  assert.match(extend.detail, /あと1時間45分足りません/);
  assert.ok(extend.apply.extendMinutes > 105);
});

test("延ばしても届かないほど遠いときは、延長を勧めない", () => {
  const opts = relaxForUnreachable({
    trip: dayTrip(), areaTerm: "沖縄",
    rejected: [{ region: { name: "那覇" }, oneWay: 900, toEnd: 900, need: 2000 }],
  });
  assert.equal(opts.find((o) => o.id === "extend"), undefined);
  assert.ok(opts.some((o) => o.id === "addNight"));
});

test("届かないときの提案は、必ず1つ以上ある", () => {
  const opts = relaxForUnreachable({
    trip: dayTrip(),
    rejected: [{ region: { name: "那覇" }, oneWay: 900, toEnd: 900, need: 2000 }],
  });
  assert.ok(opts.length >= 2);
  for (const o of opts) {
    assert.ok(o.label && o.detail && o.apply, `中身が欠けています: ${o.id}`);
  }
});

test("削ったときは、どれだけ延ばせば戻せるかを言う", () => {
  const opts = relaxForItinerary({
    trip: dayTrip(),
    checked: { dropped: [{}, {}], result: { slackMin: -20, underfilled: null } },
  });
  assert.ok(opts.some((o) => o.id === "extend"));
  assert.ok(opts.some((o) => o.id === "relaxPace"));
  assert.match(opts[0].detail, /2か所を外しました/);
});

test("予定が埋まらないときは、延ばすのではなく短くすると言う", () => {
  const opts = relaxForItinerary({
    trip: dayTrip(),
    checked: { dropped: [], result: { slackMin: 300,
      underfilled: { days: 3, plannedDays: 4, totalDays: 7 } } },
  });
  assert.ok(opts.some((o) => o.apply.shortenDays === 3));
  assert.ok(!opts.some((o) => o.apply.extendMinutes));
});

test("旅程の弱点は、AIではなく計算で出す", () => {
  const t = (h, m) => new Date(2026, 8, 5, h, m);
  const itin = {
    days: [{ items: [
      { kind: "transit", start: t(9, 0), end: t(11, 0), walk: false, km: 50 },
      { kind: "spot", start: t(11, 0), end: t(12, 0), place: { verified: false } },
      { kind: "meal", start: t(12, 0), end: t(13, 0) },
      { kind: "transit", start: t(13, 0), end: t(13, 20), walk: true, km: 1.4 },
      { kind: "spot", start: t(13, 20), end: t(14, 0), place: {} },
    ] }],
  };
  const notes = critique(itin);
  const move = notes.find((n) => n.key === "move");
  assert.match(move.text, /移動が約47%/);
  assert.equal(move.level, "warn");
  assert.match(notes.find((n) => n.key === "walk").text, /約1\.4km/);
  assert.match(notes.find((n) => n.key === "unverified").text, /1か所/);
});

test("行けないときのエラーは、直し方を持ち歩く", async () => {
  const fresh = await loadKnowledgeBase();
  await assert.rejects(
    () => planTrip({ kb: fresh, trip: dayTrip() }),
    (e) => {
      assert.ok(e instanceof PlanError, "PlanError ではありません");
      assert.ok(e.suggestions.length >= 2, "提案が入っていません");
      assert.ok(e.suggestions.some((s) => s.apply.addNights === 1));
      return true;
    });
});

test("組み上がった旅程にも、弱点と提案が付く", async () => {
  const fresh = await loadKnowledgeBase();
  const itin = await planTrip({ kb: fresh, trip: dayTrip("温泉でゆっくり癒されたい") });
  assert.ok(Array.isArray(itin.critique) && itin.critique.length >= 1);
  assert.ok(Array.isArray(itin.suggestions));
});
