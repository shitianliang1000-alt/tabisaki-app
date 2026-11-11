// 非商用データ（国土数値情報 P11・P12・P27）を中継の中だけで使う仕組みの試験。
// 元データ（名前・座標）が答えに混ざらないことを、いちばん大事に見ます。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkUpload, MAX_VALUE_BYTES, packPrivateKb, privateKbHandler, privateStatus, putPrivate,
  radiusOf, spotListed, stopNear, storeFrom, tileOf,
} from "../server/private-kb.js";
import { dirStore } from "../server/private-kb-dir.mjs";
import { busStopNear, resetPrivateHintCache, spotListed as spotListedHint }
  from "../packages/core/src/private-hint.js";

// 実データではなく、試験用に作った架空の停留所・スポットです。
const busIndex = { tiles: [{ file: "stops-bus/35_138.json", lat: 35, lng: 138 }] };
const busTile = { stops: [[35.3601, 138.7270, "五合目バス停ダミー"], [35.9999, 138.9999, "境目ダミー"]] };
const spotsDoc = {
  shards: {
    "spots-jp19-yamanashi.json": [
      { name: "架空の滝", lat: 35.5, lng: 138.5, src: "kokudo" },
      { name: "音羽山ダミー寺", lat: 35.0, lng: 135.78, src: "kokudo" },
    ],
  },
};

function memStore(packed) {
  return {
    reads: 0,
    async get(key) {
      this.reads++;
      if (!packed.has(key)) return null;
      const v = packed.get(key);
      return { json: async () => structuredClone(v) };
    },
  };
}

const packed = packPrivateKb({
  busIndex, readBusTile: (f) => (f === "stops-bus/35_138.json" ? busTile : null), spotsDoc,
});

test("詰め直しは1度四方のタイルと manifest", () => {
  assert.deepEqual(packed.get("manifest.json").bus, ["35_138"]);
  assert.deepEqual(packed.get("manifest.json").spots, ["35_135", "35_138"]);
  assert.equal(packed.get("manifest.json").counts.bus, 2);
  assert.equal(packed.get("bus/35_138.json").length, 2);
  assert.equal(tileOf(35.99, 138.01), "35_138");
});

test("バス停が半径内にあるか（true/false だけ）", async () => {
  const store = memStore(packed);
  assert.deepEqual(await stopNear(store, { lat: 35.362, lng: 138.728, km: 1 }),
    { available: true, within: true });
  assert.deepEqual(await stopNear(store, { lat: 35.40, lng: 138.80, km: 1 }),
    { available: true, within: false });
  // 範囲外の座標は聞きません
  assert.deepEqual(await stopNear(store, { lat: 0, lng: 0, km: 1 }),
    { available: true, within: false });
});

test("タイルの境目をまたいでも見つかる", async () => {
  const store = memStore(packed);
  // 36_139 側から、35_138 の端（35.9999,138.9999）を探す
  assert.equal((await stopNear(store, { lat: 36.0005, lng: 139.0005, km: 0.5 })).within, true);
});

test("半径は決まった値に丸める", () => {
  assert.equal(radiusOf(0.3), 0.5);
  assert.equal(radiusOf(1), 1);
  assert.equal(radiusOf(1.2), 1.5);
  assert.equal(radiusOf(999), 5);
  assert.equal(radiusOf("x"), 1);
});

test("名前の裏取り（近くに同じ名前があるか）", async () => {
  const store = memStore(packed);
  assert.equal((await spotListed(store, { name: "架空の滝", lat: 35.505, lng: 138.505 })).listed, true);
  assert.equal((await spotListed(store, { name: "ダミー寺", lat: 35.0, lng: 135.78 })).listed, true);
  // 名前が同じでも遠ければ別もの
  assert.equal((await spotListed(store, { name: "架空の滝", lat: 35.7, lng: 138.5 })).listed, false);
  assert.equal((await spotListed(store, { name: "滝", lat: 35.5, lng: 138.5 })).listed, false);
});

test("入れ物が無い・manifest が無いときは available:false", async () => {
  assert.deepEqual(await privateKbHandler("/stops/near", { lat: 35.36, lng: 138.72 }, {}),
    { available: false, within: false });
  const empty = memStore(new Map());
  assert.deepEqual(await privateKbHandler("/spots/check", { name: "架空の滝", lat: 35.5, lng: 138.5 },
    { PRIVATE_KB: empty }), { available: false, listed: false });
});

test("答えに元データ（名前・座標）が入らない", async () => {
  const env = { PRIVATE_KB: memStore(packed) };
  const answers = [
    await privateKbHandler("/stops/near", { lat: 35.362, lng: 138.728, km: 5 }, env),
    await privateKbHandler("/spots/check", { name: "架空の滝", lat: 35.5, lng: 138.5 }, env),
  ];
  assert.deepEqual(Object.keys(answers[0]).sort(), ["available", "within"]);
  assert.deepEqual(Object.keys(answers[1]).sort(), ["available", "listed"]);
  for (const a of answers) {
    for (const v of Object.values(a)) assert.equal(typeof v, "boolean");
    const text = JSON.stringify(a);
    assert.doesNotMatch(text, /ダミー|架空|35\.36|138\.72/);
  }
  assert.equal(await privateKbHandler("/other", {}, env), null);
});

test("タイルは1回だけ読む", async () => {
  const store = memStore(packed);
  await stopNear(store, { lat: 35.362, lng: 138.728, km: 1 });
  const first = store.reads;
  await stopNear(store, { lat: 35.37, lng: 138.73, km: 1 });
  assert.equal(store.reads, first);
});

