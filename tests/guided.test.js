// 形のしばり（Guided Decoding。Issue #435）の試験。packages/core/src/guided.js・
// tools/tool_call_eval.mjs・手元のモデル（ai.js）・中継（server/own-model.js）。
// 本物の vLLM のかわりに、同じ形で答える小さなサーバー（fetch の差し替え）を使います。外へは出ません。

import assert from "node:assert/strict";
import test from "node:test";

import {
  actionJsonSchema, applyGuided, completionsUrl, nextToolCall, parseToolCall, rejectedGuided,
  summarizeToolCalls, toJsonSchema, toolCallBody, toolSpecs,
} from "../packages/core/src/guided.js";
import { validate } from "../packages/core/src/tools.js";
import { CASES, evalRegistry, runToolCallEval, toTable } from "../tools/tool_call_eval.mjs";
import { geminiToChat } from "../server/own-model.js";
import worker from "../server/worker.js";
import { callModelJson, localGuidedStyle, setLocalGuided, useLocalModel } from "../packages/core/src/ai.js";

const reg = evalRegistry();
const ok = (obj) => new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
const reply = (content) => ok({ choices: [{ message: { content } }] });

// --- Gemini の形 → JSON Schema ------------------------------------------------

test("Gemini の形（大文字の type・propertyOrdering・nullable）を JSON Schema にする", () => {
  const js = toJsonSchema({
    type: "OBJECT",
    properties: {
      a: { type: "STRING", description: "説明" },
      b: { type: "ARRAY", items: { type: "STRING", enum: ["x", "y"] } },
      c: { type: "OBJECT", properties: { d: { type: "BOOLEAN" } }, required: ["d"], propertyOrdering: ["d"] },
      e: { type: "INTEGER", nullable: true },
    },
    required: ["a"],
    propertyOrdering: ["a", "b", "c", "e"],
  });
  assert.deepEqual(js, {
    type: "object",
    properties: {
      a: { type: "string", description: "説明" },
      b: { type: "array", items: { type: "string", enum: ["x", "y"] } },
      c: { type: "object", properties: { d: { type: "boolean" } }, required: ["d"], additionalProperties: false },
      e: { type: ["integer", "null"] },
    },
    required: ["a"],
    additionalProperties: false,
  });
  // もとから JSON Schema なら、そのまま（additionalProperties は足すだけ）。
  assert.deepEqual(toJsonSchema({ type: "object", properties: { q: { type: "string" } }, additionalProperties: true }),
    { type: "object", properties: { q: { type: "string" } }, additionalProperties: true });
});

test("しばりかたごとの頼みの形", () => {
  const schema = { type: "OBJECT", properties: { q: { type: "STRING" } }, required: ["q"] };
  const base = { model: "m", messages: [], response_format: { type: "json_object" } };
  const js = applyGuided(base, schema);
  assert.equal(js.response_format.type, "json_schema");
  assert.equal(js.response_format.json_schema.strict, true);
  assert.equal(js.response_format.json_schema.schema.properties.q.type, "string");
  assert.deepEqual(applyGuided(base, schema, { style: "guided_json" }).guided_json.properties.q, { type: "string" });
  assert.equal(applyGuided(base, schema, { style: "guided_json" }).response_format, undefined);
  assert.deepEqual(applyGuided(base, schema, { style: "json_object" }).response_format, { type: "json_object" });
  assert.equal(applyGuided(base, schema, { style: "off" }).response_format, undefined);
  assert.equal(base.response_format.type, "json_object", "もとの頼みは変えない");
  assert.equal(completionsUrl("http://h:8000/v1/"), "http://h:8000/v1/chat/completions");
  assert.equal(rejectedGuided(400, "unknown field response_format.json_schema"), true);
  assert.equal(rejectedGuided(400, "model not found"), false);
  assert.equal(rejectedGuided(500, "response_format"), false);
});

// --- 道具の登録所 → 頼み -------------------------------------------------------

