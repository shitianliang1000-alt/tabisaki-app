// 自前のモデル（自分でチューニングした Gemma など）へ、中継から聞きます。
//
// 画面はいままでどおり /gemini/generate に Gemini の形で頼みます。中継は、
// 自前のモデルの入口（OWN_MODEL_URL）が設定されていれば、先にそちらへ
// OpenAI 互換の形（POST /v1/chat/completions）に直して聞き、答えを Gemini の
// 形に戻して返します。自前のモデルが答えないときは、Google AI Studio に
// 聞き直します（GEMINI_API_KEY があれば）。
//
// OWN_MODEL_URL が無ければ、何も変わりません。
//
// 環境変数（wrangler の vars / secrets）
//   OWN_MODEL_URL         入口の土台。例 https://xxxx.endpoints.huggingface.cloud
//                         （/v1/chat/completions を足して呼びます。末尾が /v1 でも可）
//   OWN_MODEL_NAME        入口に渡すモデル名（既定 "tabisaki-gemma"）
//   OWN_MODEL_KEY         入口の鍵（secret。要らない入口なら空）
//   OWN_MODEL_TIMEOUT_MS  自前のモデルを待つ時間（既定 40000）。過ぎたら AI Studio へ
//   OWN_MODEL_FALLBACK    "off" にすると AI Studio へ聞き直しません（自前だけで試すとき）
//
// 詳しくは docs/own-model.md。

export const OWN_MODEL_DEFAULT_NAME = "tabisaki-gemma";
export const OWN_MODEL_DEFAULT_TIMEOUT_MS = 40_000;

/** 自前のモデルの入口が設定されているか。 */
export function ownModelConfigured(env) {
  return typeof env?.OWN_MODEL_URL === "string" && /^https?:\/\//.test(env.OWN_MODEL_URL.trim());
}

/** AI Studio へ聞き直してよいか。 */
export function ownModelFallbackAllowed(env) {
  return String(env?.OWN_MODEL_FALLBACK ?? "").trim().toLowerCase() !== "off";
}

/** 入口の土台から、chat/completions の URL を作ります。 */
export function chatUrl(base) {
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v1$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

export function ownModelTimeout(env) {
  const n = Number(env?.OWN_MODEL_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 110_000) : OWN_MODEL_DEFAULT_TIMEOUT_MS;
}

const partsText = (parts) => (Array.isArray(parts) ? parts : [])
  .filter((p) => !p?.thought)
  .map((p) => (typeof p?.text === "string" ? p.text : ""))
  .join("");

/**
 * Gemini の generateContent の頼み → OpenAI 互換の chat/completions の頼み。
 * 画面が送るのは文だけなので、文だけを移します（画像・道具は送りません）。
 */
export function geminiToChat(payload, model = OWN_MODEL_DEFAULT_NAME, { guidedSchema = null } = {}) {
  const messages = [];
  const sys = partsText(payload?.systemInstruction?.parts);
  if (sys.trim()) messages.push({ role: "system", content: sys });
  for (const c of Array.isArray(payload?.contents) ? payload.contents : []) {
    const content = partsText(c?.parts);
    if (!content) continue;
    messages.push({ role: c?.role === "model" ? "assistant" : "user", content });
  }
  const g = payload?.generationConfig ?? {};
  const body = { model, messages, stream: false };
  if (Number.isFinite(g.temperature)) body.temperature = g.temperature;
  if (Number.isFinite(g.topP)) body.top_p = g.topP;
  if (Number.isFinite(g.maxOutputTokens)) body.max_tokens = g.maxOutputTokens;
  if (g.responseMimeType === "application/json") body.response_format = { type: "json_object" };
  // 画面が形（JSON Schema）を添えてきたら、出力をその形にしばります（Guided Decoding。#435）。
  // vLLM なら Outlines / xgrammar が、形に合わないトークンを出させません。
  if (isSchema(guidedSchema)) {
    body.response_format = { type: "json_schema", json_schema: { name: "answer", schema: guidedSchema, strict: true } };
  }
  return body;
}

// 大きすぎる・形の違うものは使いません（中継に来た本文をそのまま上流へ渡すので）。
const isSchema = (s) => Boolean(s) && typeof s === "object" && !Array.isArray(s)
  && JSON.stringify(s).length <= 20_000;

/** OpenAI 互換の答え → Gemini の generateContent の答え（画面の replyText が読める形）。 */
export function chatToGemini(out, model = OWN_MODEL_DEFAULT_NAME) {
  const choice = out?.choices?.[0];
  const text = String(choice?.message?.content ?? choice?.text ?? "");
  const finish = choice?.finish_reason === "length" ? "MAX_TOKENS" : "STOP";
  const usage = out?.usage ?? {};
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: finish, index: 0 }],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens ?? 0,
      candidatesTokenCount: usage.completion_tokens ?? 0,
      totalTokenCount: usage.total_tokens ?? 0,
    },
    modelVersion: String(out?.model ?? model),
  };
}

/**
 * 自前のモデルに聞きます。答えが取れれば Gemini の形を、取れなければ
 * { error } を返します（投げません。呼ぶ側が AI Studio へ回します）。
 */
export async function askOwnModel(payload, env, { fetchImpl = fetch, guidedSchema = null } = {}) {
  const name = String(env?.OWN_MODEL_NAME ?? "").trim() || OWN_MODEL_DEFAULT_NAME;
  const headers = { "Content-Type": "application/json" };
  const key = String(env?.OWN_MODEL_KEY ?? "").trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetchImpl(chatUrl(env.OWN_MODEL_URL), {
      method: "POST",
      headers,
      body: JSON.stringify(geminiToChat(payload, name, { guidedSchema })),
      signal: AbortSignal.timeout(ownModelTimeout(env)),
    });
    // 形のしばりを受けない入口なら、しばらずに1度だけ聞き直します。
    if (!res.ok && isSchema(guidedSchema) && (res.status === 400 || res.status === 422)) {
      res = await fetchImpl(chatUrl(env.OWN_MODEL_URL), {
        method: "POST",
        headers,
        body: JSON.stringify(geminiToChat(payload, name)),
        signal: AbortSignal.timeout(ownModelTimeout(env)),
      });
    }
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
  if (!res.ok) return { error: `status_${res.status}` };
  const out = await res.json().catch(() => null);
  const data = chatToGemini(out, name);
  if (!data.candidates[0].content.parts[0].text.trim()) return { error: "empty" };
  return { data };
}