test("手元の入れ物（.private-kb/）も同じ形で読める・外は読まない", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pkb-"));
  assert.equal(dirStore(dir), null);
  for (const [k, v] of packed) {
    mkdirSync(join(dir, k, ".."), { recursive: true });
    writeFileSync(join(dir, k), JSON.stringify(v));
  }
  const store = dirStore(dir);
  assert.equal((await stopNear(store, { lat: 35.362, lng: 138.728, km: 1 })).within, true);
  assert.equal(await store.get("../etc/passwd"), null);
});

test("画面側は中継が無ければ聞かずに false/null", async () => {
  resetPrivateHintCache();
  const saved = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; throw new Error("呼ばないはず"); };
  try {
    assert.equal(await busStopNear({ lat: 35.36, lng: 138.72 }, 1, { proxyUrl: "" }), false);
    assert.equal(await spotListedHint("架空の滝", { lat: 35.5, lng: 138.5 }, {}), null);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test("画面側は中継の true/false をそのまま使い、座標は丸めて送る", async () => {
  resetPrivateHintCache();
  const saved = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ available: true, within: true }),
      { headers: { "Content-Type": "application/json" } });
  };
  try {
    const cfg = { proxyUrl: "https://relay.example" };
    assert.equal(await busStopNear({ lat: 35.362345, lng: 138.728765 }, 1, cfg), true);
    assert.equal(await busStopNear({ lat: 35.362345, lng: 138.728765 }, 1, cfg), true);
    assert.equal(sent.length, 1, "同じ場所は聞き直さない");
    assert.equal(sent[0].url, "https://relay.example/stops/near");
    assert.deepEqual(sent[0].body, { lat: 35.362, lng: 138.729, km: 1 });
  } finally {
    globalThis.fetch = saved;
    resetPrivateHintCache();
  }
});

test("中継は /stops/near と /spots/check を無料の枠で数え、/status に入れ物の有無を出す", () => {
  const src = readFileSync(new URL("../server/worker.js", import.meta.url), "utf8");
  assert.match(src, /"\/stops\/near": "free"/);
  assert.match(src, /"\/spots\/check": "free"/);
  assert.match(src, /privateKb: Boolean\(env\.PRIVATE_KB\)/);
});

test("KV のバインディングは、入れ物を作るまで外してある（無い id はデプロイを止める）", () => {
  const src = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(src, /^\s*\/\/ "kv_namespaces"/m);
  assert.doesNotMatch(src, /^\s*"kv_namespaces"/m);
  assert.doesNotMatch(src, /^\s*"r2_buckets"/m);
});

/** Workers KV のバインディングの代わり（get(key, {type}) と put と getWithMetadata）。 */
function fakeKv(initial = new Map()) {
  const m = new Map([...initial].map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    m, puts: 0,
    async get(key, opts) { assert.equal(opts?.type, "text"); return m.has(key) ? m.get(key) : null; },
    async getWithMetadata(key) { return { value: m.get(key) ?? null, metadata: null }; },
    async put(key, value) { this.puts++; m.set(key, value); },
  };
}

test("Workers KV でも同じ答え（storeFrom が包む）", async () => {
  const env = { PRIVATE_KB: fakeKv(packed) };
  assert.deepEqual(await privateKbHandler("/stops/near", { lat: 35.362, lng: 138.728, km: 1 }, env),
    { available: true, within: true });
  assert.equal(storeFrom(env.PRIVATE_KB), storeFrom(env.PRIVATE_KB), "同じ包みを使い回す");
  assert.equal(storeFrom(null), null);
});

test("管理画面から入れる口は、決まった鍵と形だけ受け付ける", async () => {
  const kv = fakeKv();
  const env = { PRIVATE_KB: kv };
  assert.equal(checkUpload("bus/35_138.json", JSON.stringify(busTile.stops)), null);
  assert.equal(checkUpload("manifest.json", JSON.stringify(packed.get("manifest.json"))), null);
  assert.match(checkUpload("../secret", "[]"), /鍵/);
  assert.match(checkUpload("other/1_2.json", "[]"), /鍵/);
  assert.match(checkUpload("bus/35_138.json", "{not json"), /JSON/);
  assert.match(checkUpload("bus/35_138.json", JSON.stringify({ any: "thing" })), /形/);
  assert.match(checkUpload("manifest.json", JSON.stringify({ bus: ["../x"], spots: [] })), /目次/);
  assert.match(checkUpload("bus/35_138.json", JSON.stringify([[1, 2, "x".repeat(MAX_VALUE_BYTES)]])), /大きすぎ/);
  assert.deepEqual(await putPrivate(env, "bus/35_138.json", JSON.stringify(busTile.stops)), { ok: true });
  assert.equal((await putPrivate(env, "x.json", "[]")).status, 400);
  assert.equal((await putPrivate({}, "manifest.json", "{}")).status, 503);
  assert.deepEqual(await privateStatus(env), { bound: true, ready: false, tiles: null });
  await putPrivate(env, "manifest.json", JSON.stringify(packed.get("manifest.json")));
  assert.deepEqual(await privateStatus(env), { bound: true, ready: true, tiles: { bus: 1, spots: 2 } });
  assert.deepEqual(await privateStatus({}), { bound: false, ready: false });
});

test("管理画面の入れる口は合言葉と専用の見出しの後ろにあり、中身を返さない", () => {
  const src = readFileSync(new URL("../server/admin.js", import.meta.url), "utf8");
  assert.match(src, /path === "private-kb" && m === "PUT"/);
  // serveApi は X-Admin-Request と合言葉を通ったあとにだけ呼ばれます
  assert.ok(src.indexOf('X-Admin-Request") !== "1"') < src.indexOf('path === "private-kb"'));
  assert.doesNotMatch(src, /PRIVATE_KB\.get/);
});
