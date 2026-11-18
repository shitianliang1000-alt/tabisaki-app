// 自前のバス時刻表（server/bus.js）の試験。
//
// 小さな時刻表（tools/build_bus_timetable.py が作る形）を手で組み、
// 1本で行ける便・1回乗り換え・運休日・24 時を過ぎた便・出典の表記・
// 外から /__bus/ が見えないことを確かめます。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import worker from "../server/worker.js";
import { clearBusCache, earliestTrip, hm, jstParts, runs, searchBus } from "../server/bus.js";
import { transitHandler, TransitError } from "../server/transit.js";

const A = { lat: 34.0, lng: 133.0 };
const B = { lat: 34.006, lng: 133.006 };
const C = { lat: 34.021, lng: 133.021 };
const D = { lat: 34.031, lng: 133.031 };
const T = (p) => `${Math.floor(p.lat * 50)}_${Math.floor(p.lng * 50)}`;

const DATA = {
  "index.json": { version: 1, tile: 50, feeds: [
    { id: "t", name: "テストバス", license: "CC BY 4.0", publisher: "テスト交通", source: "テストの公開ページ" },
  ] },
  "t/cal.json": [{ d: 0b11111, s: 20260101, e: 20271231, rm: [20261123] }],
  "t/stops.json": [["駅前", A.lat, A.lng], ["市役所前", B.lat, B.lng], ["城下", C.lat, C.lng], ["温泉", D.lat, D.lng]],
  "t/p0.json": [
    { r: "1 城下線", v: "bus", s: [0, 1, 2], tt: [{ a: [0, 600, 1200], h: "城下", t: [[8 * 3600, 0], [24 * 3600 + 1800, 0]] }] },
    { r: "2 温泉線", v: "bus", s: [2, 3], tt: [{ a: [0, 900], h: "温泉", t: [[8 * 3600 + 1800, 0], [9 * 3600 + 1800, 0]] }] },
  ],
};
const tiles = {};
const put = (p, st, refs, name) => (tiles[`tiles/${T(p)}.json`] ??= []).push(["t", st, name, p.lat, p.lng, refs]);
put(A, 0, [[0, 0, 0]], "駅前");
put(B, 1, [[0, 0, 1]], "市役所前");
put(C, 2, [[0, 0, 2], [0, 1, 0]], "城下");
put(D, 3, [[0, 1, 1]], "温泉");
Object.assign(DATA, tiles);

const loader = async (p) => structuredClone(DATA[p] ?? null);
const q = (from, to, iso) => ({ from: "出発", to: "到着", fromAt: from, toAt: to, at: new Date(iso), search: "depart" });

test.beforeEach(() => clearBusCache());

test("日付と曜日: 東京の日付と、月=1…日=64 の旗", () => {
  const p = jstParts(new Date("2026-11-19T00:30:00+09:00")); // 木曜
  assert.equal(p.ymd, 20261119);
  assert.equal(p.bit, 1 << 3);
  assert.equal(p.secs, 1800);
  assert.equal(runs({ d: 0b11111, s: 20260101, e: 20271231, rm: [20261123] }, 20261123, 1), false);
  assert.equal(runs({ d: 0, s: 0, e: 0, add: [20261123] }, 20261123, 1), true);
  assert.equal(hm(25 * 3600 + 60), "25:01");
});

test("1本で行ける便: 次に乗れる便を選び、前後の徒歩を付ける", async () => {
  const r = await searchBus(loader, q(A, C, "2026-11-19T07:50:00+09:00"));
  assert.ok(r.length >= 1);
  const ride = r[0].legs.find((l) => l.vehicle === "bus");
  assert.equal(ride.departure, "08:00");
  assert.equal(ride.arrival, "08:20");
  assert.equal(ride.from, "駅前");
  assert.equal(ride.to, "城下");
  assert.match(ride.line, /テストバス 1 城下線 城下行/);
  assert.equal(r[0].legs[0].vehicle, "walk");
  assert.equal(r[0].legs[0].arrival, "08:00");
  assert.match(r[0].attribution, /テストバス（テスト交通・テストの公開ページ、CC BY 4.0）/);
});

test("1回乗り換え: 同じ停留所で、乗り継げる便に乗る", async () => {
  const r = await searchBus(loader, q(A, D, "2026-11-19T07:50:00+09:00"));
  const rides = r[0].legs.filter((l) => l.vehicle === "bus");
  assert.deepEqual(rides.map((l) => [l.from, l.departure, l.to, l.arrival]),
    [["駅前", "08:00", "城下", "08:20"], ["城下", "08:30", "温泉", "08:45"]]);
});