test("次の一手の Schema: 道具ごとに名前を const で固定し、引数は登録所の input", () => {
  const s = actionJsonSchema(reg);
  assert.ok(Array.isArray(s.anyOf));
  assert.equal(s.oneOf, undefined);
  const names = s.anyOf.filter((b) => b.properties.tool).map((b) => b.properties.tool.const);
  assert.deepEqual(names, reg.available());
  assert.ok(s.anyOf.some((b) => b.properties.final));
  assert.ok(!actionJsonSchema(reg, undefined, { allowFinal: false }).anyOf.some((b) => b.properties.final));
  const weather = s.anyOf.find((b) => b.properties.tool?.const === "search_weather");
  assert.equal(weather.properties.args, reg.get("search_weather").input);
  // 正しい一手は、どれかの枝に合う。
  const fits = (v) => s.anyOf.some((b) => validate(b, v).length === 0);
  assert.ok(fits({ tool: "web_search", args: { query: "瀬戸内 芸術祭" } }));
  assert.ok(fits({ final: true }));
  assert.ok(!fits({ tool: "web_search", args: { query: 1 } }));
  assert.ok(!fits({ tool: "fly", args: {} }));
});

test("tools の並びと3通りの頼みかた", () => {
  const specs = toolSpecs(reg);
  assert.equal(specs[0].type, "function");
  assert.equal(specs[0].function.name, "search_spots");
  assert.equal(specs[0].function.parameters, reg.get("search_spots").input);

  const free = toolCallBody({ wish: "箱根", registry: reg, mode: "free" });
  assert.equal(free.response_format, undefined);
  assert.equal(free.tools, undefined);
  assert.match(free.messages.at(-1).content, /search_spots/);

  const schema = toolCallBody({ wish: "箱根", registry: reg, mode: "schema", model: "g" });
  assert.equal(schema.model, "g");
  assert.equal(schema.response_format.type, "json_schema");
  assert.equal(schema.response_format.json_schema.name, "next_action");

  const tools = toolCallBody({ wish: "箱根", registry: reg, mode: "tools" });
  assert.equal(tools.tool_choice, "required");
  assert.equal(tools.tools.length, reg.available().length);
  assert.throws(() => toolCallBody({ wish: "x", registry: reg, mode: "magic" }), /mode/);
});

// --- 返事 → 道具の呼び出し（tool parser） ------------------------------------------

test("tool parser: 本文の JSON・tool_calls・並び・final を読む", () => {
  const c = (content) => ({ message: { content } });
  let r = parseToolCall(c('{"tool":"search_spots","args":{"keywords":["箱根","温泉"]}}'), reg);
  assert.deepEqual(r, { ok: true, action: { tool: "search_spots", args: { keywords: ["箱根", "温泉"] } }, lenient: false, via: "content" });

  r = parseToolCall({ message: { content: null, tool_calls: [{ type: "function",
    function: { name: "web_search", arguments: '{"query":"瀬戸内 芸術祭"}' } }] } }, reg);
  assert.equal(r.ok, true);
  assert.equal(r.via, "tool_calls");
  assert.deepEqual(r.action, { tool: "web_search", args: { query: "瀬戸内 芸術祭" } });

  r = parseToolCall(c('[{"name":"search_special_journey","arguments":{"text":"最長片道切符"}}]'), reg);
  assert.deepEqual(r.action, { tool: "search_special_journey", args: { text: "最長片道切符" } });

  assert.deepEqual(parseToolCall(c('{"thought":"もう分かる","final":true}'), reg).action, { final: true });
});

test("tool parser: 崩れの種類を言い分ける（投げない）", () => {
  const code = (content) => parseToolCall({ message: { content } }, reg).error?.code;
  assert.equal(code(""), "empty");
  assert.equal(code('{"tool":"search_spots","args":{"keywords":["箱根"'), "syntax");
  assert.equal(code('{"answer":"箱根"}'), "shape");
  assert.equal(code('{"tool":"search_hotels","args":{}}'), "unknown_tool");
  assert.equal(code('{"tool":"search_spots","args":{"keywords":"箱根"}}'), "invalid_args");
  assert.equal(code('{"tool":"search_spots","args":{"keywords":["箱根"],"near":"駅"}}'), "invalid_args");
  assert.equal(parseToolCall({ message: { tool_calls: [{ function: { name: "web_search", arguments: "{query:" } }] } }, reg).error.code, "syntax");
  // 前置き・``` があっても読めるが、lenient（崩れていた）と印を付ける。
  const r = parseToolCall({ message: { content: '道具を使います。\n```json\n{"tool":"web_search","args":{"query":"新しい水族館"}}\n```' } }, reg);
  assert.equal(r.ok, true);
  assert.equal(r.lenient, true);
});

