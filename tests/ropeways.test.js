// 山頂のスポットとロープウェイ（packages/core/src/ropeways.js・packages/core/src/routes.js）。
//
// 大雪山の旅程（黒岳・北鎮岳・小泉岳・白雲岳）で、山頂どうしの区間を
// Yahoo!路線情報に何度も聞いて外し、問い合わせの回数を使い切って
// いました。43区間のうち10区間しか時刻が引けず、町なかの区間まで
// 「目安」になります。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { clearRouteCache, computeRoute, resetRoutesBreaker, resetTransitPacing }
  from "../packages/core/src/routes.js";
import { ropewayMinutes, ropewayNear, setRopewaysForTest } from "../packages/core/src/ropeways.js";
import { resetStopsCache } from "../packages/core/src/stops.js";

// 大雪山層雲峡・黒岳ロープウェイ（kb/ropeways.json と同じ形）。
const KURODAKE_RW = {
  name: "大雪山層雲峡黒岳ロープウェイ",
  base: { name: "山麓駅", lat: 43.7212, lng: 142.9461, alt: 664 },
  top: { name: "山頂駅", lat: 43.7108, lng: 142.9339, alt: 1297 },
  km: 1.54,
};

const SOUNKYO = { name: "層雲峡", lat: 43.7224, lng: 142.9478 };
const KURODAKE = { name: "黒岳", lat: 43.6975, lng: 142.9203, category: "山" };
const HOKUCHIN = { name: "北鎮岳", lat: 43.6928, lng: 142.8797, category: "山" };
const KAMIKAWA = { name: "上川駅", lat: 43.8466, lng: 142.7667 };

// 駅・バス停。層雲峡のバスターミナルと、上川駅。山頂の近くには無い。
const STOPS = [
  [43.8466, 142.7667, "上川"],
  [43.7226, 142.9476, "層雲峡"],
];

function withYahoo(reply, fn) {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("stops-rail")) {
      return { ok: true, json: async () => ({ year: 2008, stops: STOPS }) };
    }
    if (u.includes("stops-bus")) {
      return { ok: true, json: async () => ({ year: 2012, stops: [] }) };
    }
    const body = JSON.parse(init?.body ?? "{}");
    asked.push(body);
    const out = reply(body);
    const answer = (body.fromAt || body.toAt) && out && typeof out === "object"
      ? { byLocation: true, ...out } : out;
    return { ok: true, json: async () => answer };
  };
  setRopewaysForTest([KURODAKE_RW]);
  clearRouteCache();
  resetRoutesBreaker();
  resetTransitPacing();
  return fn(asked).finally(() => {
    globalThis.fetch = real;
    setRopewaysForTest(null);
    resetStopsCache();
    clearRouteCache();
  });
}

const BUS = {
  routed: true, minutes: 100, rideMinutes: 100, waitMinutes: 0,
  summary: "09:16 発→ 10:56 着 1時間40分",
  meta: {
    departure: "09:16", arrival: "10:56", transfers: 0, fareYen: 890,
    distanceKm: 30,
    legs: [{ from: "上川", to: "層雲峡", departure: "09:16", arrival: "10:56",
             minutes: 100, line: "道北バス 層雲峡線 層雲峡行" }],
  },
};

test("山頂の近くのロープウェイを見つける（麓からは勧めない）", async () => {
  setRopewaysForTest([KURODAKE_RW]);
  try {
    const rw = await ropewayNear(KURODAKE);
    assert.equal(rw?.name, KURODAKE_RW.name);
    assert.ok(rw.hikeKm > 1 && rw.hikeKm < 2.5, `山頂駅から${rw.hikeKm}km`);
    // 麓の温泉街は、山麓駅のほうが近いので勧めません。
    assert.equal(await ropewayNear(SOUNKYO), null);
    // 遠すぎる山にも勧めません。
    assert.equal(await ropewayNear({ lat: 43.66, lng: 142.85 }), null);
  } finally {
    setRopewaysForTest(null);
  }
});

test("ロープウェイの時間は、乗っている時間と待つ時間", () => {
  const t = ropewayMinutes(KURODAKE_RW);
  assert.equal(t.ride, 5);
  assert.ok(t.wait > 0);
  assert.equal(t.total, t.ride + t.wait);
});

test("山から山へは、Yahoo!に聞かずに登山道として組む", () =>
  withYahoo(() => ({ routed: false }), async (asked) => {
    const r = await computeRoute([KURODAKE, HOKUCHIN], {
      mode: "TRANSIT", departAt: new Date("2026-10-11T12:00:00+09:00"),
    });
    assert.equal(asked.length, 0, `山頂どうしを${asked.length}回聞いています`);
    const leg = r.legs[0];
    assert.equal(leg.walk, true);
    assert.equal(leg.trail, true);
    assert.match(leg.line, /登山道/);
    // 3.3kmを山道の速さ（時速2.2km）で。街の速さだと47分になります。
    assert.ok(leg.minutes >= 80, `${leg.minutes}分は速すぎます`);
  }));

