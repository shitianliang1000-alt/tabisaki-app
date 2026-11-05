// Guided Decoding（JSON Schema で出力をしばる。Issue #435）。
//
// 小さいモデル（Gemma 4 E2B / E4B・4B 級）に道具を選ばせると、自由に JSON を
// 書かせたときは括弧の欠け・前置き・無い道具の名前・型の違う引数がよく出ます。
// vLLM などの推論サーバーは、JSON Schema に合わないトークンをそもそも出させない
// （制約付きデコーディング。vLLM では Outlines / xgrammar / guidance）ことが
// できるので、道具の名前と引数の型を、出力の段階で守らせます。
//
// ここにあるもの（どれも外へは出ません。fetch は差し替えられます）:
//
//   toJsonSchema(schema)        Gemini の形（type:"STRING" など）→ JSON Schema
//   applyGuided(body, schema)   OpenAI 互換の頼みに、形のしばりを付ける
//   toolSpecs(registry)         道具の登録所（tools.js）→ OpenAI の tools
//   actionJsonSchema(registry)  「次の一手」の JSON Schema（どの推論サーバーでも通る形）
//   toolCallBody({...})         道具を選ばせる頼み（free / schema / tools の3通り）
//   parseToolCall(choice, reg)  返事 → {tool, args} か {final}（tool parser）
//   nextToolCall({...})         上の3つをつないで、1手ぶん聞く
//
// 推論サーバーの立てかたと、しばりの有無での比べかたは docs/guided-decoding.md。

import { validate } from "./tools.js";

/** 形のしばりかた。 */
export const GUIDED_STYLES = Object.freeze([
  // response_format: {type:"json_schema"}。vLLM・Ollama・llama.cpp・LM Studio が受けます
  "json_schema",
  // vLLM の古い書きかた（0.10 より前の guided_json）。新しい vLLM は response_format を使います
  "guided_json",
  // JSON であることだけ（形はしばらない）。しばりを受けないサーバー向けの逃げ道
  "json_object",
  // 何も付けない（比べるとき用）
  "off",
]);

/** 道具を選ばせる頼みかた。 */
export const TOOL_CALL_MODES = Object.freeze([
  // 本文で「この形の JSON で」と頼むだけ（しばりなし。比べる基準）
  "free",
  // 「次の一手」の JSON Schema で出力をしばる（response_format: json_schema）
  "schema",
  // OpenAI の tools + tool_choice:"required"。vLLM はこれも制約付きで出します
  "tools",
]);

// ---------------------------------------------------------------------------
//  Gemini の形 → JSON Schema
// ---------------------------------------------------------------------------

const GEMINI_TYPES = {
  STRING: "string", NUMBER: "number", INTEGER: "integer", BOOLEAN: "boolean",
  ARRAY: "array", OBJECT: "object", NULL: "null",
};

/**
 * Gemini の responseSchema（OpenAPI の一部。type は大文字）を、推論サーバーが
 * 受ける JSON Schema にします。もとから JSON Schema なら、そのまま通ります。
 *
 * - type は小文字に、nullable は type の並びに
 * - propertyOrdering は落とします（JSON Schema には無い。順は properties の並びで伝わります）
 * - object には additionalProperties:false を付けます（余計な鍵を書かせない）
 *
 * @param {object} schema
 * @param {{closed?: boolean}} [opts] closed:false で additionalProperties を付けません
 */
export function toJsonSchema(schema, { closed = true } = {}) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "propertyOrdering" || k === "nullable") continue;
    if (k === "type") {
      const types = [].concat(v).map((t) => GEMINI_TYPES[String(t).toUpperCase()] ?? String(t).toLowerCase());
      out.type = types.length === 1 ? types[0] : types;
    } else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toJsonSchema(s, { closed })]));
    } else if ((k === "items" || k === "additionalProperties") && v && typeof v === "object") {
      out[k] = toJsonSchema(v, { closed });
    } else if ((k === "anyOf" || k === "oneOf" || k === "allOf") && Array.isArray(v)) {
      out[k] = v.map((s) => toJsonSchema(s, { closed }));
    } else {
      out[k] = v;
    }
  }
  if (schema.nullable && out.type && !([].concat(out.type).includes("null"))) {
    out.type = [...[].concat(out.type), "null"];
  }
  if (closed && out.type === "object" && out.properties && !("additionalProperties" in out)) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * OpenAI 互換の頼み（chat/completions の本文）に、形のしばりを付けます。
 * もとの body は変えず、新しい body を返します。
 *
 * @param {object} body
 * @param {object|null} schema JSON Schema（Gemini の形でも可。toJsonSchema を通します）
 * @param {{style?: string, name?: string}} [opts]
 */
