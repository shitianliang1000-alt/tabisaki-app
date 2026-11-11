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
  available, choose, cleanName, clockOf, dms, labelLine, navitimeUnuse, orderFrom,
  otpBase, otpLine, providerStatus, readEkispert, readHere, readNavitime, readOtp, readQuery, readTransitous,
  searchAuto, transitHandler, TransitError,
} from "../server/transit.js";
import worker from "../server/worker.js";
import { classifyLine } from "../packages/core/src/modes.js";

// 手元の OTP 2.6（熊本の時刻表 6本）が実際に返した答え。tests/fixtures/otp-kumamoto.json
const otpKumamoto = JSON.parse(await readFile(new URL("./fixtures/otp-kumamoto.json", import.meta.url), "utf8"));
const transitousOdawara = JSON.parse(await readFile(
  new URL("./fixtures/transitous-odawara-hakone.json", import.meta.url), "utf8"));

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

test("使えるもの: キーが無ければ有料の API は使わない。Yahoo!と Transitous は止められる", () => {
  assert.equal(available("ekispert", {}), false);
  assert.equal(available("ekispert", { EKISPERT_API_KEY: "k" }), true);
  assert.equal(available("transitous", {}), true);
  assert.equal(available("transitous", { TRANSITOUS: "off" }), false);
  assert.equal(available("yahoo", { YAHOO_TRANSIT: "OFF" }), false);
});

test("順番: TRANSIT_ORDER で変えられ、知らない名前は捨てる", () => {
  assert.deepEqual(orderFrom({}), ["otp", "ekispert", "navitime", "here", "yahoo", "transitous"]);
  assert.deepEqual(orderFrom({ TRANSIT_ORDER: "transitous, nope ,yahoo" }), ["transitous", "yahoo"]);
  const st = providerStatus({ HERE_API_KEY: "x" });
  assert.equal(st.providers.find((p) => p.name === "here").available, true);
  assert.ok(!JSON.stringify(st).includes('"x"'));
});

