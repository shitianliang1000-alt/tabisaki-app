// バス停・駅・観光地のデータ配信 API（GET /v1/data/…。server/data-api.js・tools/data_api.mjs）。
//
// いちばん大事なのは「再配布できないものを出さない」ことです。収録の全件で
// 入れ物を作り、1件ずつ確かめます。そのうえで、道・問い合わせ・回数・鍵・版を見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import worker from "../server/worker.js";
import {
  _resetDataApiMemo, indexShardOf, parseQuery, publicProblem, serveDataApi, sha256Hex, tileOf, tilesForBox,
} from "../server/data-api.js";
import { buildDataset, gtfsStopItems, parseCsv, newKey } from "../tools/data_api.mjs";
import { createDataClient, DataApiError } from "../packages/core/src/data-client.js";

const W = "https://tabisaki.example.workers.dev";
const built = buildDataset({ now: new Date("2026-11-24T00:00:00Z") });
const manifest = built.files["manifest.json"];

/** 同梱のデータ（.site/__data/v1/）の代わり。 */
function assetsFrom(files) {
  return {
    async fetch(req) {
      const p = new URL(req.url).pathname;
      const m = /^\/__data\/v1\/(.+)$/.exec(p);
      if (m && files[m[1]] !== undefined) return new Response(JSON.stringify(files[m[1]]), { headers: { "Content-Type": "application/json" } });
      return new Response(null, { status: 404 });
    },
  };
}
const env = () => ({ ASSETS: assetsFrom(built.files) });
const get = async (path, e = env(), deps = {}, init = {}) => {
  _resetDataApiMemo();
  return serveDataApi(new Request(`${W}${path}`, init), e, deps);
};

test("入れ物: 収録の全件が、配ってよい出どころだけでできている", () => {
  let n = 0;
  for (const [path, v] of Object.entries(built.files)) {
    if (!/^(spots|stations|stops)\//.test(path)) continue;
    for (const it of v.items) {
      assert.equal(publicProblem(it), null, `${path} ${it.id}`);
      assert.notEqual(it.src, "kokudo", it.id);
      assert.equal("dataSource" in it, false, it.id);
      n++;
    }
  }
  assert.ok(built.report.spots > 30_000, `スポット ${built.report.spots}`);
  assert.ok(built.report.stations > 9_000, `駅 ${built.report.stations}`);
  assert.equal(n, built.report.spots + built.report.stations + built.report.stops);
  // 非商用（P11・P12・P27）は台帳にも出てこない
  assert.doesNotMatch(JSON.stringify(manifest.sources), /P11|P12|P27|観光資源|文化施設|バス停留所/);
  assert.ok(manifest.sources.kokudo_n02, "駅の出典（N02・商用可）");
  assert.match(manifest.excluded[0], /非商用/);
  // KV の無料枠（1日 1,000 回の書き込み）に1回で収まる
  assert.ok(built.report.keys < 1000, `鍵 ${built.report.keys}`);
});

test("入れ物: 非商用の印が付いた1件は通さない", () => {
  const base = { id: "x", name: "x", lat: 35, lng: 139, sources: ["wikidata"] };
  assert.equal(publicProblem(base), null);
  assert.match(publicProblem({ ...base, src: "kokudo" }), /非商用/);
  assert.match(publicProblem({ ...base, dataSource: "国土数値情報 文化施設" }), /dataSource/);
  assert.match(publicProblem({ ...base, sources: ["unknown"] }), /配れない/);
  assert.match(publicProblem({ ...base, sources: ["user"] }), /配れない/);
  assert.match(publicProblem({ ...base, sources: [] }), /出どころ/);
  assert.equal(publicProblem({ ...base, sources: ["gtfs:ryobi"] }), null);
});

test("入れ物: kb-private を読ませない・--exclude で出どころごと外せる", () => {
  assert.throws(() => buildDataset({ kbDir: "kb-private" }), /非商用/);
  const noYahoo = buildDataset({ exclude: ["yahoo"] });
  assert.ok(noYahoo.report.spots < built.report.spots);
  assert.ok(noYahoo.report.dropped.yahoo > 0);
  assert.equal(noYahoo.files["manifest.json"].sources.yahoo, undefined);
});

test("入れ物: GTFS は license.json のある時刻表だけ", () => {
  const root = mkdtempSync(join(tmpdir(), "gtfs-"));
  const ok = join(root, "ok"); const ng = join(root, "ng");
  mkdirSync(ok); mkdirSync(ng);
  const stops = "stop_id,stop_name,stop_lat,stop_lon,location_type\n1,\"駅前, 北口\",34.6655,133.9180,0\n2,本社,34.66,133.91,\n3,入口,34.6,133.9,2\n";
  writeFileSync(join(ok, "stops.txt"), stops); writeFileSync(join(ng, "stops.txt"), stops);
  writeFileSync(join(ok, "license.json"), JSON.stringify({ id: "demo", name: "見本バス", license: "CC BY 4.0", attribution: "見本バス（CC BY 4.0）" }));
  const r = gtfsStopItems([ok, ng]);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].name, "駅前, 北口");
  assert.deepEqual(r.items[0].sources, ["gtfs:demo"]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.ledger["gtfs:demo"].required, true);
  assert.equal(parseCsv("a,b\r\n\"x\"\"y\",2\r\n")[0].a, 'x"y');
});

