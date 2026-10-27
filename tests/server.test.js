// 手元用 API サーバー（packages/server/server.mjs）の試験。
// 本物の core で旅程を組む試験と、偽の core で応答の形を見る試験に分けます。

import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../packages/server/server.mjs";

async function start(opts) {
  const lines = [];
  const server = await createServer({ log: (l) => lines.push(l), ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = { "Content-Type": "application/json" }) =>
    fetch(`${base}/plan`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { server, base, post, lines, close: () => new Promise((r) => server.close(r)) };
}

// core は fetch を差し替えるので、試験の通信用に先に取っておきます。
const realFetch = globalThis.fetch;
const s = await start();
globalThis.fetch = realFetch;
test.after(() => s.close());

test("POST /plan で旅程が JSON で返る", async () => {
  const res = await s.post({ wish: "温泉と海", days: 2, date: "2026-11-07", markdown: true });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.plan.version, 1);
  assert.ok(j.plan.days.length >= 2);
  assert.match(j.markdown, /## 1日目/);
});

test("lang で Markdown の言語を選べる。知らない言語は 400", async () => {
  const j = await (await s.post({ wish: "温泉と海", date: "2026-11-07", markdown: true, lang: "en" })).json();
  assert.match(j.markdown, /## Day 1/);
  const bad = await s.post({ wish: "温泉と海", lang: "fr" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "invalid_input");
});

test("GET /health", async () => {
  const j = await (await fetch(`${s.base}/health`)).json();
  assert.equal(j.ok, true);
  assert.ok(j.spots > 10000);
});

test("入力のまちがいは 400 と code", async () => {
  const cases = [
    [{ wish: "" }, "invalid_input"],
    [{ wish: "温泉", from: "どこか" }, "unknown_place"],
    [{ wish: "温泉", days: 99 }, "invalid_input"],
    [{ wish: "温泉", admin: true }, "invalid_input"],
    [[1, 2], "invalid_input"],
    ["{not json", "invalid_json"],
  ];
  for (const [body, code] of cases) {
    const res = await s.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, code);
  }
});

test("形のちがう頼みは 404・405・415・413", async () => {
  assert.equal((await fetch(`${s.base}/nope`)).status, 404);
  assert.equal((await fetch(`${s.base}/plan`)).status, 405);
  assert.equal((await s.post({ wish: "x" }, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await s.post({ wish: "あ".repeat(3000) })).status, 413);
});

test("記録に入力の文を残さない", async () => {
  await s.post({ wish: "ひみつの温泉", date: "2026-11-07" });
  assert.ok(s.lines.length > 0);
  assert.ok(s.lines.every((l) => !l.includes("ひみつ")));
});

test("回数の上限・同時の上限・時間切れ", async () => {
  const slow = { kb: { spots: [] }, plan: () => new Promise((r) => setTimeout(r, 300)) };
  const t = await start({ core: slow, limits: { perMinute: 3, concurrent: 1, timeoutMs: 100 } });
  try {
    assert.equal((await t.post({ wish: "a" })).status, 504);
    const [a, b] = await Promise.all([t.post({ wish: "a" }), t.post({ wish: "b" })]);
    assert.deepEqual([a.status, b.status].sort(), [503, 504]);
    assert.equal((await t.post({ wish: "c" })).status, 429);
  } finally { await t.close(); }
});