test("麓から山頂へは、ロープウェイで上がる道として案内する", () =>
  withYahoo(() => ({ routed: false }), async (asked) => {
    const r = await computeRoute([SOUNKYO, KURODAKE], {
      mode: "TRANSIT", departAt: new Date("2026-10-11T11:00:00+09:00"),
    });
    // 乗り場（山麓駅）はバスターミナルのすぐ横なので、聞きません。
    assert.equal(asked.length, 0);
    const leg = r.legs[0];
    assert.match(leg.line, /大雪山層雲峡黒岳ロープウェイ（山麓駅→山頂駅）で上がり/);
    assert.match(leg.line, /黒岳まで歩いて約/);
    assert.equal(leg.ropeway.rides[0].direction, "up");
    // バスターミナルから山麓駅まで歩き、待って、乗って、山頂駅から歩く。
    const kinds = leg.transit.segments.map((s) => s.vehicleKind ?? s.kind);
    assert.deepEqual(kinds, ["walk", "wait", "ropeway", "walk"]);
  }));

test("遠くから山頂へは、ロープウェイの山麓駅までを聞く", () =>
  withYahoo((body) => (body.toAt ? BUS : { routed: false }), async (asked) => {
    const r = await computeRoute([KAMIKAWA, KURODAKE], {
      mode: "TRANSIT", departAt: new Date("2026-10-11T09:00:00+09:00"),
    });
    assert.equal(asked.length, 1, `${asked.length}回聞いています`);
    // 聞いた先は山頂ではなく、山麓駅の位置です。
    assert.match(asked[0].to, /ロープウェイ 山麓駅/);
    assert.equal(asked[0].toAt.lat, KURODAKE_RW.base.lat);
    const leg = r.legs[0];
    assert.equal(leg.routed, true);
    assert.match(leg.line, /09:16発→10:56着/);
    assert.match(leg.line, /ロープウェイ（山麓駅→山頂駅）で上がり/);
    // バスのあとに、ロープウェイと山道が続きます。
    const kinds = leg.transit.segments.map((s) => s.vehicleKind ?? s.kind);
    assert.deepEqual(kinds.slice(-3), ["wait", "ropeway", "walk"]);
    assert.ok(leg.minutes > 100 + 5, "ロープウェイと山道の時間を足していません");
  }));

test("ロープウェイの無い山は、無いと書いて最寄りの停留所から歩く", () =>
  withYahoo((body) => (body.toAt ? BUS : { routed: false }), async (asked) => {
    setRopewaysForTest([]);
    const r = await computeRoute([KAMIKAWA, HOKUCHIN], {
      mode: "TRANSIT", departAt: new Date("2026-10-11T09:00:00+09:00"),
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].to, "層雲峡", "最寄りの停留所で聞いていません");
    const leg = r.legs[0];
    assert.match(leg.line, /北鎮岳へ上がるロープウェイはありません/);
    assert.match(leg.line, /層雲峡から登山道を約/);
    assert.deepEqual(leg.ropeway.none, ["北鎮岳"]);
  }));

test("答えが「経路なし」だった区間は、聞き直しを短くする", () =>
  withYahoo(() => ({ routed: false }), async (asked) => {
    const A = { name: "寺A", lat: 43.8466, lng: 142.7667 };
    const B = { name: "寺B", lat: 43.7226, lng: 142.9476 };
    const C = { name: "寺C", lat: 43.8466, lng: 142.7667 };
    await computeRoute([A, B, C], {
      mode: "TRANSIT", departAt: new Date("2026-10-11T09:00:00+09:00"),
    });
    // 2区間 × 1回目3通りまで ＝ 6。聞き直しは「ぜんぶ外したとき」は
    // 走らないので、ここで増えていなければ倍にはなっていません。
    assert.ok(asked.length <= 6, `聞きすぎです（${asked.length}回）`);
  }));

test("収録のロープウェイは、山麓駅が山頂駅より低い", () => {
  const doc = JSON.parse(readFileSync(new URL("../kb/ropeways.json", import.meta.url)));
  assert.ok(doc.ropeways.length >= 50, `${doc.ropeways.length}本しかありません`);
  const kuro = doc.ropeways.find((r) => /黒岳/.test(r.name));
  assert.ok(kuro, "黒岳ロープウェイがありません");
  for (const r of doc.ropeways) {
    assert.ok(Number.isFinite(r.base.lat) && Number.isFinite(r.top.lat), r.name);
    if (r.base.alt != null && r.top.alt != null) {
      assert.ok(r.base.alt <= r.top.alt, `${r.name} の上下が逆です`);
    }
  }
});