test("運休日（calendar_dates の抜く日）は便が無い", async () => {
  assert.deepEqual(await searchBus(loader, q(A, C, "2026-11-23T07:50:00+09:00")), []);
});

test("前の運行日の 24 時過ぎの便も使う", async () => {
  const r = await searchBus(loader, q(A, C, "2026-11-20T00:10:00+09:00"));
  const ride = r[0].legs.find((l) => l.vehicle === "bus");
  assert.equal(ride.departure, "00:30");
  assert.equal(ride.arrival, "00:50");
});

test("近すぎる・停留所が遠い・位置が無いときは答えない", async () => {
  assert.deepEqual(await searchBus(loader, q(A, { lat: 34.001, lng: 133.001 }, "2026-11-19T07:50:00+09:00")), []);
  assert.deepEqual(await searchBus(loader, q(A, { lat: 35.5, lng: 135.5 }, "2026-11-19T07:50:00+09:00")), []);
  assert.deepEqual(await searchBus(loader, { ...q(A, C, "2026-11-19T07:50:00+09:00"), toAt: null }), []);
});

test("earliestTrip: 出発順の便から、着くのがいちばん早いもの", () => {
  const pat = DATA["t/p0.json"][1];
  const days = [{ ymd: 20261119, bit: 1 << 3, shift: 0 }];
  assert.deepEqual(earliestTrip(pat, 0, 1, 8 * 3600 + 1801, days, DATA["t/cal.json"]),
    { dep: 9 * 3600 + 1800, arr: 9 * 3600 + 2700, head: "温泉" });
  assert.equal(earliestTrip(pat, 0, 1, 10 * 3600, days, DATA["t/cal.json"]), null);
});

test("POST /transit: provider bus で引け、出典が答えに付く", async () => {
  const env = { BUS_LOADER: loader };
  const out = await transitHandler({ from: "駅前", to: "温泉", fromAt: A, toAt: D,
    departAt: "2026-11-19T07:50:00+09:00", provider: "bus" }, env);
  assert.equal(out.routed, true);
  assert.equal(out.provider, "bus");
  assert.equal(out.providerLabel, "旅さきのバス時刻表");
  assert.equal(out.meta.transfers, 1);
  assert.match(out.attribution, /^時刻表: テストバス/);
  await assert.rejects(transitHandler({ from: "駅前", to: "温泉", provider: "bus" }, env), TransitError);
  await assert.rejects(transitHandler({ from: "駅前", to: "温泉", fromAt: A, toAt: D, provider: "bus" }, {}),
    (e) => e.code === "not_configured");
});

test("auto: ls8h・Transitous に無いバスでも、旅さきのバス時刻表の答えを選ぶ", async () => {
  const fetch = async () => new Response(JSON.stringify({ journeys: [], itineraries: [] }), { headers: { "Content-Type": "application/json" } });
  const out = await transitHandler({ from: "駅前", to: "城下", fromAt: A, toAt: C,
    departAt: "2026-11-19T07:50:00+09:00" }, { BUS_LOADER: loader }, { fetch });
  assert.equal(out.routed, true);
  assert.equal(out.provider, "bus");
  assert.ok(out.tried.some((t) => t.provider === "bus" && t.routed));
});

test("/__bus/ のデータは外から開けない（Worker が先に通り 404）", async () => {
  const ASSETS = { fetch: async (req) => new Response(`asset:${new URL(req.url).pathname}`) };
  const res = await worker.fetch(new Request("https://x.example.workers.dev/__bus/index.json"), { ASSETS });
  assert.equal(res.status, 404);
  const wr = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(wr, /"run_worker_first":\s*\[[^\]]*"\/__bus\/\*"/);
});

test("credits.html に、data/bus/index.json の時刻表が全部書かれている", async () => {
  const root = new URL("../", import.meta.url);
  const index = JSON.parse(await readFile(new URL("data/bus/index.json", root), "utf8"));
  const html = await readFile(new URL("credits.html", root), "utf8");
  assert.ok(index.feeds.length > 0);
  for (const f of index.feeds) {
    assert.ok(html.includes(`<li>${f.name}:`), `${f.name} が credits.html にありません（tools/build_bus_timetable.py を走らせる）`);
    assert.match(f.license, /^(CC BY 4\.0|CC0 1\.0|公共交通オープンデータ基本ライセンス)$/);
  }
});

test("Worker の入口は、数や文字を export しない（workerd が起動しなくなる）", async () => {
  const mod = await import("../server/worker.js");
  for (const [name, v] of Object.entries(mod)) {
    assert.ok(typeof v === "function" || (typeof v === "object" && v !== null),
      `server/worker.js の export ${name} は ${typeof v}（関数・クラス・オブジェクトだけにする）`);
  }
});