// --- 1手ぶん聞く・比べる ------------------------------------------------------------

/**
 * vLLM のふり。しばり（json_schema・guided_json・tools）があれば形どおりに、
 * 無ければ4回に1回は崩した返事をします（小さいモデルの自由な JSON のつもり）。
 */
function fakeVllm({ acceptSchema = true } = {}) {
  let n = 0;
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), body });
    if (!acceptSchema && body.response_format?.type === "json_schema") {
      return new Response('{"error":"response_format.json_schema is not supported"}', { status: 400 });
    }
    const call = { tool: "search_spots", args: { keywords: ["温泉"] } };
    if (body.tools) {
      return ok({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function",
        function: { name: call.tool, arguments: JSON.stringify(call.args) } }] } }] });
    }
    if (body.response_format?.type === "json_schema" || body.guided_json) return reply(JSON.stringify(call));
    n++;
    if (n % 4 === 1) return reply(`はい、道具を使います。\n${JSON.stringify(call)}`);
    if (n % 4 === 2) return reply('{"tool":"search_spots","args":{"keywords":["温泉"]');
    if (n % 4 === 3) return reply('{"tool":"search_spots","args":{"keywords":"温泉"}}');
    return reply(JSON.stringify(call));
  };
  return { fetchImpl, seen };
}

test("nextToolCall: しばりを断るサーバーなら json_object に落として聞き直す", async () => {
  const fake = fakeVllm({ acceptSchema: false });
  const r = await nextToolCall({ url: "http://vllm:8000", model: "g", wish: "箱根で温泉", registry: reg, mode: "schema", fetchImpl: fake.fetchImpl });
  assert.equal(r.degraded, true);
  assert.equal(fake.seen.length, 2);
  assert.equal(fake.seen[0].url, "http://vllm:8000/v1/chat/completions");
  assert.equal(fake.seen[1].body.response_format.type, "json_object");
  const down = await nextToolCall({ url: "http://x", wish: "x", registry: reg, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.ok, false);
  assert.equal(down.error.code, "network");
});

test("比べる: しばりなしは崩れ、schema / tools は構文の崩れ 0", async () => {
  const fake = fakeVllm();
  const cases = CASES.slice(0, 8).map((c) => ({ ...c, expect: "search_spots" }));
  const result = await runToolCallEval({ url: "http://vllm:8000", model: "g", cases, fetchImpl: fake.fetchImpl });
  assert.deepEqual(Object.keys(result), ["free", "schema", "tools"]);
  assert.equal(result.schema.summary.syntaxErrorRate, 0);
  assert.equal(result.schema.summary.validCallRate, 100);
  assert.equal(result.tools.summary.syntaxErrorRate, 0);
  assert.equal(result.tools.summary.validCallRate, 100);
  assert.equal(result.free.summary.syntaxErrorRate, 50, "前置き付き + 閉じていない = 8件中4件");
  assert.equal(result.free.summary.errors.invalid_args, 2);
  assert.equal(result.free.summary.validCallRate, 50);
  const table = toTable(result);
  assert.match(table, /\| schema \| 8 \| 0% \| 100% \| 100% \|/);
  assert.match(table, /\| free \| 8 \| 50% \| 50% \|/);
});

test("問いの組は、期待する道具がどれも登録所にある", () => {
  assert.ok(CASES.length >= 20);
  for (const c of CASES) for (const t of [].concat(c.expect)) assert.ok(reg.has(t), `${c.wish}: ${t}`);
  const s = summarizeToolCalls([]);
  assert.equal(s.syntaxErrorRate, null);
});

// --- 手元のモデル（ai.js） -----------------------------------------------------------

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("手元のモデルへ JSON を頼むときは json_schema でしばり、断られたら json_object に落として覚える", async () => {
  const schema = { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] };
  useLocalModel({ model: "gemma4:e2b", baseUrl: "http://127.0.0.1:1" });
  try {
    setLocalGuided("json_schema");
    const sent = [];
    const got = await withFetch(async (url, init) => {
      sent.push(JSON.parse(init.body));
      return reply('{"query":"夏目友人帳 舞台"}');
    }, () => callModelJson("調べる語を", { schema, temperature: 0 }));
    assert.deepEqual(got, { query: "夏目友人帳 舞台" });
    assert.equal(sent[0].response_format.type, "json_schema");
    assert.deepEqual(sent[0].response_format.json_schema.schema,
      { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false });

    const sent2 = [];
    await withFetch(async (url, init) => {
      const b = JSON.parse(init.body);
      sent2.push(b);
      if (b.response_format?.type === "json_schema") return new Response("invalid response_format", { status: 400 });
      return reply('{"query":"x"}');
    }, () => callModelJson("調べる語を", { schema }));
    assert.deepEqual(sent2.map((b) => b.response_format.type), ["json_schema", "json_object"]);
    assert.equal(localGuidedStyle(), "json_object", "断られたことを覚える");
    assert.throws(() => setLocalGuided("xml"), /しばりかた/);
  } finally {
    setLocalGuided("json_schema");
    useLocalModel(null);
  }
});

