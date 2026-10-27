// 「明日晴れていて、東京に近いところ」のテスト（packages/core/src/sunny.js）。

import test from "node:test";
import assert from "node:assert/strict";
import { radiusFor, readWish, regionsWithin, skyOf, stripNear, wishScope } from "../packages/core/src/sunny.js";

test("晴れ・近いの頼みを読む", () => {
  assert.deepEqual(readWish("明日晴れている東京に近いところに行きたい"),
    { sunny: true, near: true, nearPlace: "東京" });
  assert.deepEqual(readWish("天気のいい近場で"), { sunny: true, near: true, nearPlace: null });
  assert.deepEqual(readWish("温泉でゆっくり"), { sunny: false, near: false, nearPlace: null });
  assert.equal(readWish("雨が降らないところ").sunny, true);
});

test("「東京に近い」の東京は、地名の絞り込みに渡さない", () => {
  const t = stripNear("明日晴れている東京に近いところに行きたい");
  assert.doesNotMatch(t, /東京/);
  assert.match(t, /晴れている/);
});

test("空の見込みは、晴れ・曇り・霧・雨に分ける", () => {
  assert.equal(skyOf(0, 5), "clear");
  assert.equal(skyOf(3, 20), "cloudy");
  assert.equal(skyOf(2, 60), "wet");
  assert.equal(skyOf(45, 10), "fog");
  assert.equal(skyOf(61, 80), "wet");
  assert.equal(skyOf(NaN, 0), "unknown");
});

const ORIGIN = { name: "東京駅", lat: 35.681, lng: 139.767 };
const REGIONS = [
  { id: "kamakura", lat: 35.319, lng: 139.55 },
  { id: "hakone", lat: 35.232, lng: 139.107 },
  { id: "nikko", lat: 36.75, lng: 139.6 },
  { id: "kyoto", lat: 35.01, lng: 135.77 },
];

test("日帰りは近くのエリアだけ。近いと書けば、もっと絞る", () => {
  assert.ok(radiusFor(0, true) < radiusFor(0, false));
  assert.ok(radiusFor(1, false) > radiusFor(0, false));
  const ids = regionsWithin(REGIONS, ORIGIN, radiusFor(0, false)).map((r) => r.id);
  assert.deepEqual(ids, ["kamakura", "hakone", "nikko"]);   // 京都は入らない
  const near = regionsWithin(REGIONS, ORIGIN, radiusFor(0, true)).map((r) => r.id);
  assert.deepEqual(near, ["kamakura", "hakone"]);           // 近いなら日光（約120km）も外す
});

/** Open-Meteo の返事の代わり。座標の順に、決めた天気を返します。 */
function fakeFetch(byLat) {
  return async (url) => {
    const lats = new URL(url).searchParams.get("latitude").split(",").map(Number);
    return { ok: true, json: async () => lats.map((lat) => ({ daily: byLat(lat) })) };
  };
}

test("晴れの見込みのエリアだけに絞り、そう伝える", async () => {
  const fetch = fakeFetch((lat) => lat < 35.25
    ? { weather_code: [0], precipitation_probability_max: [0] }
    : { weather_code: [63], precipitation_probability_max: [90] });
  const got = await wishScope({ sunny: true, near: false }, {
    regions: REGIONS, origin: ORIGIN, date: new Date(), nights: 0, fetch,
  });
  assert.deepEqual([...got.regionIds], ["hakone"]);
  assert.match(got.notes[0], /雨の降らない|晴れ/);
});

test("どこも雨なら、絞らずに近くから選び、雨と伝える", async () => {
  const fetch = fakeFetch(() => ({ weather_code: [63], precipitation_probability_max: [90] }));
  const got = await wishScope({ sunny: true, near: false }, {
    regions: REGIONS, origin: ORIGIN, date: new Date(), fetch,
  });
  assert.deepEqual([...got.regionIds].sort(), ["hakone", "kamakura", "nikko"]);
  assert.match(got.notes[0], /雨の予報/);
});

test("予報が取れなければ、晴れは見ずに組むと伝える", async () => {
  const fetch = async () => ({ ok: false });
  const got = await wishScope({ sunny: true, near: false }, {
    regions: REGIONS, origin: { ...ORIGIN, lat: 35.68 }, date: new Date(), fetch,
  });
  assert.equal(got.regionIds, null);
  assert.match(got.notes[0], /取れなかった/);
});
