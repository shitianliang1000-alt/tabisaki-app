// 外のデータの取り口（packages/core/src/providers.js）のテスト。
//
// 取り口ごとに「決まった形で返るか」「失敗が ProviderError にそろうか」
// 「切り替えたら本体がそれを使うか」を確かめます。キーも通信も要りません。

import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CODES, PROVIDER_KINDS, ProviderError, codeForStatus,
  createGsiGeocoding, createMockRouting, createMockSpots, createMockWeather,
  getProvider, listProviders, localGeocoding, normalizeGsi, offRouting,
  offWeather, registerProvider, resetProviders, toProviderError, useProvider,
  useProviders, yahooRouting,
} from "../packages/core/src/providers.js";

const TOKYO = { name: "東京駅", lat: 35.6812, lng: 139.7671 };
const HAKONE = { name: "箱根湯本駅", lat: 35.2325, lng: 139.1063 };

test("既定は、いまの取り口（Yahoo!・Open-Meteo・手元の収録・kb/）", () => {
  resetProviders();
  const all = listProviders();
  assert.deepEqual(Object.keys(all), [...PROVIDER_KINDS]);
  assert.equal(all.routing.active, "yahoo");
  assert.equal(all.weather.active, "open-meteo");
  assert.equal(all.geocoding.active, "local");
  assert.equal(all.spots.active, "kb");
  for (const k of PROVIDER_KINDS) {
    assert.ok(all[k].names.includes("mock") || k === "geocoding",
      `${k} に mock がありません`);
  }
});

test("切り替えると getProvider がそれを返し、元に戻せる", () => {
  useProvider("routing", "mock");
  assert.equal(getProvider("routing").name, "mock");
  useProviders({ weather: "off", geocoding: "gsi" });
  assert.equal(getProvider("weather").name, "off");
  assert.equal(getProvider("geocoding").name, "gsi");
  resetProviders();
  assert.equal(getProvider("routing").name, "yahoo");
});

test("登録の無い名前・種類・足りない関数は断る", () => {
  assert.throws(() => useProvider("routing", "no-such"), /登録されていません/);
  assert.throws(() => useProvider("ships", "x"), /種類が違います/);
  assert.throws(() => registerProvider({ kind: "routing", name: "half", search() {} }),
    /cooldown/);
  assert.throws(() => registerProvider({ kind: "weather" }), /name/);
});

test("自前の取り口を登録して使える（新しい乗り換えAPIはこの形で足す）", async () => {
  const mine = registerProvider({
    kind: "routing", name: "test-transit", available: true,
    async search(from, to) {
      return { routed: true, minutes: 42, summary: `${from.name}→${to.name}`,
        searchedAt: new Date(0).toISOString(), provider: "test-transit" };
    },
    cooldown: () => ({ waiting: false, seconds: 0, reason: "", retryable: false }),
    resetCooldown() {}, resetPace() {},
  });
  useProvider("routing", "test-transit");
  const r = await getProvider("routing").search(TOKYO, HAKONE);
  assert.equal(r.minutes, 42);
  assert.equal(getProvider("routing"), mine);
  resetProviders();
});

// --- 失敗の形 ----------------------------------------------------------------

test("HTTP の番号から、失敗の種類を決める", () => {
  assert.equal(codeForStatus(429), "rate_limited");
  assert.equal(codeForStatus(503), "upstream");
  assert.equal(codeForStatus(504), "timeout");
  assert.equal(codeForStatus(403), "rejected");
  assert.equal(codeForStatus(401), "not_configured");
});

