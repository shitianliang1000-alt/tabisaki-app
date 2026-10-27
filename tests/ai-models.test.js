// 設定したモデルが、このキーでは使えなかったとき。
//
// 画面にはこう出ていました。
//
//   AIに聞けなかったため、収録データから機械的に選びました
//   （models/gemma-3-12b-it is not found for API version v1beta, or is
//   not supported for generateContent. Call ModelService.ListModels …）
//
// 英語であることより、**では何なら使えるのか**が書いていないのが
// 困ります。控えを4つ並べてあっても、4つとも同じ系統なら全部だめです。
//
// 直しかたは2つ考えられます。
//
//   ① 控えに別の系統の名前を書き足す
//      → その名前が廃止された日に、また同じことが起きます
//   ② **このキーで何が使えるのかを聞く**
//      → Google のエラー文そのものが「ListModels を呼べ」と言っています
//
// ②にしました。ここで確かめたいのは、聞いた結果から**文を作れるもの
// だけ**を選べているか、です。埋め込み専用のモデルを選ぶと、次の
// 呼び出しでまた失敗します。

import assert from "node:assert/strict";
import test from "node:test";

import { listModels, rankModels, resetModelDiscovery } from "../packages/core/src/ai.js";
import worker from "../server/worker.js";

// --- 並べ替え ---------------------------------------------------------------

test("文を作れないモデルは、候補から外す", () => {
  const got = rankModels([
    "gemini-embedding-001", "text-embedding-004", "imagen-3.0-generate",
    "gemini-2.5-flash-tts", "gemini-2.5-flash", "aqa",
  ]);
  assert.deepEqual(got, ["gemini-2.5-flash"]);
});

test("設定と同じ系統を先に、実験版を後ろに", () => {
  const got = rankModels([
    "gemini-2.0-flash-exp", "gemini-2.5-pro", "gemma-3-12b-it",
    "gemini-2.5-flash",
  ]);
  assert.equal(got[0], "gemma-3-12b-it", "設定と同じ系統が先ではありません");
  assert.equal(got.at(-1), "gemini-2.0-flash-exp", "実験版が後ろではありません");
  assert.ok(got.indexOf("gemini-2.5-flash") < got.indexOf("gemini-2.5-pro"),
    "flash より pro が先に来ています");
});

test("models/ の頭は落とす。空は捨てる", () => {
  assert.deepEqual(rankModels(["gemini-2.5-flash", "", null, undefined]),
    ["gemini-2.5-flash"]);
  assert.deepEqual(rankModels([]), []);
  assert.deepEqual(rankModels(null), []);
});

// --- 聞きにいく -------------------------------------------------------------

test("中継の答え（名前だけ）を読める", async () => {
  resetModelDiscovery();
  const got = await listModels({
    fetchImpl: async () => ({ ok: true,
      json: async () => ({ models: ["gemini-2.5-flash", "gemini-embedding-001"] }) }),
  });
  assert.deepEqual(got, ["gemini-2.5-flash"]);
});

test("Google の答え（models/… の形）も読める", async () => {
  const got = await listModels({
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [
      { name: "models/gemini-2.5-flash",
        supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-001",
        supportedGenerationMethods: ["embedContent"] },
    ] }) }),
  });
  // 中継が絞っていない形でも、名前の見た目で埋め込みは落とせます。
  assert.ok(got.includes("gemini-2.5-flash"));
  assert.ok(!got.includes("gemini-embedding-001"));
});

test("聞けなくても、落ちない", async () => {
  for (const send of [
    async () => ({ ok: false, status: 403 }),
    async () => { throw new Error("つながりません"); },
    async () => ({ ok: true, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => { throw new Error("壊れ"); } }),
  ]) {
    assert.deepEqual(await listModels({ fetchImpl: send }), []);
  }
});

// --- 中継の入口 -------------------------------------------------------------

const ORIGIN = "https://tabisaki.example";

async function askWorker(reply, { key = "k" } = {}) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input?.url ?? input), init });
    return reply;
  };
  try {
    const res = await worker.fetch(new Request(`${ORIGIN}/gemini/models`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    }), { ALLOW_ORIGIN: ORIGIN, GEMINI_API_KEY: key });
    return { res, doc: await res.json().catch(() => null), calls };
  } finally {
    globalThis.fetch = real;
  }
}

test("中継は、文を作れる Gemma の名前だけを返す（Gemini は使わない）", async () => {
  const { doc, calls } = await askWorker(new Response(JSON.stringify({ models: [
    { name: "models/gemini-2.5-flash",
      supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/gemini-embedding-001",
      supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemma-3-12b-it",
      supportedGenerationMethods: ["generateContent"] },
  ] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  assert.deepEqual(doc.models, ["gemma-3-12b-it"]);
  // 鍵は本文に出しません（見出しで渡します）。
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "k");
});

test("鍵が無ければ、そう言う（上流へは行かない）", async () => {
  const { res, calls } = await askWorker(new Response("{}"), { key: "" });
  assert.notEqual(res.status, 200);
  assert.equal(calls.length, 0, "鍵が無いのに上流へ行っています");
});

test("上流が断ったら、そのまま返す", async () => {
  const { res } = await askWorker(new Response("no", { status: 429 }));
  assert.equal(res.status, 429);
});

test("答えが壊れていても、落ちない", async () => {
  const { res, doc } = await askWorker(new Response("なにか", { status: 200 }));
  assert.equal(res.status, 200);
  assert.deepEqual(doc.models, []);
});

test("中継は Gemini のモデルを通さない（Gemma だけ）", async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => { calls.push(String(input?.url ?? input)); return new Response("{}", { status: 200 }); };
  try {
    for (const [model, path, status] of [
      ["gemini-2.5-flash", "generate", 400], ["gemini-embedding-001", "embed", 400],
      ["gemma-4-26b-a4b-it", "generate", 200],
    ]) {
      const res = await worker.fetch(new Request(`${ORIGIN}/gemini/${path}`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ model, contents: [] }),
      }), { ALLOW_ORIGIN: ORIGIN, GEMINI_API_KEY: "k" });
      assert.equal(res.status, status, model);
    }
    assert.equal(calls.length, 1, "Gemini を上流へ投げています");
  } finally {
    globalThis.fetch = real;
  }
});
