// 乗り換え検索の API ごとの読み替え（server/transit.js）。
//
// どの API の答えも、これまでの /yahoo/transit と同じ形にそろうか、
// 自動の順番どおりに試すか、を確かめます。本物の API には行きません。
//
// Transitous の答えは本物を縮めたもの（tests/fixtures/transitous-odawara-hakone.json）、
// ほかの3つはキーが無いので、各社の仕様書に書かれた形で作った答えです。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  available, choose, cleanName, clockOf, clockOfSecs, dms, labelLine, navitimeUnuse, orderFrom,
  providerStatus, readEkispert, readHere, readLs8h, readNavitime, readQuery, readTransitous,
  searchAuto, searchWith, transitHandler, TransitError,
} from "../server/transit.js";
import worker from "../server/worker.js";
import { classifyLine } from "../packages/core/src/modes.js";

const transitousOdawara = JSON.parse(await readFile(
  new URL("./fixtures/transitous-odawara-hakone.json", import.meta.url), "utf8"));
// ls8h が実際に返した答え（東京→新宿。tests/fixtures/ls8h-tokyo-shinjuku.json）
const ls8hTokyoShinjuku = JSON.parse(await readFile(
  new URL("./fixtures/ls8h-tokyo-shinjuku.json", import.meta.url), "utf8"));

const Q = (over = {}) => readQuery({
  from: "小田原駅", to: "箱根湯本",
  fromAt: { lat: 35.2564, lng: 139.1556 }, toAt: { lat: 35.2329, lng: 139.1067 },
  departAt: "2026-10-30T10:00:00+09:00", ...over,
});

const okJson = (obj) => async () => new Response(JSON.stringify(obj), {
  status: 200, headers: { "Content-Type": "application/json" } });

test("時刻は、どの時差で来ても東京の HH:MM にする", () => {
  assert.equal(clockOf("2026-10-30T01:02:00Z"), "10:02");
  assert.equal(clockOf("2026-10-30T10:02:00+09:00"), "10:02");
  assert.equal(clockOf("bad"), null);
});

test("乗り物の呼び名を添えると、画面の見分け（classifyLine）でも同じになる", () => {
  for (const [kind, expect] of [["air", "air"], ["ferry", "ferry"], ["shinkansen", "shinkansen"],
    ["coach", "coach"], ["bus", "bus"], ["ropeway", "ropeway"], ["walk", "walk"]]) {
    assert.equal(classifyLine(labelLine("何か線", kind)).kind, expect, kind);
  }
  assert.equal(labelLine("東海道新幹線", "shinkansen"), "東海道新幹線");
});

test("ローマ字の添え書きを落とす", () => {
  assert.equal(cleanName("小田原 Odawara"), "小田原");
  assert.equal(cleanName("箱根湯本 Hakone-Yumoto"), "箱根湯本");
  assert.equal(cleanName("Paris Gare de Lyon"), "Paris Gare de Lyon");
});

test("Transitous: 本物の答えから、徒歩と電車の区間を取り出す", () => {
  const q = Q();
  const routes = readTransitous(transitousOdawara, q);
  assert.ok(routes.length >= 1);
  const r = routes[0];
  assert.equal(r.legs[0].line, "徒歩");
  assert.equal(r.legs[0].from, "小田原駅");
  const ride = r.legs.find((l) => l.kind === "ride");
  assert.equal(ride.from, "小田原");
  assert.equal(ride.to, "箱根湯本");
  assert.match(ride.departure, /^\d\d:\d\d$/);
  const out = choose(routes, q, { provider: "transitous" });
  assert.equal(out.routed, true);
  assert.ok(out.minutes > 0 && out.minutes < 120);
  assert.equal(out.provider, "transitous");
  assert.ok(Array.isArray(out.meta.legs) && !("vehicle" in out.meta.legs[0]));
});

test("駅すぱあと: 座標は「度.分.秒」で渡す", () => {
  assert.equal(dms(35.681236), "35.40.52.4");
  assert.equal(dms(139.767125), "139.46.1.6");
});