// --- 中継（自前のモデル） -------------------------------------------------------------

test("中継: guidedSchema は自前のモデルにだけ使い、Google へは渡さない", async () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
  const body = geminiToChat({ contents: [{ role: "user", parts: [{ text: "x" }] }],
    generationConfig: { responseMimeType: "application/json" } }, "m", { guidedSchema: schema });
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "answer", schema, strict: true } });
  assert.deepEqual(geminiToChat({ contents: [] }, "m", { guidedSchema: [1] }).response_format, undefined);

  const ORIGIN = "http://localhost:8000";
  const call = (env) => worker.fetch(new Request("https://relay.example/gemini/generate", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gemma-4-26b-a4b-it", guidedSchema: schema,
      contents: [{ role: "user", parts: [{ text: "こんにちは" }] }] }),
  }), { ALLOW_ORIGIN: ORIGIN, ...env });

  const seen = [];
  const res = await withFetch(async (url, init) => {
    const u = new URL(String(url));
    seen.push({ host: u.host, body: JSON.parse(init.body) });
    if (u.host === "own.example") {
      // しばりを受けない入口: 1度目は断り、しばらずに聞き直させる。
      if (JSON.parse(init.body).response_format?.type === "json_schema") return new Response("no", { status: 400 });
      return new Response("down", { status: 503 });
    }
    return ok({ candidates: [{ content: { parts: [{ text: "{\"a\":\"b\"}" }] } }] });
  }, () => call({ OWN_MODEL_URL: "https://own.example", GEMINI_API_KEY: "g" }));
  assert.equal(res.status, 200);
  assert.deepEqual(seen.map((s) => s.host), ["own.example", "own.example", "generativelanguage.googleapis.com"]);
  assert.equal(seen[0].body.response_format.type, "json_schema");
  assert.equal(seen[1].body.response_format, undefined);
  assert.equal("guidedSchema" in seen[2].body, false, "Google へは渡さない");
  assert.equal("model" in seen[2].body, false);
});

test("画面 → 中継: Gemma で JSON を頼むときは guidedSchema を添える（検索つき・形なしでは付けない）", async () => {
  const { callModel } = await import("../packages/core/src/ai.js");
  const schema = { type: "OBJECT", properties: { q: { type: "STRING" } }, required: ["q"] };
  const sent = [];
  const fake = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return ok({ candidates: [{ content: { parts: [{ text: '{"q":"x"}' }] } }] });
  };
  await withFetch(fake, () => callModel("x", { schema, temperature: 0 }));
  const first = sent[0];
  assert.match(first.url, /\/gemini\/generate$/);
  assert.match(first.body.model, /gemma/);
  assert.deepEqual(first.body.guidedSchema,
    { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false });
  assert.equal(first.body.generationConfig.responseSchema, undefined, "Gemma に responseSchema は付けない");
  sent.length = 0;
  await withFetch(fake, () => callModel("x", { temperature: 0 }));
  assert.equal("guidedSchema" in sent[0].body, false);
});
