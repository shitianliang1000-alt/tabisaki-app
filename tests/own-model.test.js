// 自前のモデル（OWN_MODEL_URL）への切り替え。server/own-model.js と
// server/worker.js の /gemini/generate。外へは出ません（fetch を差し替えます）。

import assert from "node:assert/strict";
import test from "node:test";

import worker from "../server/worker.js";
import {
  chatToGemini, chatUrl, geminiToChat, ownModelConfigured, ownModelTimeout,
} from "../server/own-model.js";
import { replyText } from "../packages/core/src/ai.js";

test("入口の URL の書きかたは3通り受ける", () => {
  assert.equal(chatUrl("https://x.example"), "https://x.example/v1/chat/completions");
  assert.equal(chatUrl("https://x.example/v1/"), "https://x.example/v1/chat/completions");
  assert.equal(chatUrl("https://x.example/v1/chat/completions"), "https://x.example/v1/chat/completions");
});

test("設定が無ければ使わない・待ち時間には上限がある", () => {
  assert.equal(ownModelConfigured({}), false);
  assert.equal(ownModelConfigured({ OWN_MODEL_URL: "ftp://x" }), false);
  assert.equal(ownModelConfigured({ OWN_MODEL_URL: "https://x.example" }), true);
  assert.equal(ownModelTimeout({}), 40_000);
  assert.equal(ownModelTimeout({ OWN_MODEL_TIMEOUT_MS: "999999" }), 110_000);
});

test("Gemini の頼み → chat/completions（考えの部分は渡さない）", () => {
  const body = geminiToChat({
    systemInstruction: { parts: [{ text: "役割" }] },
    contents: [
      { role: "user", parts: [{ text: "京都で" }] },
      { role: "model", parts: [{ text: "…", thought: true }, { text: "はい" }] },
    ],
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 512, responseMimeType: "application/json" },
  }, "m");
  assert.deepEqual(body.messages, [
    { role: "system", content: "役割" },
    { role: "user", content: "京都で" },
    { role: "assistant", content: "はい" },
  ]);
  assert.equal(body.model, "m");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.top_p, 0.9);
  assert.equal(body.max_tokens, 512);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("chat/completions の答え → 画面がそのまま読める Gemini の形", () => {
  const data = chatToGemini({ model: "m", choices: [{ message: { content: "{\"a\":1}" }, finish_reason: "stop" }] });
  assert.equal(replyText(data), "{\"a\":1}");
  assert.equal(data.candidates[0].finishReason, "STOP");
});

// --- 中継を通す ---------------------------------------------------------------

const ORIGIN = "http://localhost:8000";
const call = (env) => worker.fetch(new Request("https://relay.example/gemini/generate", {
  method: "POST",
  headers: { Origin: ORIGIN, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gemma-4-26b-a4b-it", contents: [{ role: "user", parts: [{ text: "こんにちは" }] }] }),
}), { ALLOW_ORIGIN: ORIGIN, ...env });

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const ok = (obj) => new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });

test("自前のモデルが答えれば、それを返す（AI Studio は呼ばない）", async () => {
  const seen = [];
  const res = await withFetch(async (url, init) => {
    seen.push(String(url));
    assert.equal(init.headers.Authorization, "Bearer k");
    return ok({ choices: [{ message: { content: "自前です" } }] });
  }, () => call({ OWN_MODEL_URL: "https://own.example", OWN_MODEL_KEY: "k", GEMINI_API_KEY: "g" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Tabisaki-Model-Source"), "own");
  assert.equal(replyText(await res.json()), "自前です");
  assert.deepEqual(seen, ["https://own.example/v1/chat/completions"]);
});

test("自前のモデルが落ちていたら、AI Studio に聞き直す", async () => {
  const seen = [];
  const res = await withFetch(async (url) => {
    seen.push(String(url));
    if (String(url).startsWith("https://own.example")) return new Response("down", { status: 503 });
    return ok({ candidates: [{ content: { parts: [{ text: "AI Studio です" }] } }] });
  }, () => call({ OWN_MODEL_URL: "https://own.example", GEMINI_API_KEY: "g" }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("X-Tabisaki-Model-Source"), /^aistudio-fallback;own=status_503/);
  assert.equal(replyText(await res.json()), "AI Studio です");
  assert.equal(seen.length, 2);
  assert.match(seen[1], /generativelanguage\.googleapis\.com/);
});

test("OWN_MODEL_FALLBACK=off なら聞き直さない", async () => {
  const res = await withFetch(async () => new Response("down", { status: 500 }),
    () => call({ OWN_MODEL_URL: "https://own.example", OWN_MODEL_FALLBACK: "off", GEMINI_API_KEY: "g" }));
  assert.equal(res.status, 502);
});

test("OWN_MODEL_URL が無ければ、いままでどおり AI Studio だけ", async () => {
  const seen = [];
  const res = await withFetch(async (url) => {
    seen.push(String(url));
    return ok({ candidates: [{ content: { parts: [{ text: "x" }] } }] });
  }, () => call({ GEMINI_API_KEY: "g" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Tabisaki-Model-Source"), null);
  assert.equal(seen.length, 1);
});