const EKISPERT = {
  ResultSet: { Course: [{
    Price: [{ kind: "FareSummary", Oneway: "1490" }],
    Route: {
      timeOnBoard: "120", transferCount: "1", distance: "4760",
      Point: [{ Station: { Name: "東京" } }, { Station: { Name: "名古屋" } }, { Station: { Name: "京都" } }],
      Line: [
        { Name: "ＪＲ東海道新幹線のぞみ", Type: "train",
          DepartureState: { Datetime: { text: "2026-10-30T10:00:00+09:00" } },
          ArrivalState: { Datetime: { text: "2026-10-30T11:36:00+09:00" } } },
        { Name: "ＪＲ東海道新幹線ひかり", Type: { text: "train" },
          DepartureState: { Datetime: { text: "2026-10-30T11:45:00+09:00" } },
          ArrivalState: { Datetime: { text: "2026-10-30T12:20:00+09:00" } } },
      ],
    },
  }] },
};

test("駅すぱあと: Course を読み、新幹線と運賃を拾う", () => {
  const [r] = readEkispert(EKISPERT);
  assert.equal(r.legs.length, 2);
  assert.equal(r.legs[0].from, "東京");
  assert.equal(r.legs[1].to, "京都");
  assert.equal(r.legs[0].departure, "10:00");
  assert.equal(r.legs[1].arrival, "12:20");
  assert.equal(r.transfers, 1);
  assert.equal(r.fareYen, 1490);
  assert.equal(r.distanceKm, 476);
  assert.equal(classifyLine(r.legs[0].line).kind, "shinkansen");
});

test("駅すぱあと: Line が1つだけ（配列でない）でも読める", () => {
  const one = structuredClone(EKISPERT);
  one.ResultSet.Course = one.ResultSet.Course[0];
  one.ResultSet.Course.Route.Line = one.ResultSet.Course.Route.Line[0];
  assert.equal(readEkispert(one)[0].legs.length, 1);
});

const NAVITIME = {
  items: [{
    summary: { move: { from_time: "2026-10-30T10:00:00+09:00", to_time: "2026-10-30T10:52:00+09:00",
      time: 52, transit_count: 0, distance: 15400, fare: { unit_0: 230 } } },
    sections: [
      { type: "point", name: "start" },
      { type: "move", move: "walk", from_time: "2026-10-30T10:00:00+09:00", to_time: "2026-10-30T10:05:00+09:00", line_name: "徒歩" },
      { type: "point", name: "京都駅前" },
      { type: "move", move: "local_bus", from_time: "2026-10-30T10:10:00+09:00", to_time: "2026-10-30T10:47:00+09:00",
        line_name: "京都市営バス205系統", transport: { name: "京都市営バス205系統" } },
      { type: "point", name: "金閣寺道" },
      { type: "move", move: "walk", from_time: "2026-10-30T10:47:00+09:00", to_time: "2026-10-30T10:52:00+09:00", line_name: "徒歩" },
      { type: "point", name: "goal" },
    ],
  }],
};

test("NAVITIME: sections の point と move を、乗り場つきの区間にする", () => {
  const q = Q({ from: "京都駅", to: "金閣寺" });
  const [r] = readNavitime(NAVITIME, q);
  assert.deepEqual(r.legs.map((l) => l.line), ["徒歩", "京都市営バス205系統", "徒歩"]);
  assert.equal(r.legs[0].from, "京都駅");
  assert.equal(r.legs[1].from, "京都駅前");
  assert.equal(r.legs.at(-1).to, "金閣寺");
  assert.equal(r.fareYen, 230);
  assert.equal(classifyLine(r.legs[1].line).kind, "bus");
});

test("NAVITIME: 外された乗り物を unuse に並べる", () => {
  assert.equal(navitimeUnuse({ al: 0, shin: 1, ex: 1, hb: 1, lb: 1, sr: 0 }), "domestic_flight.ferry");
  assert.equal(navitimeUnuse({ al: 1, shin: 1, ex: 1, hb: 1, lb: 1, sr: 1 }), "");
});