test("道: 一覧（manifest）と出典の台帳", async () => {
  const res = await get("/v1/data");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  const body = await res.json();
  assert.equal(body.api, 1);
  assert.equal(body.version, manifest.version);
  assert.ok(body.datasets.spots.count > 30_000);
  assert.ok(body.endpoints.spots.startsWith(`${W}/v1/data/spots`));
  const attr = await (await get("/v1/data/attribution")).json();
  assert.ok(attr.sources.wikipedia.shareAlike);
});

test("道: near は近い順で、距離と出典のまとめが付く", async () => {
  const body = await (await get("/v1/data/spots?near=35.0037,135.7788&radius=2&limit=20")).json();
  assert.equal(body.dataset, "spots");
  assert.ok(body.count > 0 && body.count <= 20);
  for (let i = 1; i < body.items.length; i++) assert.ok(body.items[i - 1].distance_m <= body.items[i].distance_m);
  assert.ok(body.items.every((it) => it.distance_m <= 2000));
  assert.ok(body.license_summary.attribution.length > 0);
  // 使った出どころだけが並ぶ
  const used = new Set(body.items.flatMap((it) => it.sources));
  assert.deepEqual(body.license_summary.sources.map((s) => s.id).sort(), [...used].sort());
  if (body.total > 20) assert.match(body.next, /offset=20/);
});

test("道: 駅・県・1件・ページ送り", async () => {
  const st = await (await get("/v1/data/stations?near=35.6812,139.7671&radius=1")).json();
  assert.ok(st.items.some((s) => s.name === "東京"), st.items.map((s) => s.name).join(","));
  assert.ok(st.license_summary.attribution.some((a) => /国土数値情報/.test(a)));
  const pref = await (await get("/v1/data/spots?pref=47&limit=5")).json();
  assert.ok(pref.total > 100);
  assert.ok(pref.items.every((it) => it.pref === "47"));
  const p2 = await (await get("/v1/data/spots?pref=47&limit=5&offset=5")).json();
  assert.notEqual(p2.items[0].id, pref.items[0].id);
  const id = pref.items[0].id;
  const one = await (await get(`/v1/data/spots/${id}`)).json();
  assert.equal(one.item.id, id);
  assert.equal((await get("/v1/data/spots/nope-123")).status, 404);
  assert.equal((await get("/v1/data/stops?near=35.68,139.76")).status, 200);
});

