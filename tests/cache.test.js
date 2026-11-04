// 控え（キャッシュ）の層の試験（#438。packages/core/src/cache.js）。
// Redis を使わずに、同じ問い合わせを聞き直さないこと、数（当たりの割合・
// 時間・費用）が測れることを確かめます。

import assert from "node:assert/strict";
import test from "node:test";

import { cacheApiStore, cacheKey, createCache, memoryStore, webStorageStore }
  from "../packages/core/src/cache.js";
import { cachedSearch } from "../packages/core/src/tools.js";
import worker, { resetWebSearchCache, usageOf } from "../server/worker.js";
import { cacheSummary } from "../admin/statview.js";

/** localStorage の代わり。 */
function fakeStorage({ limit = Infinity } = {}) {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      const used = [...m.values()].reduce((a, x) => a + x.length, 0) - (m.get(k)?.length ?? 0);
      if (used + v.length > limit) throw new Error("QuotaExceededError");
      m.set(k, String(v));
    },
    removeItem: (k) => { m.delete(k); },
  };
}

/** caches.default の代わり。 */
function fakeCacheApi() {
  const m = new Map();
  return {
    m,
    async match(req) { const r = m.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { m.set(req.url, res.clone()); },
    async delete(req) { return m.delete(req.url); },
  };
}

test("鍵は空白・大文字小文字・全角半角の違いをならす", () => {
  assert.equal(cacheKey("  京都　紅葉  "), "京都 紅葉");
  assert.equal(cacheKey("ＫＹＯＴＯ Autumn"), "kyoto autumn");
});

test("同じ鍵は期限のあいだ覚えた値を返し、期限が過ぎたら聞き直す", async () => {
  let t = 0; let calls = 0;
  const c = createCache({ ttlMs: 1000, now: () => t });
  const load = async () => ++calls;
  assert.deepEqual((await c.fetch("a", load)).value, 1);
  const again = await c.fetch("a", load);
  assert.equal(again.value, 1);
  assert.equal(again.hit, true);
  t = 1001;
  assert.equal((await c.fetch("a", load)).value, 2);
  assert.equal(calls, 2);
});

test("同時に頼まれた同じ鍵は、1回だけ聞く", async () => {
  let calls = 0;
  const c = createCache();
  const load = () => new Promise((r) => setTimeout(() => r(++calls), 10));
  const out = await Promise.all([c.fetch("x", load), c.fetch("x", load), c.fetch("x", load)]);
  assert.equal(calls, 1);
  assert.deepEqual(out.map((o) => o.value), [1, 1, 1]);
  const s = c.stats();
  assert.equal(s.misses, 1);
  assert.equal(s.shared, 2);
  assert.equal(s.saved, 2);
});

test("失敗と keep で外したものは覚えない", async () => {
  const c = createCache();
  await assert.rejects(c.fetch("e", async () => { throw new Error("down"); }));
  assert.equal(c.stats().errors, 1);
  let calls = 0;
  await c.fetch("k", async () => { calls++; return []; }, { keep: (v) => v.length > 0 });
  await c.fetch("k", async () => { calls++; return []; }, { keep: (v) => v.length > 0 });
  assert.equal(calls, 2);
});

test("当たりの割合・時間・聞かずに済んだ費用が数えられる", async () => {
  let clock = 0;
  const c = createCache({ costPerCall: 0.005, timer: () => clock });
  const slow = async () => { clock += 800; return "v"; };
  await c.fetch("q", slow);                     // 外れ 800ms
  for (let i = 0; i < 9; i++) await c.fetch("q", slow); // 当たり 0ms
  const s = c.stats();
  assert.equal(s.requests, 10);
  assert.equal(s.calls, 1);
  assert.equal(s.hitRate, 0.9);
  assert.equal(s.costSpent, 0.005);
  assert.equal(s.costSaved, 0.045);
  assert.equal(s.latency.miss.p50Ms, 800);
  assert.equal(s.latency.hit.p95Ms, 0);
  c.resetStats();
  assert.equal(c.stats().requests, 0);
});

test("メモリの置き場は、いちばん長く使われていないものから捨てる", () => {
  const m = memoryStore({ maxEntries: 2 });
  m.set("a", 1); m.set("b", 2);
  m.get("a");            // a を使う → b がいちばん古い
  m.set("c", 3);
  assert.equal(m.get("b"), undefined);
  assert.equal(m.get("a"), 1);
  assert.equal(m.size, 2);
});

test("localStorage の置き場は上限を守り、容量切れでも投げない", async () => {
  const ls = fakeStorage();
  const st = webStorageStore(ls, { prefix: "t:", maxEntries: 2 });
  st.set("a", { v: 1 }); st.set("b", { v: 2 }); st.set("c", { v: 3 });
  assert.equal(st.get("a"), undefined);
  assert.deepEqual(st.get("c"), { v: 3 });
  ls.setItem("t:bad", "{壊れた");
  assert.equal(st.get("bad"), undefined);

  // 容量がほとんど無い置き場でも、createCache は外れとして動き続ける。
  const tiny = createCache({ store: webStorageStore(fakeStorage({ limit: 10 }), { prefix: "z:" }) });
  const r = await tiny.fetch("big", async () => "x".repeat(100));
  assert.equal(r.value, "x".repeat(100));
  assert.ok(tiny.stats().storeErrors >= 1);
});

test("層を重ねると、後ろで見つかったものを前へも入れる", async () => {
  const front = memoryStore();
  const back = cacheApiStore(fakeCacheApi());
  const writer = createCache({ layers: [memoryStore(), back] });
  await writer.fetch("k", async () => ({ n: 1 }));
  // 別の入れ物（メモリは空）から読む。
  const reader = createCache({ layers: [front, back] });
  let calls = 0;
  const r = await reader.fetch("k", async () => { calls++; return { n: 2 }; });
  assert.deepEqual(r.value, { n: 1 });
  assert.equal(calls, 0);
  assert.ok(front.get("k"), "前の置き場にも入る");
});

test("cachedSearch は見つからなかった答えを覚えない", async () => {
  let calls = 0;
  const search = cachedSearch(async () => { calls++; return []; });
  await search("無い場所"); await search("無い場所");
  assert.equal(calls, 2);
  assert.equal(search.stats.hitRate, 0);
});

test("中継の /web/search は、同じ語を2回目は外へ聞かず、X-Cache で知らせる", async () => {
  resetWebSearchCache();
  const ORIGIN = "https://shitianliang1000-alt.github.io";
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ query: { search: [{ title: "箱根", snippet: "温泉" }] } }),
      { headers: { "Content-Type": "application/json" } });
  };
  try {
    const ask = () => worker.fetch(new Request(`${ORIGIN}/web/search`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ q: "箱根 温泉 キャッシュ" }),
    }), { ALLOW_ORIGIN: ORIGIN });
    const a = await ask();
    const b = await ask();
    assert.equal(a.headers.get("X-Cache"), "MISS");
    assert.equal(b.headers.get("X-Cache"), "HIT");
    assert.match(b.headers.get("Server-Timing"), /^cache;desc="hit";dur=\d+$/);
    assert.equal((await b.json()).cached, true);
    assert.equal(calls, 1);

    // 数えるもの（管理画面の「控えの当たり」）。
    const items = usageOf(new Request(`${ORIGIN}/web/search`, { method: "POST" }),
      new URL(`${ORIGIN}/web/search`), 200, b.headers).items;
    assert.deepEqual(items.find((i) => i[0] === "cache"), ["cache", "/web/search hit", 1]);
    assert.ok(items.find((i) => i[0] === "cache_ms"));
  } finally {
    globalThis.fetch = real;
    resetWebSearchCache();
  }
});

test("管理画面は入口ごとの当たりの割合と平均時間を出す", () => {
  const counts = {
    "2026-11-03": { cache: { "/web/search hit": 9, "/web/search miss": 1 },
                    cache_ms: { "/web/search hit": 18, "/web/search miss": 700 } },
  };
  assert.deepEqual(cacheSummary(counts), [
    { path: "/web/search", hits: 9, misses: 1, hitRate: 0.9, hitMs: 2, missMs: 700 },
  ]);
});