test("どんな失敗も ProviderError にそろい、待てば通るかが分かる", () => {
  const rate = toProviderError(Object.assign(new Error("多すぎます"),
    { status: 429, retryAfter: 7, code: "RATE_LIMITED" }), "yahoo");
  assert.ok(rate instanceof ProviderError);
  assert.equal(rate.code, "rate_limited");
  assert.equal(rate.retryable, true);
  assert.equal(rate.retryAfter, 7);
  assert.equal(rate.status, 429, "呼ぶ側が見ている status を残す");
  assert.equal(rate.upstreamCode, "RATE_LIMITED");
  assert.equal(rate.provider, "yahoo");

  const forbidden = toProviderError(Object.assign(new Error("呼べません"),
    { status: 403, retryable: false }), "yahoo");
  assert.equal(forbidden.code, "rejected");
  assert.equal(forbidden.retryable, false);

  const offline = toProviderError(new TypeError("fetch failed"), "x");
  assert.equal(offline.code, "network");
  assert.equal(offline.retryable, true);

  const slow = toProviderError(Object.assign(new Error("応答なし"), { name: "TimeoutError" }));
  assert.equal(slow.code, "timeout");

  for (const e of [rate, forbidden, offline, slow]) {
    assert.ok(ERROR_CODES.includes(e.code));
  }
});

test("呼ぶ側の中止（AbortError）は、そのまま返す", () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(toProviderError(abort), abort);
});

// --- 経路 --------------------------------------------------------------------

test("mock の経路は、キー無しで決まった形を返す", async () => {
  const m = createMockRouting();
  const at = new Date("2030-04-01T09:00:00+09:00");
  const r = await m.search(TOKYO, HAKONE, { departAt: at });
  assert.equal(r.routed, true);
  assert.ok(r.minutes > r.rideMinutes, "待ち時間が入っていません");
  assert.equal(r.minutes, r.rideMinutes + r.waitMinutes);
  assert.ok(Array.isArray(r.meta.legs));
  assert.equal(r.searchedAt, at.toISOString());
  assert.equal(r.provider, "mock");
  assert.equal(r.byLocation, true);
  // 名前だけでも、収録の駅なら引けます。
  const byName = await m.search({ name: "新宿" }, { name: "東京駅" });
  assert.equal(byName.routed, true);
  assert.equal(m.asked.length, 2);
  // 分からない場所は「引けない」と答えます（投げません）。
  const none = await m.search({ name: "どこでもない" }, { name: "東京駅" });
  assert.equal(none.routed, false);
});

test("off の経路は聞かせない（available=false）、聞かれたら not_configured", async () => {
  assert.equal(offRouting.available, false);
  await assert.rejects(offRouting.search(TOKYO, HAKONE),
    (e) => e instanceof ProviderError && e.code === "not_configured" && !e.retryable);
});

test("Yahoo!の取り口は、中継の断りを ProviderError にして返す", async () => {
  yahooRouting.resetCooldown();
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 429, headers: { get: () => "3" },
    text: async () => JSON.stringify({ ok: false, error: {
      code: "RATE_LIMITED", service: "proxy", retryable: true,
      message: "呼び出しが多すぎます", retryAfter: 3 } }),
  });
  try {
    await assert.rejects(
      yahooRouting.search({ name: "新宿" }, { name: "箱根湯本" },
        { retryWaits: [], pace: false }),
      (e) => e instanceof ProviderError && e.code === "rate_limited"
        && e.status === 429 && e.retryable && e.provider === "yahoo");
    assert.equal(yahooRouting.cooldown().waiting, true);
  } finally {
    globalThis.fetch = real;
    yahooRouting.resetCooldown();
  }
});

test("Yahoo!の取り口の答えには、どこの答えかが付く", async () => {
  yahooRouting.resetCooldown();
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ routed: true, minutes: 90, summary: "10:08 発→ 11:30 着" }),
  });
  try {
    const r = await yahooRouting.search({ name: "新宿" }, { name: "箱根湯本" },
      { pace: false });
    assert.equal(r.provider, "yahoo");
    assert.equal(r.minutes, 90);
    assert.ok(r.searchedAt);
  } finally {
    globalThis.fetch = real;
  }
});

test("経路が使えない取り口なら、旅程の本体は聞きに行かず目安で組む", async () => {
  const { computeRoute, resetRoutesBreaker } = await import("../packages/core/src/routes.js");
  let calls = 0;
  registerProvider({
    kind: "routing", name: "test-off", available: false,
    async search() { calls++; return null; },
    cooldown: () => ({ waiting: false, seconds: 0, reason: "", retryable: false }),
    resetCooldown() {}, resetPace() {},
  });
  useProvider("routing", "test-off");
  try {
    resetRoutesBreaker();
    const r = await computeRoute([TOKYO, HAKONE],
      { mode: "TRANSIT", departAt: new Date("2030-04-01T09:00:00+09:00") });
    assert.equal(r.legs.length, 1);
    assert.equal(r.legs[0].routed, false, "目安のはずです");
    assert.ok(r.legs[0].minutes > 0);
    assert.equal(calls, 0, "使えない取り口に聞きに行っています");
  } finally {
    resetProviders();
  }
});