const HERE = {
  routes: [{ sections: [
    { type: "pedestrian", departure: { time: "2026-10-30T10:00:00+09:00", place: { name: "" } },
      arrival: { time: "2026-10-30T10:06:00+09:00", place: { name: "那覇空港" } } },
    { type: "transit", transport: { mode: "monorail", name: "ゆいレール", headsign: "てだこ浦西" },
      departure: { time: "2026-10-30T10:10:00+09:00", place: { name: "那覇空港" } },
      arrival: { time: "2026-10-30T10:22:00+09:00", place: { name: "県庁前" } } },
  ] }],
};

test("HERE: sections を読み、行き先を添える", () => {
  const q = Q({ from: "空港", to: "国際通り" });
  const [r] = readHere(HERE, q);
  assert.equal(r.legs[0].from, "空港");
  assert.equal(r.legs[1].line, "ゆいレール てだこ浦西行（モノレール）");
  assert.equal(classifyLine(r.legs[1].line).kind, "monorail");
});

test("選びかた: 外された乗り物を使う候補は採らない", () => {
  const q = Q({ modes: { al: 1, shin: 0, ex: 1, hb: 1, lb: 1, sr: 1 } });
  const out = choose(readEkispert(EKISPERT), q, { reason: "なし" });
  assert.equal(out.routed, false);
});

test("選びかた: 終電では、いちばん遅く出る便を採る", () => {
  const routes = [
    { departure: "22:56", arrival: "23:29", legs: [], summary: "a" },
    { departure: "22:58", arrival: "00:39", legs: [], summary: "b" },
  ];
  const out = choose(routes, Q({ search: "last" }));
  assert.equal(out.meta.departure, "22:58");
  assert.equal(out.waitMinutes, 0);
});

test("使えるもの: キーが無ければ有料の API は使わない。ls8h と Transitous は止められる", () => {
  assert.equal(available("ekispert", {}), false);
  assert.equal(available("ekispert", { EKISPERT_API_KEY: "k" }), true);
  assert.equal(available("transitous", {}), true);
  assert.equal(available("transitous", { TRANSITOUS: "off" }), false);
  assert.equal(available("ls8h", {}), true);
  assert.equal(available("ls8h", { LS8H: "OFF" }), false);
  assert.equal(available("yahoo", {}), false);
});

test("順番: TRANSIT_ORDER で変えられ、知らない名前は捨てる", () => {
  assert.deepEqual(orderFrom({}), ["own", "ekispert", "navitime", "here", "ls8h", "transitous"]);
  assert.deepEqual(orderFrom({ TRANSIT_ORDER: "transitous, nope ,ls8h" }), ["transitous", "ls8h"]);
  const st = providerStatus({ HERE_API_KEY: "x" });
  assert.equal(st.providers.find((p) => p.name === "here").available, true);
  assert.ok(!JSON.stringify(st).includes('"x"'));
});

test("自動: キーのあるものから順に試し、経路が無ければ次へ進む", async () => {
  const env = { HERE_API_KEY: "h", LS8H: "off" };
  const calls = [];
  const fetchStub = async (u) => {
    const url = String(u);
    calls.push(new URL(url).host);
    if (url.includes("hereapi")) return okJson({ routes: [] })();
    return okJson(transitousOdawara)();
  };
  const out = await searchAuto(Q(), env, { fetch: fetchStub });
  assert.deepEqual(calls, ["transit.router.hereapi.com", "api.transitous.org"]);
  assert.equal(out.provider, "transitous");
  assert.deepEqual(out.tried.map((t) => t.provider), ["here", "transitous"]);
});

test("自動: 終電は、終電を探せるものだけに聞く（ls8h が答える）", async () => {
  const env = { HERE_API_KEY: "h" };
  const calls = [];
  const fetchStub = async (u) => { calls.push(String(u)); return okJson(ls8hTokyoShinjuku)(); };
  const out = await searchAuto(Q({ search: "last" }), env, { fetch: fetchStub });
  assert.equal(out.provider, "ls8h");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /api\.transit\.ls8h\.com/);
  assert.match(calls[0], /type=last/);
});