test("自動: キーのあるものから順に試し、経路が無ければ次へ進む", async () => {
  const env = { HERE_API_KEY: "h", YAHOO_TRANSIT: "off" };
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

test("自動: 終電は、終電を探せるものだけに聞く", async () => {
  const env = { HERE_API_KEY: "h" };
  let asked = 0;
  const yahoo = async () => { asked++; return { routed: true, search: "last", minutes: 33 }; };
  const out = await searchAuto(Q({ search: "last" }), env, {
    fetch: async () => { throw new Error("呼ばれないはず"); }, yahoo });
  assert.equal(asked, 1);
  assert.equal(out.provider, "yahoo");
});

test("自動: 相手が断っても、次の API で引く", async () => {
  const env = { EKISPERT_API_KEY: "e", YAHOO_TRANSIT: "off" };
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
//  OpenTripPlanner（Issue #429）
// ---------------------------------------------------------------------------

const KUMAMOTO = {
  from: "熊本駅", to: "御代志",
  fromAt: { lat: 32.7899, lng: 130.6886 }, toAt: { lat: 32.884, lng: 130.745 },
  departAt: "2026-11-12T09:00:00+09:00",
};

test("OTP: OTP_URL を入れたときだけ使い、http(s) でない URL は使わない", () => {
  assert.equal(available("otp", {}), false);
  assert.equal(available("otp", { OTP_URL: "http://127.0.0.1:8080/" }), true);
  assert.equal(otpBase({ OTP_URL: "http://127.0.0.1:8080//" }), "http://127.0.0.1:8080");
  assert.equal(available("otp", { OTP_URL: "file:///etc/passwd" }), false);
  assert.equal(available("otp", { OTP_URL: "nope" }), false);
});

test("OTP: 徒歩→バス→鉄道→徒歩 を1本の経路として読む（本物の答え）", () => {
  const routes = readOtp(otpKumamoto);
  assert.equal(routes.length, 3);
  const r = routes[1];
  assert.deepEqual(r.legs.map((l) => l.vehicle), ["walk", "bus", "walk", "rail", "walk"]);
  assert.deepEqual(r.legs.map((l) => l.line), ["徒歩", "熊本電鉄バス C9-5", "徒歩", "熊本電鉄 本線", "徒歩"]);
  assert.equal(r.legs[0].from, "熊本駅");
  assert.equal(r.legs.at(-1).to, "御代志");
  assert.equal(r.departure, "09:23");
  assert.equal(r.arrival, "10:31");
  assert.equal(r.transfers, 1);
  assert.ok(r.distanceKm > 10 && r.distanceKm < 20);
  assert.ok(r.intermediateStops.includes("北熊本"));
  // 画面の見分けでも、バスと鉄道になる
  assert.equal(classifyLine(r.legs[1].line).kind, "bus");
  assert.notEqual(classifyLine(r.legs[3].line).kind, "bus");
});

test("OTP: 系統の番号だけを取り、事業者の名前を前に付ける", () => {
  assert.equal(otpLine({ longName: "C3-3：蓮台寺入口→熊本駅前→菊池温泉", agency: { name: "熊本電鉄バス" } }), "熊本電鉄バス C3-3");
  assert.equal(otpLine({ shortName: "A", agency: { name: "熊本市電" } }), "熊本市電 A");
  assert.equal(otpLine({ longName: "熊本市電 健軍線", agency: { name: "熊本市電" } }), "熊本市電 健軍線");
  assert.equal(otpLine({ agency: { name: "産交バス" } }), "産交バス");
});

test("OTP: 範囲の外・歩くだけの答えは「経路なし」にして、自動なら次へ進む", async () => {
  const outside = { data: { planConnection: { routingErrors: [{ code: "OUTSIDE_BOUNDS" }], edges: [] } } };
  const walkOnly = { data: { planConnection: { routingErrors: [], edges: [{ node: { numberOfTransfers: 0, legs: [
    { mode: "WALK", distance: 300, from: { name: "a" }, to: { name: "b" },
      start: { scheduledTime: "2026-11-12T09:00:00+09:00" }, end: { scheduledTime: "2026-11-12T09:05:00+09:00" } }] } }] } } };
  assert.deepEqual(readOtp(outside), []);
  assert.deepEqual(readOtp(walkOnly), []);
  const calls = [];
  const fetchStub = async (u, init) => {
    calls.push(String(u));
    if (new URL(String(u)).host === "otp.test") return new Response(JSON.stringify(outside), { status: 200 });
    return new Response(JSON.stringify(transitousOdawara), { status: 200 });
  };
  const out = await searchAuto(Q(), { OTP_URL: "http://otp.test", YAHOO_TRANSIT: "off" }, { fetch: fetchStub });
  assert.equal(out.routed, true);
  assert.equal(out.provider, "transitous");
  assert.deepEqual(out.tried.map((t) => t.provider), ["otp", "transitous"]);
  assert.match(calls[0], /^http:\/\/otp\.test\/otp\/gtfs\/v1$/);
});

test("OTP: 問い合わせは GraphQL の変数で送り、地名を文に埋め込まない", async () => {
  let sent = null;
  const fetchStub = async (u, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(otpKumamoto), { status: 200 }); };
  const out = await transitHandler({ ...KUMAMOTO, from: "熊本駅\"}", provider: "otp" }, { OTP_URL: "http://otp.test" }, { fetch: fetchStub });
  assert.equal(out.routed, true);
  assert.equal(out.provider, "otp");
  assert.equal(out.providerLabel, "OpenTripPlanner");
  assert.ok(!sent.query.includes("熊本"));
  assert.equal(sent.variables.origin.label, "熊本駅\"}");
  assert.deepEqual(sent.variables.origin.location.coordinate, { latitude: 32.7899, longitude: 130.6886 });
  assert.equal(sent.variables.dateTime.earliestDeparture, "2026-11-12T00:00:00.000Z");
  // いちばん早く着くもの（直通のバス 10:14 着）を選ぶ
  assert.equal(out.meta.arrival, "10:14");
});

test("OTP: 終電と、位置の無い問い合わせは断る（自動なら飛ばす）", async () => {
  await assert.rejects(transitHandler({ ...KUMAMOTO, search: "last", provider: "otp" }, { OTP_URL: "http://otp.test" }),
    (e) => e instanceof TransitError && e.code === "unsupported");
  await assert.rejects(transitHandler({ from: "a", to: "b", provider: "otp" }, { OTP_URL: "http://otp.test" }),
    (e) => e instanceof TransitError && e.code === "unsupported");
});

test("OTP: Node の中継（server/node-proxy.mjs）の /transit からも、手元の OTP を引ける", async () => {
  const { createServer } = await import("node:http");
  const { handler } = await import("../server/node-proxy.mjs");
  const listen = (srv) => new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv.address().port)));
  const fakeOtp = createServer((req, res) => {
    res.writeHead(req.url === "/otp/gtfs/v1" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(otpKumamoto));
  });
  const proxy = createServer(handler);
  const saved = { OTP_URL: process.env.OTP_URL, TRANSITOUS: process.env.TRANSITOUS };
  try {
    process.env.OTP_URL = `http://127.0.0.1:${await listen(fakeOtp)}`;
    process.env.TRANSITOUS = "off";
    const port = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${port}/transit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(KUMAMOTO),
    });
    const doc = await res.json();
    assert.equal(res.status, 200);
    assert.equal(doc.routed, true);
    assert.equal(doc.provider, "otp");
    assert.deepEqual(doc.tried, [{ provider: "otp", routed: true }]);
    // 名指しで設定の無い API を呼ぶと、わけ付きで断る
    const no = await fetch(`http://127.0.0.1:${port}/transit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...KUMAMOTO, provider: "here" }),
    });
    assert.equal(no.status, 503);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fakeOtp.close(); proxy.close();
  }
});
