// 手元の LLM（Ollama など）につなぐための小さな道具（Issue #352）。
//
// 旅程を組むときに呼ぶのは OpenAI 互換の /v1/chat/completions だけです
// （js/ai.js の callLocal）。Ollama・LM Studio・llama.cpp の llama-server は
// どれもこの形で受けます。ここでは、その前の「つながるか・モデルはあるか」を
// 確かめ、だめなときに直しかたまで書いたエラーを返します。
//
// 外へは出ません。話す相手は、利用者が指した行き先（既定は 127.0.0.1:11434）
// だけです。モデルの取得（ollama pull）は、明示して頼まれたときだけ行います。

/** 既定で勧めるモデル。端末向けの大きさで、日本語の指示にも素直に従います。 */
export const DEFAULT_LOCAL_MODEL = "gemma4:e2b";

/**
 * 勧めるモデルの一覧（docs/local-llm.md と同じ中身）。
 * 大きさは Ollama のライブラリの表示（2026年10月）による目安です。
 */
export const RECOMMENDED_MODELS = [
  { name: "gemma4:e2b", download: "4.6〜7.5GB", memory: "8GB 以上", license: "Apache-2.0", note: "既定。ノートPCでも動く大きさ" },
  { name: "gemma4:e4b", download: "6.6〜9.5GB", memory: "12GB 以上", license: "Apache-2.0", note: "少し賢い。選定の当たりが良くなる" },
  { name: "gemma4:26b", download: "16〜19GB", memory: "24GB 以上", license: "Apache-2.0", note: "GPU か大きいメモリがあるとき" },
];

/**
 * 行き先を決めます。--llm-url → TABISAKI_LLM_URL → OLLAMA_HOST → 既定。
 * OLLAMA_HOST は「127.0.0.1:11434」のように http:// が無いこともあります。
 */
export function resolveBaseUrl(explicit, env = process.env) {
  let raw = String(explicit || env.TABISAKI_LLM_URL || env.OLLAMA_HOST || "http://127.0.0.1:11434").trim();
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw localError("bad_url", `LLM の行き先が URL になっていません: ${raw}`); }
  if (u.hostname === "0.0.0.0") u.hostname = "127.0.0.1";
  return u.origin + u.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function localError(code, message) {
  const e = new Error(message);
  e.name = "LocalLlmError";
  e.code = code;
  return e;
}

const NOT_RUNNING = (base) => `手元の LLM（${base}）につながりません。\n`
  + "  ・Ollama を入れていなければ: https://ollama.com/download から入れてください\n"
  + "  ・入れてあれば、別の端末で `ollama serve` を動かしてください\n"
  + "  ・ほかの場所で動かしているなら --llm-url=http://<ホスト>:<ポート> で指してください\n"
  + "  （tabisaki local setup で、まとめて確かめられます）";

async function getJson(fetchImpl, url, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

/**
 * つながるか、どのモデルがあるかを調べます。
 * Ollama なら /api/tags、ほかの OpenAI 互換サーバーなら /v1/models を見ます。
 *
 * @returns {Promise<{ok: true, baseUrl: string, runtime: "ollama"|"openai", models: string[]}>}
 */
export async function probeRuntime(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  try {
    const doc = await getJson(fetchImpl, `${baseUrl}/api/tags`, timeoutMs);
    const models = (doc?.models ?? []).map((m) => String(m?.name ?? m?.model ?? "")).filter(Boolean);
    return { ok: true, baseUrl, runtime: "ollama", models };
  } catch (e) {
    // /api/tags が無い（404）なら Ollama 以外。つながらないなら、ここで止めます。
    if (e?.status !== 404) throw localError("not_running", NOT_RUNNING(baseUrl));
  }
  try {
    const doc = await getJson(fetchImpl, `${baseUrl}/v1/models`, timeoutMs);
    const models = (doc?.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean);
    return { ok: true, baseUrl, runtime: "openai", models };
  } catch {
    throw localError("not_running", NOT_RUNNING(baseUrl));
  }
}

/** "gemma4:e2b" と "gemma4:e2b"・"gemma4" と "gemma4:latest" を同じものとみなします。 */
export function hasModel(models, name) {
  const norm = (n) => (String(n).includes(":") ? String(n) : `${n}:latest`);
  return models.some((m) => m === name || norm(m) === norm(name));
}

/**
 * 旅程を組む前の確認。つながらない・モデルが無いときは、直しかた付きで投げます。
 */
export async function ensureLocalModel({ baseUrl, model = DEFAULT_LOCAL_MODEL, fetchImpl } = {}) {
  const info = await probeRuntime(baseUrl, { fetchImpl });
  if (!hasModel(info.models, model)) {
    const have = info.models.length ? `入っているのは ${info.models.slice(0, 6).join("・")} です。` : "モデルが1つも入っていません。";
    const fix = info.runtime === "ollama"
      ? `\`ollama pull ${model}\`（または tabisaki local setup --pull）で取ってください。`
      : "サーバー側でそのモデルを読み込むか、--model= で入っているものを指してください。";
    throw localError("model_missing", `モデル「${model}」がありません。${have}\n  ${fix}`);
  }
  return info;
}

/** 実際に1回答えさせて、使えることを確かめます。 */
export async function pingModel({ baseUrl, model, fetchImpl = globalThis.fetch, timeoutMs = 120000 }) {
  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, temperature: 0, messages: [{ role: "user", content: "OKとだけ返してください。" }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === "TimeoutError") throw localError("timeout", `${model} が ${Math.round(timeoutMs / 1000)} 秒で答えませんでした（はじめての読み込みは時間がかかります。もう一度試してください）`);
    throw localError("not_running", NOT_RUNNING(baseUrl));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw localError("bad_reply", `${model} がエラーを返しました（HTTP ${res.status} ${text.slice(0, 160)}）`);
  }
  const data = await res.json();
  return { reply: String(data?.choices?.[0]?.message?.content ?? "").trim(), ms: Date.now() - started };
}

/**
 * Ollama にモデルを取らせます（POST /api/pull）。数GBの取得なので、
 * 進みぐあいを onProgress に渡します。Ollama のときだけ使えます。
 */
export async function pullModel({ baseUrl, model, fetchImpl = globalThis.fetch, onProgress = () => {} }) {
  const res = await fetchImpl(`${baseUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok || !res.body) throw localError("pull_failed", `モデルを取れませんでした（HTTP ${res.status}）`);
  const decoder = new TextDecoder();
  let buf = "";
  let last = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.error) throw localError("pull_failed", `モデルを取れませんでした: ${ev.error}`);
      last = ev;
      onProgress(ev);
    }
  }
  if (last?.status !== "success") throw localError("pull_failed", "モデルの取得が途中で終わりました（ネットにつながっているか確かめてください）");
}