test("自動: 相手が断っても、次の API で引く", async () => {
  const env = { EKISPERT_API_KEY: "e", LS8H: "off" };
  const fetchStub = async (u) => (String(u).includes("ekispert")
    ? new Response("no", { status: 429 }) : okJson(transitousOdawara)());
  const out = await searchAuto(Q(), env, { fetch: fetchStub });
  assert.equal(out.provider, "transitous");
  assert.equal(out.tried[0].error, "rate_limited");
});

test("名指し: 設定されていない API は 503 のわけ付きで断る", async () => {
  await assert.rejects(transitHandler({ ...Q(), from: "a", to: "b", provider: "navitime" }, {}),
    (e) => e instanceof TransitError && e.status === 503 && e.code === "not_configured");
});

test("問い合わせ: 出発地が無ければ 400", () => {
  assert.throws(() => readQuery({ to: "b" }), (e) => e.status === 400);
});

test("中継: /transit/providers は一覧を返し、キーの値は出さない", async () => {
  const ORIGIN = "https://tabisaki.example";
  const res = await worker.fetch(new Request(`${ORIGIN}/transit/providers`, {
    method: "POST", headers: { Origin: ORIGIN } }), { ALLOW_ORIGIN: ORIGIN, EKISPERT_API_KEY: "secret-123" });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes("secret-123"));
  assert.equal(JSON.parse(body).providers.find((p) => p.name === "ekispert").available, true);
});

test("中継: /transit は名指しの API で引いて、どれが答えたかを返す", async () => {
  const ORIGIN = "https://tabisaki.example";
  const real = globalThis.fetch;
  globalThis.fetch = okJson(transitousOdawara);
  try {
    const res = await worker.fetch(new Request(`${ORIGIN}/transit`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "transitous", from: "小田原駅", to: "箱根湯本",
        fromAt: { lat: 35.2564, lng: 139.1556 }, toAt: { lat: 35.2329, lng: 139.1067 },
        departAt: "2026-10-30T10:00:00+09:00" }),
    }), { ALLOW_ORIGIN: ORIGIN });
    const doc = await res.json();
    assert.equal(res.status, 200);
    assert.equal(doc.routed, true);
    assert.equal(doc.provider, "transitous");
    assert.equal(doc.providerLabel, "Transitous");
  } finally {
    globalThis.fetch = real;
  }
});

test("中継: 設定されていない API を名指しすると 503", async () => {
  const ORIGIN = "https://tabisaki.example";
  const res = await worker.fetch(new Request(`${ORIGIN}/transit`, {
    method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "ekispert", from: "a", to: "b" }),
  }), { ALLOW_ORIGIN: ORIGIN });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "NOT_CONFIGURED");
});

// ---------------------------------------------------------------------------
//  node-proxy 経由（手元の鍵・設定が中継にも効く）
// ---------------------------------------------------------------------------

test("node 経由: 鍵のない名指しは 503 で断る", async () => {
  const { createServer } = await import("node:http");
  const { handler } = await import("../server/node-proxy.mjs");
  const keys = ["OWN_ENGINE_DB", "EKISPERT_API_KEY", "NAVITIME_RAPIDAPI_KEY", "HERE_API_KEY", "TRANSIT_ORDER", "TRANSITOUS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  const proxy = createServer(handler);
  const port = await new Promise((ok) => proxy.listen(0, "127.0.0.1", () => ok(proxy.address().port)));
  try {
    const no = await fetch(`http://127.0.0.1:${port}/transit`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "a", to: "b", provider: "here" }),
    });
    assert.equal(no.status, 503);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    proxy.close();
  }
});

// ---------------------------------------------------------------------------
//  ls8h Transit API（#367。Yahoo! スクレイピングの置き換え）
// ---------------------------------------------------------------------------

test("ls8h: 秒数を HH:MM にする（深夜は 24 時台、前日の便は繰り上げる）", () => {
  assert.equal(clockOfSecs(9 * 3600 + 3 * 60), "09:03");
  assert.equal(clockOfSecs(86400 + 39 * 60), "24:39");
  assert.equal(clockOfSecs(-300), "23:55");
  assert.equal(clockOfSecs("x"), null);
});