export function applyGuided(body, schema, { style = "json_schema", name = "answer" } = {}) {
  const out = { ...body };
  delete out.response_format;
  delete out.guided_json;
  if (!schema || style === "off") return out;
  if (style === "json_object") {
    out.response_format = { type: "json_object" };
    return out;
  }
  const js = toJsonSchema(schema);
  if (style === "guided_json") {
    out.guided_json = js;
    return out;
  }
  out.response_format = {
    type: "json_schema",
    json_schema: { name: safeName(name), schema: js, strict: true },
  };
  return out;
}

const safeName = (s) => String(s || "answer").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "answer";

/**
 * しばりを付けた頼みを、推論サーバーが断ったか（受けない形だった）。
 * 400 / 422 と、「response_format」「json_schema」「guided」を含む断り文句を見ます。
 */
export function rejectedGuided(status, text = "") {
  if (status !== 400 && status !== 422) return false;
  return /response_format|json_schema|guided|structured|grammar|schema/i.test(String(text)) || status === 422;
}

// ---------------------------------------------------------------------------
//  道具（tools.js の登録所）→ 頼み
// ---------------------------------------------------------------------------

/** 道具の登録所から、OpenAI の tools の並びを作ります。 */
export function toolSpecs(registry, names = registry.available()) {
  return names.map((n) => {
    const t = registry.get(n);
    return { type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input } };
  });
}

/**
 * 「次の一手」の JSON Schema。tools.js の actionSchema と同じ中身ですが、
 * oneOf を anyOf にします。道具ごとに tool の const が違うので意味は同じで、
 * anyOf のほうが推論サーバー（xgrammar・Outlines・llama.cpp の GBNF）で
 * 広く通ります。
 */
export function actionJsonSchema(registry, names = registry.available(), { allowFinal = true } = {}) {
  const s = registry.actionSchema(names);
  const branches = s.oneOf.filter((b) => allowFinal || !b.properties.final);
  return { anyOf: branches };
}

/** 道具の説明を、本文に書く形にします（free のときの頼りはこれだけです）。 */
export function describeTools(registry, names = registry.available()) {
  return names.map((n) => {
    const t = registry.get(n);
    return `- ${t.name}: ${t.description}\n  引数の形: ${JSON.stringify(t.input)}`;
  }).join("\n");
}

const SYSTEM_TOOLS = "あなたは旅行の計画を手伝う係です。利用者の希望を読んで、次に使う道具を1つ選びます。"
  + "道具が要らない（もう答えられる）ときは final を選びます。";

/**
 * 道具を選ばせる頼み（OpenAI 互換の chat/completions の本文）を作ります。
 *
 * @param {{wish: string, registry: object, names?: string[], mode?: string,
 *          model?: string, history?: object[], temperature?: number, allowFinal?: boolean,
 *          style?: string}} p
 *   mode  free（本文で頼むだけ）/ schema（JSON Schema でしばる）/ tools（tools + required）
 *   style mode が schema のときのしばりかた（GUIDED_STYLES）
 */
export function toolCallBody({ wish, registry, names = registry.available(), mode = "schema", model = "",
  history = [], temperature = 0, allowFinal = true, style = "json_schema" }) {
  if (!TOOL_CALL_MODES.includes(mode)) throw new TypeError(`mode は ${TOOL_CALL_MODES.join(" / ")} のどれかです`);
  const shape = '{"thought": "短い考え", "tool": "道具の名前", "args": {引数}}'
    + (allowFinal ? ' か {"thought": "…", "final": true}' : "");
  const ask = mode === "tools"
    ? `希望: ${wish}\n\n次に使う道具を1つ呼んでください。`
    : `使える道具:\n${describeTools(registry, names)}\n\n希望: ${wish}\n\n`
      + `答えは ${shape} の JSON だけにしてください。説明文や \`\`\` は付けないでください。`;
  const body = {
    ...(model ? { model } : {}),
    messages: [{ role: "system", content: SYSTEM_TOOLS }, ...history, { role: "user", content: ask }],
    temperature,
    stream: false,
  };
  if (mode === "schema") return applyGuided(body, actionJsonSchema(registry, names, { allowFinal }), { style, name: "next_action" });
  if (mode === "tools") {
    body.tools = toolSpecs(registry, names);
    body.tool_choice = "required";
  }
  return body;
}