test("道: 書きまちがい・広すぎる範囲・書き込みは断る", async () => {
  const code = async (p, init) => { const r = await get(p, env(), {}, init); return [r.status, (await r.json()).error?.code]; };
  assert.deepEqual(await code("/v1/data/spots"), [400, "need_area"]);
  assert.deepEqual(await code("/v1/data/spots?near=35,139&pref=13"), [400, "need_area"]);
  assert.deepEqual(await code("/v1/data/spots?near=35,139&foo=1"), [400, "unknown_param"]);
  assert.deepEqual(await code("/v1/data/spots?bbox=139,35,141,37"), [400, "bbox_too_large"]);
  assert.deepEqual(await code("/v1/data/spots?near=35,139&radius=50"), [400, "bad_radius"]);
  assert.deepEqual(await code("/v1/data/spots?near=10,10"), [400, "bad_near"]);
  assert.deepEqual(await code("/v1/data/stations?pref=13"), [400, "unknown_param"]);
  assert.deepEqual(await code("/v1/data/spots?pref=48"), [400, "bad_pref"]);
  assert.deepEqual(await code("/v1/data/spots?near=35,139&limit=9999"), [400, "bad_limit"]);
  assert.deepEqual(await code("/v1/data/nothing"), [404, "not_found"]);
  assert.deepEqual(await code("/v1/data/spots?near=35,139", { method: "POST", body: "{}" }), [405, "method_not_allowed"]);
  const pre = await get("/v1/data/spots", env(), {}, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("版: ETag が同じなら 304、データが無ければ 503", async () => {
  const first = await get("/v1/data/spots?pref=13&limit=1");
  const etag = first.headers.get("ETag");
  assert.equal(etag, `"${manifest.version}"`);
  const again = await get("/v1/data/spots?pref=13&limit=1", env(), {}, { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  const empty = await get("/v1/data", { ASSETS: assetsFrom({}) });
  assert.equal(empty.status, 503);
});

test("配る直前にも確かめる: タイルに混ざった配れない1件は返さない", async () => {
  const files = structuredClone(built.files);
  const t = tileOf(35.0037, 135.7788);
  files[`spots/${t}.json`].items.push({ id: "bad-1", name: "まざりもの", lat: 35.0037, lng: 135.7788, pref: "26", sources: ["wikidata"], src: "kokudo" });
  const body = await (await get("/v1/data/spots?near=35.0037,135.7788&radius=1&limit=500", { ASSETS: assetsFrom(files) })).json();
  assert.equal(body.items.some((it) => it.id === "bad-1"), false);
});

test("回数: 鍵なしと鍵ありで別の枠、超えたら 429 と Retry-After", async () => {
  const seen = [];
  const rate = async (who, limits) => { seen.push([who, limits.minute]); return { ok: false, retryAfter: 42 }; };
  const res = await get("/v1/data/spots?pref=13", env(), { rate, ip: "203.0.113.9" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "42");
  assert.deepEqual(seen[0], ["data|203.0.113.9", 60]);
});

test("鍵: KV に指紋があれば通り、無い・取り消しは 401。必須にもできる", async () => {
  const key = newKey();
  const hash = await sha256Hex(key);
  const kv = new Map([[`apikey:${hash}`, JSON.stringify({ name: "cli", perMinute: 1234 })]]);
  const DATA_KB = { async get(k, type) { const v = kv.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; } };
  const e = { ...env(), DATA_KB };
  const seen = [];
  const rate = async (who, limits) => { seen.push([who, limits.minute]); return { ok: true }; };
  const ok = await get("/v1/data/spots?pref=13&limit=1", e, { rate }, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen[0], [`datakey|${hash.slice(0, 16)}`, 1234]);
  const bad = await get("/v1/data/spots?pref=13", e, {}, { headers: { "X-API-Key": newKey() } });
  assert.equal(bad.status, 401);
  const need = await get("/v1/data/spots?pref=13", { ...e, DATA_API_REQUIRE_KEY: "1" });
  assert.equal((await need.json()).error.code, "key_required");
});

test("入れ物の場所: KV に manifest があれば KV だけを読む", async () => {
  const kvFiles = { "manifest.json": { ...manifest, version: "kv-1" } };
  for (const [k, v] of Object.entries(built.files)) if (k !== "manifest.json") kvFiles[k] = v;
  const DATA_KB = { async get(k, type) { const p = k.replace(/^v1\//, ""); return kvFiles[p] === undefined ? null : type === "json" ? kvFiles[p] : JSON.stringify(kvFiles[p]); } };
  const res = await get("/v1/data/spots?pref=1&limit=1", { ASSETS: assetsFrom({}), DATA_KB });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Data-Version"), "kv-1");
});

test("Worker: /v1/data に届き、同梱の置き場（/__data/）は外から 404", async () => {
  _resetDataApiMemo();
  const e = env();
  const ok = await worker.fetch(new Request(`${W}/v1/data/stations?near=35.6812,139.7671`), e, {});
  assert.equal(ok.status, 200);
  for (const p of ["/__data/v1/manifest.json", "/__data", "/__data/"]) {
    const res = await worker.fetch(new Request(`${W}${p}`), e, {});
    assert.equal(res.status, 404, p);
  }
});

test("タイルと索引", async () => {
  assert.equal(tileOf(35.6812, 139.7671), "71_279");
  assert.deepEqual(tilesForBox([139.4, 35.4, 139.6, 35.6]), ["70_278", "70_279", "71_278", "71_279"]);
  assert.match(await indexShardOf("takao-1"), /^[0-9a-f]$/);
  assert.throws(() => parseQuery(new URLSearchParams("near=35,139&radius=1&bbox=1,2,3,4"), "spots"), /どれか1つ/);
});

test("呼ぶ道具（CUI・アプリ）: 鍵を付け、304 を覚えたもので返し、失敗は DataApiError", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(init.headers);
    _resetDataApiMemo();
    const { Authorization, ...rest } = init.headers; // 鍵の確かめは上の試験で見ています
    return serveDataApi(new Request(url, { headers: rest }), env(), {});
  };
  const c = createDataClient({ base: W, key: "tbk_x", fetch });
  const a = await c.stations({ near: "35.6812,139.7671", radius: 1 });
  const b = await c.stations({ near: "35.6812,139.7671", radius: 1 });
  assert.deepEqual(a, b);
  assert.equal(calls[0].Authorization, "Bearer tbk_x");
  assert.equal(calls[1]["If-None-Match"], `"${manifest.version}"`);
  await assert.rejects(c.spots({}), (e) => e instanceof DataApiError && e.code === "need_area");
  const all = await c.all("spots", { pref: "47" }, 600);
  assert.equal(all.items.length, 600);
  assert.ok(all.license_summary.attribution.length > 0);
});