test("ls8h: 本物の答えを読み、地点からの徒歩を区間に戻す", () => {
  const q = readQuery({
    from: "東京駅", to: "新宿駅",
    fromAt: { lat: 35.6812, lng: 139.7671 }, toAt: { lat: 35.6896, lng: 139.7006 },
    departAt: "2026-11-13T09:00:00+09:00",
  });
  const routes = readLs8h(ls8hTokyoShinjuku, q);
  assert.ok(routes.length >= 1);
  const r = routes[0];
  // accessWalkSecs の徒歩が先頭に入り、出発は地点（東京駅）からになる
  assert.equal(r.legs[0].vehicle, "walk");
  assert.equal(r.legs[0].from, "東京駅");
  assert.equal(r.departure, "09:02");
  const ride = r.legs.find((l) => l.vehicle !== "walk");
  assert.equal(ride.line, "山手線（外回り）");
  assert.equal(ride.from, "東京");
  const out = choose(routes, q, { provider: "ls8h" });
  assert.equal(out.routed, true);
  assert.equal(out.provider, "ls8h");
});

test("ls8h: 新幹線は shinkansen、特急は express に見分ける（modes で外せるように）", () => {
  const data = { journeys: [{
    departureSecs: 36000, arrivalSecs: 39600, durationSecs: 3600, transferCount: 0,
    legs: [
      { kind: "transit", routeName: "東海道新幹線", mode: "rail", trainType: "のぞみ",
        from: { id: "a", name: "東京" }, to: { id: "b", name: "名古屋" },
        departureSecs: 36000, arrivalSecs: 39600, headwayBased: false },
    ] }] };
  const [r] = readLs8h(data, Q());
  assert.equal(r.legs[0].vehicle, "shinkansen");
  const out = choose([r], Q({ modes: { al: 1, shin: 0, ex: 1, hb: 1, lb: 1, sr: 1 } }), {});
  assert.equal(out.routed, false);
});

test("ls8h: 位置が無いときは、名前から駅を探して ID で聞く", async () => {
  const calls = [];
  const fetchStub = async (u) => {
    const url = String(u);
    calls.push(url);
    if (url.includes("/places/suggest")) {
      return okJson({ places: [{ endpoint: "feed:stop1", name: "小田原" }] })();
    }
    return okJson(ls8hTokyoShinjuku)();
  };
  const q = readQuery({ from: "小田原駅", to: "箱根湯本", departAt: "2026-11-13T09:00:00+09:00" });
  const out = await searchWith("ls8h", q, {}, { fetch: fetchStub });
  assert.equal(out.routed, true);
  assert.equal(calls.filter((c) => c.includes("/places/suggest")).length, 2);
  const plan = calls.find((c) => c.includes("/plan"));
  assert.match(plan, /from=feed%3Astop1/);
});


test("ls8h: 終電の候補は、API が返したものをそのまま読みます", () => {
  const leg = (routeName, from, to, dep, arr) => ({
    kind: "transit", routeName, mode: "rail",
    from: { id: "a", name: from }, to: { id: "b", name: to },
    departureSecs: dep, arrivalSecs: arr, headwayBased: false,
  });
  const H = 3600;
  const data = { journeys: [
    { departureSecs: 24 * H + 46 * 60, arrivalSecs: 29 * H + 3 * 60,
      durationSecs: 15420, transferCount: 1,
      legs: [leg("山手線（外回り）", "東京", "田町", 24 * H + 46 * 60, 24 * H + 55 * 60),
             leg("山手線（外回り）", "田町", "新宿", 28 * H + 39 * 60, 29 * H + 3 * 60)] },
    { departureSecs: 24 * H + 40 * 60, arrivalSecs: 25 * H + 14 * 60,
      durationSecs: 2040, transferCount: 0,
      legs: [leg("中央線", "東京", "新宿", 24 * H + 40 * 60, 25 * H + 14 * 60)] },
  ] };
  // 候補の取捨はしません（Yahoo! の終電検索を ls8h に置き換えただけです）
  assert.equal(readLs8h(data, Q({ search: "last" })).length, 2);
  assert.equal(readLs8h(data, Q()).length, 2);
});