// ---------------------------------------------------------------------------
//  返事 → 道具の呼び出し（tool parser）
// ---------------------------------------------------------------------------

/** 読み取りの失敗の種類。 */
export const PARSE_ERRORS = Object.freeze(["empty", "syntax", "shape", "unknown_tool", "invalid_args"]);

/** 余計な前置き・``` があっても、最初の JSON の塊を拾います（拾えたら lenient）。 */
function looseJson(text) {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(unfenced); } catch { /* 続行 */ }
  const start = unfenced.search(/[[{]/);
  if (start < 0) return undefined;
  const open = unfenced[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < unfenced.length; i++) {
    const c = unfenced[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try { return JSON.parse(unfenced.slice(start, i + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

/** {name, arguments} / {tool, args} / {function: {...}} のどれでも {tool, args} にします。 */
function normalizeCall(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.final === true) return { final: true, thought: obj.thought };
  const fn = obj.function && typeof obj.function === "object" ? obj.function : obj;
  const tool = fn.tool ?? fn.name;
  let args = fn.args ?? fn.arguments ?? fn.parameters ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args || "{}"); } catch { return { tool, args, argsSyntax: true }; }
  }
  if (typeof tool !== "string") return null;
  return { tool, args, thought: obj.thought };
}

/**
 * 推論サーバーの返事（choices[0]）を、道具の呼び出しとして読みます。投げません。
 *
 * message.tool_calls（tools で頼んだとき）と、本文の JSON（free・schema）の両方を読みます。
 * 本文がそのまま JSON.parse できなかったのに、前置きや ``` を外して読めたときは
 * lenient: true を付けます（しばりなしで比べるとき、「読めたが崩れていた」を数えるため）。
 *
 * @returns {{ok: true, action: {tool: string, args: object}|{final: true}, lenient: boolean, via: string}
 *          |{ok: false, error: {code: string, message: string}, via: string}}
 */
export function parseToolCall(choice, registry) {
  const msg = choice?.message ?? {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  let call = null;
  let lenient = false;
  let via = "content";
  if (calls.length) {
    via = "tool_calls";
    call = normalizeCall(calls[0]);
    if (!call) return fail("shape", "tool_calls の形が読めません", via);
  } else {
    const text = String(msg.content ?? choice?.text ?? "").trim();
    if (!text) return fail("empty", "返事が空です", via);
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      obj = looseJson(text);
      if (obj === undefined) return fail("syntax", "JSON として読めません", via);
      lenient = true;
    }
    // [{name, arguments}] の並びで返すモデルもあります（Llama 系・pythonic 以外の多く）。
    if (Array.isArray(obj)) obj = obj[0];
    call = normalizeCall(obj);
    if (!call) return fail("shape", "道具の名前（tool）も final もありません", via);
  }
  if (call.final) return { ok: true, action: { final: true }, lenient, via };
  if (call.argsSyntax) return fail("syntax", "arguments が JSON として読めません", via);
  if (!registry.has(call.tool)) return fail("unknown_tool", `道具「${call.tool}」はありません`, via);
  const errs = validate(registry.get(call.tool).input, call.args ?? {});
  if (errs.length) return fail("invalid_args", errs.join("。"), via);
  return { ok: true, action: { tool: call.tool, args: call.args ?? {} }, lenient, via };
}

const fail = (code, message, via) => ({ ok: false, error: { code, message }, via });

// ---------------------------------------------------------------------------
//  1手ぶん聞く
// ---------------------------------------------------------------------------

/** chat/completions の URL（土台・/v1・まるごと のどれでも）。 */
export function completionsUrl(base) {
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v1$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

/**
 * 推論サーバーに、次の一手（道具の呼び出し）を1つ聞きます。投げません。
 *
 * mode が schema で、サーバーが json_schema を断ったときは、json_object に
 * 落として1度だけ聞き直します（degraded: true）。
 *
 * @param {{url: string, model?: string, key?: string, wish: string, registry: object,
 *          names?: string[], mode?: string, style?: string, fetchImpl?: Function,
 *          signal?: AbortSignal, timeoutMs?: number, allowFinal?: boolean, temperature?: number}} p
 * @returns {Promise<{ok: boolean, action?: object, error?: object, lenient?: boolean,
 *          degraded: boolean, via?: string, ms: number, raw?: string}>}
 */
export async function nextToolCall({ url, model = "", key = "", wish, registry, names, mode = "schema",
  style = "json_schema", fetchImpl = globalThis.fetch, signal, timeoutMs = 60_000, allowFinal = true, temperature = 0 }) {
  const t0 = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const post = async (body) => {
    const sig = signal ?? (typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined);
    return fetchImpl(completionsUrl(url), { method: "POST", headers, body: JSON.stringify(body), signal: sig });
  };
  let body = toolCallBody({ wish, registry, names, mode, model, allowFinal, style, temperature });
  let degraded = false;
  let res;
  try {
    res = await post(body);
    if (!res.ok && mode === "schema" && style !== "json_object") {
      const text = await res.text().catch(() => "");
      if (rejectedGuided(res.status, text)) {
        degraded = true;
        body = applyGuided(body, {}, { style: "json_object" });
        res = await post(body);
      } else {
        return { ok: false, error: { code: "http", message: `${res.status} ${text.slice(0, 200)}` }, degraded, ms: Date.now() - t0 };
      }
    }
  } catch (e) {
    return { ok: false, error: { code: "network", message: e?.message ?? String(e) }, degraded, ms: Date.now() - t0 };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: { code: "http", message: `${res.status} ${text.slice(0, 200)}` }, degraded, ms: Date.now() - t0 };
  }
  const data = await res.json().catch(() => null);
  const choice = data?.choices?.[0];
  const parsed = parseToolCall(choice, registry);
  const raw = String(choice?.message?.content ?? "") || JSON.stringify(choice?.message?.tool_calls ?? null);
  return { ...parsed, degraded, ms: Date.now() - t0, raw: raw.slice(0, 2000) };
}

// ---------------------------------------------------------------------------
//  比べる（tools/tool_call_eval.mjs が使います）
// ---------------------------------------------------------------------------

/**
 * 1つの mode の結果をまとめます。
 * @param {Array<{expect?: string|string[], result: object}>} rows
 */
export function summarizeToolCalls(rows) {
  const n = rows.length;
  const count = (f) => rows.filter(f).length;
  const errors = Object.fromEntries(PARSE_ERRORS.map((c) => [c, count((r) => r.result.error?.code === c)]));
  const transport = count((r) => r.result.error && !PARSE_ERRORS.includes(r.result.error.code));
  const ok = count((r) => r.result.ok);
  const strictOk = count((r) => r.result.ok && !r.result.lenient);
  const expected = rows.filter((r) => r.expect != null);
  const hit = expected.filter((r) => r.result.ok && [].concat(r.expect).includes(r.result.action.tool ?? (r.result.action.final ? "final" : ""))).length;
  const syntax = errors.empty + errors.syntax + errors.shape;
  const asked = n - transport;
  const rate = (x, d) => (d ? Math.round((x / d) * 1000) / 10 : null);
  return {
    cases: n,
    answered: asked,
    transportErrors: transport,
    ok, strictOk,
    lenient: count((r) => r.result.ok && r.result.lenient),
    degraded: count((r) => r.result.degraded),
    errors,
    // 構文の崩れ（空・JSON でない・形が違う）。前置きを外して読めたものも「崩れ」に数えます
    syntaxErrorRate: rate(syntax + count((r) => r.result.ok && r.result.lenient), asked),
    // 道具の名前・引数まで正しく呼べた割合
    validCallRate: rate(ok, asked),
    // 期待した道具を選んだ割合（期待を書いた問いだけ）
    expectedToolRate: rate(hit, expected.length),
    msAvg: n ? Math.round(rows.reduce((a, r) => a + (r.result.ms ?? 0), 0) / n) : 0,
  };
}