test("mock の経路に切り替えると、旅程の本体はその答えを使う", async () => {
  const { computeRoute, resetRoutesBreaker } = await import("../packages/core/src/routes.js");
  const mock = registerProvider(createMockRouting({ name: "test-mock" }));
  useProvider("routing", "test-mock");
  try {
    resetRoutesBreaker();
    await computeRoute([TOKYO, HAKONE],
      { mode: "TRANSIT", departAt: new Date("2030-04-02T09:00:00+09:00") });
    assert.ok(mock.asked.length >= 1, "選んだ取り口に聞いていません");
  } finally {
    resetProviders();
  }
});

// --- 天気 --------------------------------------------------------------------

test("mock の天気は、時間ごとの行を Forecast の形で返す", async () => {
  const f = await createMockWeather({ rain: 70 }).forecast(TOKYO,
    new Date("2030-04-01T09:00:00+09:00"));
  assert.equal(f.ok, true);
  assert.equal(f.rows.length, 24);
  assert.ok(f.rows[0].at instanceof Date);
  assert.equal(f.rows[12].rain, 70);
  const { summarizeDay } = await import("../packages/core/src/weather.js");
  assert.match(summarizeDay(f), /雨の可能性/);
});

test("off の天気は投げずに「分からない」を返す", async () => {
  const f = await offWeather.forecast(TOKYO, new Date());
  assert.equal(f.ok, false);
  assert.ok(f.reason);
});

// --- 地名 --------------------------------------------------------------------

test("手元の収録で、駅名から位置・位置から駅を引く", async () => {
  const [hit] = await localGeocoding.lookup("新宿");
  assert.equal(hit.name, "新宿駅");
  assert.equal(hit.source, "local");
  assert.deepEqual(await localGeocoding.lookup("どこでもない"), []);
  const near = await localGeocoding.reverse(35.681, 139.767);
  assert.equal(near.place.name, "東京駅");
});

test("国土地理院の応答を Place[] にそろえる（壊れた行は捨てる）", async () => {
  const fixture = [
    { geometry: { coordinates: [139.7671, 35.6812], type: "Point" },
      type: "Feature", properties: { addressCode: "", title: "東京駅" } },
    { geometry: { coordinates: [], type: "Point" }, properties: { title: "壊れた行" } },
    { geometry: { coordinates: [1, 2] }, properties: {} },
  ];
  assert.deepEqual(normalizeGsi(fixture),
    [{ name: "東京駅", lat: 35.6812, lng: 139.7671, source: "gsi" }]);
  assert.deepEqual(normalizeGsi({ error: true }), []);

  let asked = "";
  const gsi = createGsiGeocoding({
    fetchImpl: async (url) => { asked = url; return { ok: true, json: async () => fixture }; },
  });
  const r = await gsi.lookup("東京駅");
  assert.equal(r.length, 1);
  assert.match(asked, /msearch\.gsi\.go\.jp/);
  assert.match(asked, /q=%E6%9D%B1/);
});

test("国土地理院が断ったら、番号に合った ProviderError", async () => {
  const gsi = createGsiGeocoding({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(gsi.lookup("東京"),
    (e) => e instanceof ProviderError && e.code === "upstream" && e.provider === "gsi");
  const down = createGsiGeocoding({ fetchImpl: async () => { throw new TypeError("offline"); } });
  await assert.rejects(down.lookup("東京"), (e) => e.code === "network");
});

// --- スポット ------------------------------------------------------------------

test("mock の知識ベースは、渡した中身をそのまま返す", async () => {
  const kb = { regions: [{ id: "r1" }], spots: [] };
  assert.equal(await createMockSpots(kb).load(), kb);
});
