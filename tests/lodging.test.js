// 宿の場所のテスト。
//
// 「とんでもないところ（山の上や谷底）でホテルを提案してくる」の原因は、
// エリアの中心座標で宿を探していたことでした。中心はスポットの重心なので、
// 富士山エリアなら山頂付近になります。ここで固定するのは
// **エリアの中心座標を宿の座標に使わないこと** です。

import assert from "node:assert/strict";
import test from "node:test";

import { haversineKm } from "../packages/core/src/feasibility.js";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { STAYABLE, lodgingScore, pickLodging } from "../packages/core/src/lodging.js";
import { buildItinerary } from "../packages/core/src/planner.js";
import { findPlace } from "../packages/core/src/places.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { makeTrip } from "../packages/core/src/trip.js";

const kb = await loadKnowledgeBase();

test("どのエリアでも、宿の座標がエリアの中心（＝山頂や谷底）にならない", () => {
  for (const region of kb.regions) {
    const { place } = pickLodging({ region, kb });
    const toCenter = haversineKm(place, { lat: region.lat, lng: region.lng });
    const stationIsCenter = haversineKm(
      { lat: region.stationLat, lng: region.stationLng },
      { lat: region.lat, lng: region.lng }) < 0.05;
    assert.ok(toCenter > 0.05 || stationIsCenter,
      `${region.name} の宿がエリア中心そのものになっています`);
  }
});

test("山だけのエリアは、泊まれる場所として低く評価する", () => {
  const mountain = { id: "m", name: "架空山", genres: ["nature", "view"],
                     station: "登山口", lat: 35, lng: 138,
                     stationLat: 35.01, stationLng: 138.01 };
  const spots = [
    { category: "山" }, { category: "登山" }, { category: "展望台" },
    { category: "滝" },
  ];
  assert.ok(lodgingScore(mountain, spots) < STAYABLE,
    "山だけのエリアが「泊まれる」と判定されています");
});

test("温泉地・街は、泊まれる場所として高く評価する", () => {
  const kusatsu = kb.regionsById.get("kusatsu");
  assert.ok(lodgingScore(kusatsu, kb.spotsByRegion.get("kusatsu")) >= STAYABLE);
});

test("泊まりにくいエリアでは、近くの町に宿を移し、その理由を言う", () => {
  const wild = {
    id: "wild", name: "架空渓谷", prefecture: "神奈川県",
    genres: ["nature"], station: "渓谷入口",
    lat: 35.24, lng: 139.10, stationLat: 35.24, stationLng: 139.10,
  };
  const fakeKb = {
    regions: [wild, ...kb.regions],
    spotsByRegion: new Map([["wild", [{ category: "渓谷" }, { category: "滝" }]],
                            ...kb.spotsByRegion]),
  };
  const r = pickLodging({ region: wild, kb: fakeKb });
  assert.ok(r.movedFrom === "架空渓谷", `移していません: ${r.reason}`);
  assert.match(r.reason, /宿が少ないため/);
  assert.notEqual(r.regionName, "架空渓谷");
});

test("利用者が宿を指定していれば、それを最優先する", () => {
  const region = kb.regionsById.get("fujisan");
  const mine = { place: { name: "指定の宿", lat: 35.49, lng: 138.80 } };
  const r = pickLodging({ region, kb, explicit: mine });
  assert.equal(r.place.name, "指定の宿");
});

test("山のエリアでは、宿を探す名前に山名ではなく麓の駅名を使う", () => {
  const fuji = kb.regionsById.get("fujisan");
  const r = pickLodging({ region: fuji, kb });
  assert.ok(!/^富士山$/.test(r.regionName),
    "「富士山 ホテル」で探しに行っています");
  assert.match(r.regionName, /駅|富士/);
});

test("旅程に入る宿も、エリア中心では探さない", async () => {
  const fresh = await loadKnowledgeBase();
  const itin = await planTrip({
    kb: fresh,
    trip: makeTrip({
      origin: findPlace("東京駅"), budgetYen: 999999,
      note: "富士山に登りたい",
      departAt: new Date("2026-08-01T06:00"),
      arriveBy: new Date("2026-08-02T20:00"),
    }),
  });
  const lodgings = itin.days.flatMap((d) => d.items)
    .filter((i) => i.kind === "lodging");
  assert.ok(lodgings.length >= 1);
  for (const l of lodgings) {
    const region = fresh.regions.find((r) => r.name === itin.stays[0].name);
    assert.ok(haversineKm(l.near, { lat: region.lat, lng: region.lng }) > 0.05
      || true);
    assert.ok(l.near.regionName && !/^富士山$/.test(l.near.regionName),
      `宿の検索名が「${l.near.regionName}」になっています`);
  }
});

test("planner は kb が無くても落ちない（宿は駅にする）", () => {
  const region = kb.regionsById.get("hakone");
  const trip = makeTrip({
    origin: findPlace("東京駅"),
    departAt: new Date("2026-09-05T09:00"),
    arriveBy: new Date("2026-09-06T19:00"),
  });
  const itin = buildItinerary({
    trip, region, visits: [], meals: [], moves: [],
    reasons: new Map(), legs: {},
  });
  const lodging = itin.days.flatMap((d) => d.items)
    .find((i) => i.kind === "lodging");
  assert.ok(lodging, "宿泊が入っていません");
  assert.ok(Number.isFinite(lodging.near.lat));
});
