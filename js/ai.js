// モデルの担当は「意味の理解」と「選定」だけ。
//
//   ・場所の事実は知識ベースが持つ。モデルは候補から選ぶだけで、
//     返ってきたIDは候補集合と必ず照合する（存在しない場所を作らせない）。
//   ・時刻と移動時間は verify.js が判定する。モデルには判定させない。
//   ・1回目の案が実行不能なら、理由を渡して直させる（2パス）。
//
// モデルIDについて: config.MODEL が現在のAPIに存在しない場合は
// FALLBACK_MODELS を順に試します。どれが実際に動いたかは resolvedModel()
// で取得でき、画面にも表示します。

import {
  FALLBACK_MODELS, EMBED_DIM, EMBED_MODEL, LOCAL_BASE_URL,
  CF_FALLBACK_MODELS, CF_MODEL, LOCAL_MODEL, MODEL, MODEL_PROVIDER,
} from "./config.js";
import { endpointFor, keyHeaders, missingSecretHelp, proxyStatus,
         readProxyError, requestSignal, usingProxy } from "./endpoints.js";
import { effectiveConfig } from "./settings.js";
import { buildSearchText, extractKeywords } from "./keywords.js";
import { meteredFetch } from "./quota.js";
import { haversineKm } from "./feasibility.js";
import { joinAreaNames } from "./stays.js";

/**
 * どこへ投げるか。毎回読み直します。
 * 設定画面で入れたキー（localStorage）が config.js より優先されます。
 */
function net() {
  const c = effectiveConfig();
  // from（その値がどこから来たか）も持って回ります。落としていたので、
  // 中継を通していても診断に「中継なし（直接）」と出ていました。
  return { proxyUrl: c.proxyUrl, geminiKey: c.geminiKey,
           localBaseUrl: LOCAL_BASE_URL, from: c.from };
}

/**
 * 自分で立てたモデルを使うか（Gemma など）。
 *
 * 何が変わるか
 * ------------
 * 呼び出しに課金が発生しません。自分の機械で動かすからです。
 * そのかわり、Gemini でできていた2つが**できません**。
 *
 *   1. JSON の形をモデル側で強制する（responseSchema）
 *      → 「この形で返して」と頼み、読めなければ温度を下げて
 *        もう一度だけ聞きます（callModelJson）。
 *   2. Google 検索で裏を取る（グラウンディング）
 *      → 収録に無い土地を調べる discover.js が動きません。
 *        収録済みの範囲だけで組みます。
 *
 * 小さいモデルは指示の守りかたも弱くなりますが、このアプリは
 * モデルが返した ID を候補集合と必ず照合します。存在しない場所を
 * 作られても、そこで落ちます。旅程が壊れる方向には効きません。
 */
export function usingLocalModel() {
  return MODEL_PROVIDER === "local";
}

/** 中継（Cloudflare Worker）の中で動かすか。Googleのキーは要りません。 */
export function usingCloudflare() {
  return MODEL_PROVIDER === "cloudflare";
}

/** そのモデルは Gemma か。Gemini とは、できることが違います。 */
export function isGemma(model = MODEL) {
  return /gemma/i.test(String(model ?? ""));
}

/**
 * そのモデルで、Google 検索による裏取りができるか。
 *
 * **Gemma にはできません。** ツール（google_search）を受け取らないので、
 * 付けて投げると 400 が返ります。ここが true のままだと、収録に無い
 * 土地を調べる discover.js が毎回400を食らい、そのたびに「AIに聞け
 * ませんでした」に落ちていました。
 */
export function canGround() {
  return !usingLocalModel() && !usingCloudflare() && !isGemma();
}

let resolved = null;      // 実際に使えたモデルID
let triedOnce = false;

export function resolvedModel() {
  return resolved;
}

/**
 * AIキーが実際に使えるかを、1リクエストだけで確かめます。
 * どのモデルで通ったかも返すので、モデル名の指定違いもここで分かります。
 */
export async function diagnoseGeminiKey(signal) {
  if (usingCloudflare()) {
    try {
      const out = await callCloudflare(CF_MODEL, "OKとだけ返してください。",
                                       { temperature: 0, signal });
      return { ok: true, model: CF_MODEL,
        message: `${CF_MODEL} に接続できました（Cloudflare Workers AI）。`
          + "\nAIのキーは要りません。中継の中で動いています。"
          + `\n返事: ${out.slice(0, 40)}` };
    } catch (e) {
      return { ok: false, message:
        "Workers AI に接続できませんでした。"
        + "\nwrangler.jsonc の \"ai\" バインディングを入れて、配備し直して"
        + "ください（npx wrangler deploy）。"
        + `\n詳細: ${String(e?.message ?? e)}` };
    }
  }
  if (usingLocalModel()) {
    try {
      await callLocal("OKとだけ返してください。", { temperature: 0, signal });
      return { ok: true, model: LOCAL_MODEL,
        message: `${LOCAL_MODEL} に接続できました`
          + "（自分で立てたモデルです。検索による裏取りは行いません）。" };
    } catch (e) {
      return { ok: false, message:
        `${LOCAL_MODEL} に接続できませんでした（${e.message}）。`
        + "サーバーが動いているか、LOCAL_BASE_URL が合っているかを"
        + "確認してください。" };
    }
  }
  const cfg0 = net();
  if (usingProxy(cfg0)) {
    try {
      const st = await proxyStatus(cfg0, signal);
      if (st && st.secrets && st.secrets.GEMINI_API_KEY === false) {
        return { ok: false, message: missingSecretHelp("GEMINI_API_KEY",
          "AIのキー") };
      }
    } catch { /* 状態を取れなくても、下の実地の確認は行います */ }
  }
  if (!hasApiKey()) {
    return { ok: false, message: "AIのキーが空です。上の欄に Google AI Studio の"
      + "キーを貼ってください。未設定でも語句検索で動きますが、AIによる"
      + "選定は行われません。" };
  }
  // どこへ投げたのかを出します。中継の入口は設定画面と js/config.js の
  // 2か所から決まり、**設定画面のほうが勝ちます**。古い入口が残っていると
  // config.js を直しても効かないので、そこで気づけるようにします。
  const cfg = net();
  const where = (() => {
    try {
      const url = endpointFor("gemini:generate", { model: MODEL }, cfg);
      const from = cfg.from?.proxyUrl === "settings" ? "設定画面"
        : cfg.from?.proxyUrl === "config" ? "js/config.js" : "中継なし（直接）";
      return `\n投げ先: ${url}（${from}）`;
    } catch (e) {
      return `\n投げ先を決められません: ${String(e?.message ?? e)}`;
    }
  })();

  const errors = [];
  for (const model of modelCandidates()) {
    try {
      await callOnce(model, "OKとだけ返してください。", { temperature: 0, signal });
      resolved = model;
      return { ok: true, model,
        message: `${model} に接続できました。` + where };
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
      if (e.status === 403 || e.status === 401) break;
    }
  }
  const first = errors[0] ?? "";
  const hint = /40[13]/.test(first)
    ? "キーが拒否されました。Google AI Studio でキーを作り直すか、"
      + "そのキーで Generative Language API が有効か確認してください。"
    : /404/.test(first)
      ? "指定のモデルが見つかりません。config.js の MODEL を、"
        + "利用できるモデルIDに変えてください。"
      : "接続できませんでした。";
  return { ok: false, message: `${hint}${where}\n詳細: ${errors.join(" / ")}` };
}

// --- AIに聞けたかどうか ------------------------------------------------------
//
// AIが答えられないとき、このアプリは黙って「収録から機械的に選ぶ」ほうへ
// 落ちます。旅程は出るので、画面からは成功に見えます。**これが厄介です。**
// CSPで通信が止められていたときも、利用者には「AIの意見が入っていない
// 気がする」としか分かりませんでした。
//
// 落ちた理由をここに残し、旅程の注意書きとして出します。
let lastAiError = null;

/** 直近でAIに聞けなかった理由。聞けていれば null。 */
export function aiStatus() {
  return { error: lastAiError };
}

export function resetAiStatus() { lastAiError = null; }

/** 覚えた読み取りを捨てます（テストと、設定を変えたとき用）。 */
export function clearAiMemo() { understood.clear(); }

/** 呼び出し側の catch から使います。最初の理由だけを残します。 */
export function noteAiError(e) {
  const message = String(e?.message ?? e ?? "").slice(0, 200);
  if (!lastAiError && message) lastAiError = message;
  return null;
}

/**
 * 点の高い順に選ぶだけでは、散らばります。
 *
 * 「3大都市の美術館と建築」で、鹿児島市・京都市・箱根が選ばれていました。
 * 一つひとつは希望に合っていても、並べると move だけで2日が消えます。
 * すでに選んだ場所からの距離を点から差し引いて、順に選びます
 * （200kmごとに1点ぶん。よほど良い候補でなければ、遠くへは行きません）。
 *
 * 「必ず行く」で入ったエリアは、動かしません。
 */
export function coherentRegions(pool, limit, pinned = 0, groupById = null,
                                { enjoyTravel = false } = {}) {
  const out = pool.slice(0, pinned);
  const rest = pool.slice(pinned);
  const usedGroups = new Set(
    out.map((c) => groupById?.get(c.region.id)).filter(Boolean));
  while (out.length < limit && rest.length) {
    let bestI = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      // 移動を楽しみたい人には、寄り道の遠さを減点しません。
      const detour = out.length && !enjoyTravel
        ? Math.min(...out.map((o) => haversineKm(o.region, c.region)))
        : 0;
      // 「3大都市」のように街を名指しされたときは、まだ行っていない街を
      // 先に選びます。距離だけで選ぶと、いちばん近い1つの街に3エリアとも
      // 固まり、名指しされた意味が消えます。
      const group = groupById?.get(c.region.id);
      const fresh = group && !usedGroups.has(group) ? 8 : 0;
      const adjusted = (c.score ?? 0) + fresh - detour / 200;
      if (adjusted > bestScore) { bestScore = adjusted; bestI = i; }
    }
    const picked = rest[bestI];
    const g = groupById?.get(picked.region.id);
    if (g) usedGroups.add(g);
    out.push(picked);
    rest.splice(bestI, 1);
  }
  return out;
}

export function hasApiKey() {
  // 自分で立てたモデルは、キーという概念がありません。
  if (usingLocalModel() || usingCloudflare()) return true;
  // プロキシ経由なら、キーはサーバーが持っています。
  // ブラウザ側が空なのは正常なので、それで「使えない」とは判断しません。
  const c = net();
  return usingProxy(c) || Boolean(c.geminiKey);
}

/** モデル候補の順序。指定を最優先し、だめなら控えへ。 */
function modelCandidates() {
  const list = [MODEL, ...FALLBACK_MODELS, ...discovered].filter(Boolean);
  return [...new Set(resolved ? [resolved, ...list] : list)];
}

/**
 * このキーで実際に使えるモデル。
 *
 * 候補を全部試して全部404だったとき、**一度だけ**聞きに行きます。
 * Google 自身がそう言っているからです。
 *
 *   models/gemma-3-12b-it is not found for API version v1beta, or is
 *   not supported for generateContent. Call ModelService.ListModels to
 *   see the list of available models …
 *
 * この文は、英語であることより「**では何なら使えるのか**」が書いて
 * いないことが困ります。書いてある指示のとおりに聞けば、答えは
 * その場にあります。
 *
 * 聞いた結果は候補の末尾に足します。**こちらで名前を決め打ちしません。**
 * 決め打ちすると、そのモデルが廃止された日にまた同じことが起きます。
 */
let discovered = [];
let askedForModels = false;

/** 一覧の中から、旅程を作らせる順に並べ替えます。 */
export function rankModels(names) {
  const list = (names ?? []).map((n) => String(n ?? "").trim()).filter(Boolean)
    // 埋め込み・読み上げ・画像のモデルは、文を作れません。
    .filter((n) => !/embedding|embed|tts|image|vision-only|aqa/i.test(n))
    // 実験版・プレビュー版は最後に回します（黙って消えるためです）。
    .sort((a, b) => score(b) - score(a));
  return list;
}

function score(name) {
  let n = 0;
  // 設定と同じ系統をいちばん上に。
  if (/gemma/i.test(name)) n += 40;
  if (/flash/i.test(name)) n += 20;
  if (/lite/i.test(name)) n += 5;
  if (/pro/i.test(name)) n += 10;
  if (/exp|preview|latest|\d{4}-\d{2}-\d{2}/i.test(name)) n -= 30;
  return n;
}

/**
 * 使えるモデルを聞いて、候補に足します。
 *
 * @returns {Promise<string[]>} 使えるモデル（聞けなければ空）
 */
export async function listModels(opts = {}) {
  const cfg = effectiveConfig();
  let url;
  try {
    url = endpointFor("gemini:models", {}, cfg);
  } catch { return []; }
  try {
    const send = opts.fetchImpl ?? globalThis.fetch;
    // 中継は POST しか受けません。直に聞くときは Google の GET です。
    const viaProxy = usingProxy(cfg);
    const res = await send(url, {
      method: viaProxy ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...keyHeaders("gemini", cfg),
      },
      body: viaProxy ? "{}" : undefined,
      signal: requestSignal(opts.signal, 20_000),
    });
    if (!res?.ok) return [];
    const doc = await res.json();
    // 中継は名前だけを返します。直に聞いたときは Google の形です。
    const names = Array.isArray(doc?.models)
      ? doc.models.map((m) => (typeof m === "string" ? m
          : String(m?.name ?? "").replace(/^models\//, "")))
      : [];
    return rankModels(names);
  } catch {
    return [];
  }
}

/**
 * すべての呼び出しに共通する役割の指示。
 *
 * 同じことを毎回プロンプトの先頭に書くより、systemInstruction に置くほうが
 * 守られます。プロンプト本文は指示と資料が混ざるため、後ろに来る資料に
 * 引きずられて、先頭の禁止事項が薄れていました。
 */
const SYSTEM = [
  "あなたは日本の旅行プランナーです。",
  "守ること:",
  "・与えられた候補の中からだけ選ぶ。候補に無い場所・IDを作らない。",
  "・時刻や所要時間を自分で計算しない（別のプログラムが行います）。",
  "・確かでないことを、確かなように書かない。",
  "・出力は指定された JSON だけ。前置き・言い訳・コードフェンスを付けない。",
].join("\n");

/**
 * 送るリクエストの中身。
 *
 * `search: true` を渡すと Google 検索を使わせます。学習した知識だけでは
 * 「今なにが開いていて、何が行われているか」に答えられません。
 * 収録の無い場所を扱うにはこれが要ります。
 *
 * `schema` を渡すと、モデル側で JSON の形を強制します（構造化出力）。
 * 「JSON だけ返して」と頼むより確実で、括弧の欠けや前置きが消えます。
 * ただし検索と構造化出力は同時に使えないため、検索時は外します。
 */
export function buildModelRequest(prompt, {
  temperature = 0.4, search = false, schema = null, topP, thinking,
  model = MODEL,
} = {}) {
  // Gemma には構造化出力（responseSchema）がありません。付けて投げると
  // 400 が返り、モデルの候補を1つ落として次へ行ってしまいます。
  // かわりに「JSONだけを返してください」と本文で頼み、返事から JSON を
  // 拾います（extractJson）。もともと、切り詰められた応答のために
  // その道は用意してあります。
  const gemma = isGemma(model);
  const generationConfig = { temperature };
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  if (schema && !search && !gemma) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = schema;
  }
  // 選定は「候補を見比べて絞る」作業なので、考える余地があるほど当たります。
  // 対応しないモデルではこの項目は無視されます。
  if (Number.isFinite(thinking)) {
    generationConfig.thinkingConfig = { thinkingBudget: thinking };
  }
  let text = schema && !search && gemma
    ? `${prompt}\n\n出力は JSON だけにしてください。説明文や \`\`\` は付けないでください。`
    : prompt;
  const body = { contents: [], generationConfig };
  // Gemma には systemInstruction がありません。
  //
  // 付けて投げると 400（Developer instruction is not enabled）が返ります。
  // モデルの候補を順に落として、最後は「AIに聞けませんでした」になる——
  // Gemma に切り替えたのに使われていなかったのは、これです。
  // 役割の指示は、本文の先頭に置きます。
  if (gemma) {
    text = `${SYSTEM}\n\n---\n\n${text}`;
  } else {
    body.systemInstruction = { parts: [{ text: SYSTEM }] };
  }
  body.contents.push({ role: "user", parts: [{ text }] });
  // 検索の道具も Gemma は受け取りません。付けずに投げます
  // （そのぶん、裏取りはできません。canGround() が false を返します）。
  if (search && !gemma) body.tools = [{ google_search: {} }];
  return body;
}

/**
 * JSON スキーマの部品。Gemini は OpenAPI の一部を受け取ります。
 * propertyOrdering を付けないと、モデルが鍵の順を入れ替えて返すことがあり、
 * そのぶん出力が不安定になります。
 */
const S = {
  str: (description) => ({ type: "STRING", description }),
  strList: (description) => ({ type: "ARRAY", items: { type: "STRING" }, description }),
  enum: (values, description) => ({ type: "STRING", enum: values, description }),
};

/** 応答に付いてくる出典（検索を使った場合）。 */
export function extractSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const out = [];
  const seen = new Set();
  for (const c of chunks) {
    const uri = c?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push({ title: String(c.web.title ?? uri).slice(0, 80), url: uri });
  }
  const queries = data?.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];
  return { sources: out.slice(0, 8), queries: queries.slice(0, 5) };
}

/**
 * 自分で立てたサーバーへ投げます（OpenAI 互換の chat/completions）。
 *
 * Ollama・vLLM・llama.cpp・LM Studio が、どれもこの形を話します。
 * Gemini とは体裁が違うだけで、こちらがしたいことは同じです。
 *
 * `response_format: {type:"json_object"}` は、対応していれば効きます。
 * 対応していないサーバーでは無視されるので、渡して害はありません。
 * 形の保証にはならないので、読めなければ callModelJson が聞き直します。
 */
async function callLocal(prompt, opts = {}) {
  const { signal, temperature = 0.4, topP, schema } = opts;
  const url = endpointFor("local:generate", {}, net());
  const body = {
    model: LOCAL_MODEL,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
    ],
    temperature,
    stream: false,
  };
  if (Number.isFinite(topP)) body.top_p = topP;
  if (schema) body.response_format = { type: "json_object" };

  const res = await meteredFetch("gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  // 自分で立てたモデルは検索をしないので、出典はありません。
  // 前回の呼び出しの出典が残ったままにならないよう、必ず空に戻します。
  lastSources = { sources: [], queries: [] };
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Cloudflare の Workers AI で答えさせます。
 *
 * 中継の中で走るので、Googleのキーは要りません。構造化出力は無いので、
 * 本文で「JSONだけ」と頼み、返事から拾います（extractJson）。
 */
async function callCloudflare(model, prompt, opts = {}) {
  const { signal, temperature = 0.4, schema } = opts;
  const cfg = net();
  // Workers AI は中継の中で動きます。中継が無ければ、行き先がありません。
  if (!usingProxy(cfg)) {
    throw new Error("Workers AI を使うには PROXY_URL（Cloudflare Worker）が"
      + "要ります。js/config.js をご確認ください");
  }
  const url = endpointFor("cf:generate", {}, cfg);
  const text = schema
    ? `${prompt}\n\n出力は JSON だけにしてください。説明文や \`\`\` は付けないでください。`
    : prompt;
  const res = await meteredFetch("gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature,
      // JSONを返させるときは長くなります。既定（2048）のままだと、
      // 候補が多い旅程で途中で切れ、壊れたJSONになります。
      max_tokens: schema ? 4096 : 2048,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text },
      ],
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`${res.status} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  // 検索をしないので、出典はありません。前回の出典が残らないよう空にします。
  lastSources = { sources: [], queries: [] };
  const out = String(data?.text ?? "").trim();
  if (!out && data?.shape) {
    // 中継までは通っていて、返事の入れ物が想定と違う場合です。
    // 「空でした」だけだと直しようがないので、鍵の名前を渡します。
    const err = new Error(`返事が空でした（形: ${data.shape.join(", ")}）`);
    err.status = 502;
    throw err;
  }
  return out;
}

/**
 * 中継の断り文句を、そのまま持てる形の例外にします。
 *
 * これまでは「400 {\"error\":{...}}」という生の文字列を例外にしていました。
 * 画面にそのまま出るので、読んだ人には手がかりになりません。中継は
 * code / retryable / 日本語の message を返すので、それを持ちます。
 */
function proxyError(res, body) {
  const info = readProxyError(body, res.status);
  const err = new Error(info.message || `${res.status}`);
  err.status = res.status;
  err.code = info.code;
  err.retryable = info.retryable;
  err.retryAfter = info.retryAfter;
  return err;
}

/**
 * 中継を通すときは、**本文にモデル名を入れます**。
 *
 * Googleへ直に投げるときは、モデル名はURLに入ります
 * （/models/gemma-4-26b-a4b-it:generateContent）。中継の入口は
 * /gemini/generate の1本きりなので、URLでは伝わりません。中継は
 * 本文の model を見て投げ先を決め、上流へ渡す前にその項目を落とします。
 *
 * ここを入れ忘れていたので、中継は model="" を受け取り、
 * 「そのモデルは使えません」で全部断っていました。**モデル名の問題では
 * なく、名前が届いていませんでした。**どのモデルを指定しても同じ400が
 * 返るので、候補を順に落として「接続できませんでした」になります。
 */
function withModel(body, model, cfg) {
  return usingProxy(cfg) ? { ...body, model } : body;
}

async function callOnce(model, prompt, opts = {}) {
  const { signal } = opts;
  const cfg = net();
  const url = endpointFor("gemini:generate", { model }, cfg);
  const res = await meteredFetch("gemini", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...keyHeaders("gemini", cfg),
    },
    body: JSON.stringify(withModel(buildModelRequest(prompt, { ...opts, model }),
                                   model, cfg)),
    signal,
  });
  if (!res.ok) throw proxyError(res, await res.text().catch(() => ""));
  const data = await res.json();
  const text = replyText(data);
  lastSources = extractSources(data);
  return text;
}

// 直近の呼び出しで使われた出典。画面に「どこから得た情報か」を出します。
let lastSources = { sources: [], queries: [] };

export function lastGrounding() {
  return lastSources;
}

/**
 * モデルを呼んで、JSON として読み取ります。
 *
 * 構造化出力を使っていても、混雑時に切り詰められた応答が返ることがあります。
 * そこで黙って諦めると、AIを設定しているのに語句検索の結果が出ます。
 * 壊れていたら一度だけ、温度を下げて作り直させます。
 */
/**
 * Gemini/Gemma の返事から、答えの文だけを取り出す。
 *
 * Gemma 4 は考えた過程を `thought: true` の部分として先に返す。以前は全部を
 * つなげていたので、JSON を探す旅程づくりでは目立たなかったが、雑談や
 * 知識の質問では考えの途中（「* Input: …」）が答えとして画面に出ていた。
 * 答えの部分が無いときだけ、考えの部分を使う。
 */
export function replyText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const join = (list) => list.map((p) => p.text ?? "").join("").trim();
  return join(parts.filter((p) => !p.thought)) || join(parts);
}

export async function callModelJson(prompt, opts = {}) {
  const raw = await callModel(prompt, opts);
  try {
    return extractJson(raw);
  } catch (e) {
    const retry = await callModel(
      `${prompt}\n\n前回の応答は JSON として読めませんでした（${e.message}）。`
      + "指定した形の JSON だけを、もう一度返してください。",
      { ...opts, temperature: 0 });
    return extractJson(retry);
  }
}

/**
 * モデルを呼びます。存在しないID（404）や不正な引数（400）は
 * 次の候補へ進みます。それ以外のエラーはそのまま投げます。
 */
export async function callModel(prompt, opts = {}) {
  if (usingCloudflare()) {
    // 検索は使えません。呼び出し側が search を渡してきても外します。
    const { search: _drop, ...rest } = opts;
    let lastErr = null;
    for (const model of [CF_MODEL, ...CF_FALLBACK_MODELS]) {
      try {
        const out = await callCloudflare(model, prompt, rest);
        resolved = model;
        return out;
      } catch (e) {
        lastErr = e;
        // そのモデルが無い／使えないときだけ、次を試します。
        if (e.status === 404 || e.status === 400) continue;
        throw e;
      }
    }
    throw lastErr ?? new Error("利用できるモデルがありません");
  }
  if (usingLocalModel()) {
    // 検索は使えません。呼び出し側が search を渡してきても外します。
    // 黙って無視すると、「調べたつもりの推測」が返ります。
    const { search: _drop, ...rest } = opts;
    resolved = LOCAL_MODEL;
    return callLocal(prompt, rest);
  }
  if (!hasApiKey()) {
    throw new Error("AIのキーが未設定です（設定 →「開発者向け」から入力できます）");
  }

  let lastErr = null;
  for (let round = 0; round < 2; round++) {
    for (const model of modelCandidates()) {
      try {
        const text = await callOnce(model, prompt, opts);
        if (resolved !== model) {
          resolved = model;
          if (!triedOnce || model !== MODEL) {
            console.info(`[ai] 使用モデル: ${model}`
              + (model === MODEL ? "" : `（指定の ${MODEL} は使えませんでした）`));
          }
          triedOnce = true;
        }
        return text;
      } catch (e) {
        lastErr = e;
        // モデルが存在しない/使えない場合だけ次を試す
        if (e.status === 404 || e.status === 400) continue;
        throw e;
      }
    }
    // 候補が全部だめでした。**決め打ちの名前を増やすのではなく**、
    // このキーで何が使えるのかを聞いて、その中から選びます
    //（Google のエラー文が「ListModels を呼べ」と言っています）。
    if (askedForModels) break;
    askedForModels = true;
    discovered = await listModels(opts);
    if (!discovered.length) break;
    console.info(`[ai] 使えるモデルを聞き直しました: ${discovered.slice(0, 5).join(", ")}`);
  }
  // どれも使えなかったときは、**何なら使えるのか**まで書きます。
  // 「404」とだけ出しても、直す先が分かりません。
  if (discovered.length) {
    const err = new Error(
      `設定したモデル（${[MODEL, ...FALLBACK_MODELS].join("・")}）は、`
      + "このキーでは使えませんでした。"
      + `使えるのは ${discovered.slice(0, 6).join("・")} などです。`
      + "js/config.js の MODEL を書き換えてください。");
    err.status = lastErr?.status ?? 404;
    err.models = discovered;
    throw err;
  }
  throw lastErr ?? new Error("利用できるモデルがありません");
}

/** 試験と、設定を変えたときのために、聞き直した結果を捨てます。 */
export function resetModelDiscovery() {
  discovered = [];
  askedForModels = false;
}

// --- JSON の取り出し --------------------------------------------------------
// 構造化出力に対応しないモデルでも動くよう、返答から最初の完全な JSON を拾います。

export function extractJson(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new SyntaxError("空の応答です");
  try { return JSON.parse(text); } catch { /* 続行 */ }

  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(unfenced); } catch { /* 続行 */ }

  const start = unfenced.indexOf("{");
  if (start < 0) throw new SyntaxError("JSON が含まれていません");
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
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      return JSON.parse(unfenced.slice(start, i + 1));
    }
  }
  throw new SyntaxError("JSON が閉じていません");
}

// --- 1. 希望の読み取り ------------------------------------------------------

const UNDERSTAND_SCHEMA = {
  type: "OBJECT",
  properties: {
    searchText: S.str("この人が喜びそうな場所の特徴を描写する1〜2文。地名は入れない"),
    interests: { type: "ARRAY",
      items: S.enum(["onsen", "nature", "history", "food", "art", "sea", "city", "view"]) },
    pace: S.enum(["relaxed", "balanced", "packed"]),
    budgetHint: S.enum(["cheap", "normal", "generous"]),
    keywords: S.strList("説明文と照合するための日本語の語（3〜8語）"),
    avoid: S.strList("利用者が明確に避けたいと言ったもの。無ければ空"),
    // 「三都心」「京阪神」「北陸三県」のような、略した言い方・俗称が
    // 指す日本の地名。辞書に無い言い回しを、モデルが読み替えます。
    places: S.strList("略した言い方・俗称が指す、日本の都市・地域の名前（例: 三都心→東京・大阪・名古屋）。普通の地名は入れない。無ければ空"),
    // 名前のある旅のしかた（「最長片道切符」「国道1号線の旅」など）。
    // 行き先ではなく旅の形なので、地名と同じには扱えません（js/journeys.js）。
    journey: {
      type: "OBJECT",
      properties: {
        name: S.str("旅のしかた・切符・道・路線の名前。無ければ空文字"),
        meaning: S.str("それが何かを40字程度で"),
        transport: S.enum(["none", "transit", "car", "walk", "local", "ferry", "air"]),
        enjoyTravel: { type: "BOOLEAN" },
        along: S.strList("沿って訪れる日本の地名を順に（決まっていなければ空）"),
      },
      required: ["name", "meaning", "transport", "enjoyTravel", "along"],
      propertyOrdering: ["name", "meaning", "transport", "enjoyTravel", "along"],
    },
  },
  required: ["searchText", "interests", "pace", "budgetHint", "keywords", "avoid"],
  propertyOrdering: ["searchText", "interests", "pace", "budgetHint", "keywords", "avoid"],
};
// 複数の地名をひとまとめに言う呼び名（「三都心」「京阪神」）。js/areas.js の
// 辞書に無い言い方を、具体的な地名に直すためのものです。
UNDERSTAND_SCHEMA.properties.phrases = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      phrase: S.str("利用者の言葉にある、そのままの呼び名"),
      meaning: S.str("それが何を指すか、30字程度で"),
      names: S.strList("指す日本の地名（市や観光地の名前）。2〜6個"),
      ambiguous: { type: "BOOLEAN" },
    },
    required: ["phrase", "meaning", "names", "ambiguous"],
    propertyOrdering: ["phrase", "meaning", "names", "ambiguous"],
  },
};

const FALLBACK_PLAN = {
  searchText: "日帰りで楽しめる観光地",
  interests: [], pace: "balanced", budgetHint: "normal",
  keywords: ["観光", "名所"], avoid: [],
};

/**
 * 同じ希望文を、二度読み取らせない。
 *
 * 「もっとゆっくり」を押す、案を選び直す、条件を少し変えて作り直す——
 * どれも希望文は同じままです。それでも毎回モデルに読み取らせていたので、
 * 押すたびに1回ぶんの枠と、その待ち時間を使っていました。読み取りの
 * 結果は同じ入力なら同じでよいので、その回のあいだは覚えておきます。
 *
 * 覚えるのはこのページを開いているあいだだけです（読み込み直せば消えます）。
 * 希望文・興味・時間のどれかが変われば、別のものとして聞き直します。
 */
const understood = new Map();
const UNDERSTOOD_MAX = 12;

export async function understandRequest(note, interests, hours, opts = {}) {
  const text = String(note ?? "").trim();
  if (!text && interests.length === 0) return { ...FALLBACK_PLAN, interests };
  if (!hasApiKey()) return keywordFallback(text, interests);

  const origin = String(opts.origin ?? "").trim();
  const key = JSON.stringify([text, [...interests].sort(), Math.round(hours), origin]);
  if (understood.has(key)) return { ...understood.get(key) };

  const prompt = [
    "利用者の希望から、旅先を検索するための条件を抽出してください。",
    "",
    `利用可能な時間: 約${Math.round(hours)}時間`,
    `選択済みの興味: ${interests.length ? interests.join(", ") : "（なし）"}`,
    `利用者の出発地: ${origin || "（不明）"}`,
    `利用者の言葉: 「${text || "（記述なし）"}」`,
    "",
    "searchText は、この人が喜びそうな場所の特徴を描写する1〜2文にしてください。",
    "地名や施設名は入れないでください（説明文と照合するためです）。",
    "keywords は、収録データの説明文に実際に出てきそうな語にしてください",
    "（「癒される」ではなく「露天風呂」「渓谷」のように、物の名前で）。",
    "avoid には、利用者が明確に断ったものだけを入れてください。",
    "書かれていないことを推測で足さないでください。",
    "",
    "利用者の言葉に、略した言い方・俗称・数え方（例: 三都心、3大都市、京阪神、",
    "北陸三県、東海道沿い）があれば、それが指す日本の都市・地域の名前を",
    "places に入れてください。ふつうの地名（京都、箱根）は入れません。",
    "指す先が決まっていなければ空にします。",
    "",
    "利用者の言葉に、名前のある旅のしかた（切符・道・路線・街道・巡礼など。",
    "例: 最長片道切符、国道1号線の旅、東海道五十三次、四国八十八か所、",
    "只見線、しまなみ海道）があれば、journey に書いてください。",
    "name はその名前、meaning はそれが何か、transport はその旅で使う乗り物",
    "（決まっていなければ none）、enjoyTravel は移動そのものが目的の旅なら true、",
    "along は沿って訪れる日本の地名（市町村や観光地の名前）を順に入れます。",
    "知らない名前を推測で説明しないでください。分からなければ name を空にします。",
    "その名前は keywords に入れないでください（場所の名前ではないためです）。",
    "",
    "利用者の言葉に、複数の地名をひとまとめに言う呼び名",
    "（例: 三都心、三大都市圏、京阪神、三都物語、日本三景、東海道メガロポリス）が",
    "あれば、phrases に書いてください。phrase は言葉にあるとおり、",
    "names はその呼び名が指す日本の地名を（市や観光地の名前で）入れます。",
    "「さん都心」のようにひらがなや数字で書かれていても同じです。",
    "呼び名の指す先が文脈で変わるとき（例: 「東京の三都心」は新宿・渋谷・池袋、",
    "「大阪の三都心」は梅田・難波・天王寺）は、書かれた地名に合わせて names を決めます。",
    "地名が書かれていなければ、利用者の出発地の街のこととして読みます。",
    "読みかたが人によって分かれる呼び名は、最も一般的な読みで names を埋め、",
    "ambiguous を true にしてください。知らない呼び名は推測せず、書かないでください。",
    "単なる地名（京都、東京）や、地方名（関東、九州）は書かないでください。",
  ].join("\n");

  try {
    // 抽出は当てものではないので、温度は低く固定します。
    const p = await callModelJson(prompt,
      { temperature: 0.1, topP: 0.8, schema: UNDERSTAND_SCHEMA, ...opts });
    const out = {
      searchText: p.searchText || FALLBACK_PLAN.searchText,
      interests: Array.isArray(p.interests) ? p.interests : interests,
      pace: ["relaxed", "balanced", "packed"].includes(p.pace) ? p.pace : "balanced",
      budgetHint: ["cheap", "normal", "generous"].includes(p.budgetHint)
        ? p.budgetHint : "normal",
      keywords: Array.isArray(p.keywords) ? p.keywords : [],
      avoid: Array.isArray(p.avoid) ? p.avoid : [],
      places: (Array.isArray(p.places) ? p.places : [])
        .map((x) => String(x ?? "").trim())
        .filter((x) => x.length >= 2 && x.length <= 12).slice(0, 8),
      journey: p.journey?.name ? p.journey : null,
      phrases: Array.isArray(p.phrases) ? p.phrases.slice(0, 4) : [],
    };
    if (understood.size >= UNDERSTOOD_MAX) {
      understood.delete(understood.keys().next().value);
    }
    understood.set(key, out);
    return { ...out };
  } catch (e) {
    noteAiError(e);
    return keywordFallback(text, interests);
  }
}

function keywordFallback(text, interests) {
  // 空白分割は日本語では使えないので、旅行語彙の辞書で抽出します。
  const { keywords, genres, moods } = extractKeywords(text);
  return {
    ...FALLBACK_PLAN,
    searchText: buildSearchText(text, interests),
    interests: [...new Set([...interests, ...genres])],
    keywords: keywords.length ? keywords : FALLBACK_PLAN.keywords,
    pace: moods.some((m) => ["ゆっくり", "のんびり", "まったり", "静か", "癒"]
      .some((x) => m.includes(x))) ? "relaxed" : "balanced",
  };
}

// --- 2. 検索用の埋め込み ----------------------------------------------------

export async function embedQuery(text, opts = {}) {
  // 埋め込みの入口があるのは Gemini だけです。
  //
  // Cloudflare を除いていなかったので、AI本体は Workers AI で動いている
  // のに、検索用のベクトルだけ /gemini/embed を呼んでいました。中継に
  // GEMINI_API_KEY が無ければ 503 で、握りつぶして語句検索に落ちます
  // ——**旅程を作るたびに、無駄な往復と待ち時間と失敗の記録**が出ます。
  // 呼ばずに語句検索へ落ちるほうが、速くて正直です。
  if (usingLocalModel() || usingCloudflare() || !EMBED_MODEL) return null;
  if (!hasApiKey()) return null;
  try {
    const cfg = net();
    const url = endpointFor("gemini:embed", { model: EMBED_MODEL }, cfg);
    const res = await meteredFetch("embed", url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...keyHeaders("gemini", cfg),
      },
      body: JSON.stringify({
        // 中継は本文の model を見て投げ先を決め、上流へ渡す前に落とします。
        // 「models/」を付けた名前は中継の許可リストに無いので、そのまま
        // 渡すと 400 になります。直に投げるときだけ付けます。
        model: usingProxy(cfg) ? EMBED_MODEL : `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_QUERY",
        outputDimensionality: EMBED_DIM,
      }),
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const values = data?.embedding?.values ?? data?.embeddings?.[0]?.values;
    return values?.length ? Float64Array.from(values) : null;
  } catch (e) {
    return noteAiError(e);
  }
}

// --- 3. 案を出す（1回目） ----------------------------------------------------

/**
 * 候補をモデルに読ませる形にします。
 *
 * 以前は名前と短い説明だけを渡していました。それだと「海が見たい」に
 * 山の展望台が混じります。分類・知名度に加えて、説明文を長めに、
 * ジャンルの札も添えると、選び違いがはっきり減りました。
 */
function describeCandidates(candidates) {
  const tierLabel = { major: "定番", known: "知る人ぞ知る", hidden: "穴場" };
  return candidates.map((c, ri) => {
    const spots = c.spots.map((s, si) => {
      const t = tierLabel[s.spot.fame_tier] ?? "";
      const desc = (s.spot.description || "（説明なし）").slice(0, 140);
      const genres = (s.spot.genres ?? []).slice(0, 3).join("/");
      const tags = [s.spot.category, t, genres].filter(Boolean).join(" / ");
      return `    ${ri + 1}-${si + 1}. id=${s.spot.id} 「${s.spot.name}」[${tags}]\n`
        + `        ${desc}`;
    }).join("\n");
    const head = `  [エリア${ri + 1}] regionId=${c.region.id} 「${c.region.name}」`
      + `（${c.region.prefecture}） 最寄駅:${c.region.station || "不明"}`
      + ` 収録${c.spots.length}か所`;
    return `${head}\n${spots}`;
  }).join("\n\n");
}

const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    regionIds: { type: "ARRAY", items: { type: "STRING" },
      description: "候補にある regionId を、訪れる順に" },
    headline: S.str("旅程の見出し（20字程度）"),
    rationale: S.str("この旅先を選んだ理由（2文）"),
    picks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          spotId: S.str("候補にある id をそのまま"),
          reason: S.str("この人にとってなぜ良いか（30字程度）"),
        },
        required: ["spotId", "reason"],
        propertyOrdering: ["spotId", "reason"],
      },
    },
  },
  required: ["regionIds", "headline", "rationale", "picks"],
  propertyOrdering: ["regionIds", "headline", "rationale", "picks"],
};

const PLAN_SHAPE = `{
  "regionIds": ["候補にある regionId", "..."],
  "headline": "旅程の見出し（20字程度）",
  "rationale": "この旅先を選んだ理由（2文）",
  "picks": [{ "spotId": "候補にある id", "reason": "選んだ理由（30字程度）" }]
}`;

/**
 * 候補から旅先とスポットを選ばせます。
 * @param {string} [feedback] 前回の検証で見つかった問題（2回目の呼び出し用）
 */
export async function proposePlan(candidates, plan, note, maxSpots, tierTargets,
                                  feedback = "", opts = {}) {
  if (!candidates.length) throw new Error("条件に合う旅先が見つかりませんでした。");
  const maxRegions = Math.max(1, opts.maxRegions ?? 1);
  const days = Math.max(1, opts.days ?? 1);
  // 絶対条件と希望条件は分けて渡します。混ぜると、モデルが
  // 「静かな場所がいい」と「ここには必ず行く」を同じ重みで扱います。
  const mustIds = new Set(opts.mustSpotIds ?? []);
  const avoidIds = new Set(opts.avoidSpotIds ?? []);

  const fallback = () => {
    // 絶対条件のスポットを含むエリアを最優先で入れる
    const mustFirst = candidates.filter((c) =>
      c.spots.some((s) => mustIds.has(s.spot.id)));
    const rest = candidates.filter((c) => !mustFirst.includes(c));
    const chosen = coherentRegions([...mustFirst, ...rest], maxRegions,
                                   mustFirst.length, opts.groupById,
                                   { enjoyTravel: opts.enjoyTravel });
    const perRegion = Math.max(1, Math.ceil(maxSpots / chosen.length));
    const picks = [];
    const taken = new Set();
    for (const c of chosen) {
      for (const s of c.spots) {
        if (!mustIds.has(s.spot.id) || taken.has(s.spot.id)) continue;
        taken.add(s.spot.id);
        picks.push({ spotId: s.spot.id, regionId: c.region.id,
                     reason: "必ず行くと指定された場所です", tier: s.spot.fame_tier,
                     pinned: true });
      }
    }
    for (const c of chosen) {
      let n = 0;
      for (const s of c.spots) {
        if (n >= perRegion) break;
        if (taken.has(s.spot.id) || avoidIds.has(s.spot.id)) continue;
        taken.add(s.spot.id);
        n++;
        picks.push({ spotId: s.spot.id, regionId: c.region.id,
                     reason: "ご希望に近い場所です", tier: s.spot.fame_tier });
      }
    }
    const names = joinAreaNames(chosen.map((c) => c.region.name));
    return {
      regionIds: chosen.map((c) => c.region.id),
      regionId: chosen[0].region.id,
      headline: `${names}をめぐる旅`,
      rationale: chosen.length > 1
        ? `${names}を順にめぐります。ご希望に近い場所が集まっているエリアを、`
          + "移動が少なくなる順に並べました。"
        : `${chosen[0].region.prefecture}の${names}。`
          + "ご希望に近い場所が集まっているエリアです。",
      picks: picks.slice(0, maxSpots),
      fromModel: false,
    };
  };
  if (!hasApiKey()) return fallback();

  const areaRule = maxRegions > 1
    ? `・${days}日間の旅なので、拠点を移しながら1〜${maxRegions}エリアを回ります。`
      + "regionIds に訪れる順で並べてください（1エリアに留まるほうが"
      + "良いと判断したなら1つだけでも構いません）。"
    : "・regionIds にはエリアを1つだけ入れてください。";

  const prompt = [
    `下の候補から旅先を選び、訪れるスポットを${maxSpots}か所選んでください。`,
    "少なく選ぶより、上限まで選んでください。行き先が少ない旅程は",
    "「せっかく来たのに空いた時間ができた」になります。",
    "入りきらないぶんは、あとでプログラムが削ります。",
    "",
    `利用者の希望: 「${note || "（記述なし）"}」`,
    `雰囲気: ${plan.searchText}`,
    `ペース: ${plan.pace}`,
    `日数: ${days}日`,
    plan.avoid?.length ? `避けたいもの: ${plan.avoid.join("、")}` : "",
    "",
    mustIds.size ? "【絶対条件】必ず守ってください。" : "",
    mustIds.size ? `・次のIDは必ず picks に含めること: ${[...mustIds].join(", ")}`
      + "（これらが含まれるエリアを選んでください）" : "",
    avoidIds.size ? `・次のIDは使わないこと: ${[...avoidIds].join(", ")}` : "",
    mustIds.size || avoidIds.size ? "" : "",
    "【希望条件】できるだけ沿ってください。",
    `・定番${tierTargets.major}か所、知る人ぞ知る${tierTargets.known}か所、`
      + `穴場${tierTargets.hidden}か所を目安に混ぜること。`,
    areaRule,
    "・候補にある id だけを使い、存在しない場所を作らないこと。",
    "・picks は訪問する順に並べ、エリアごとにまとめること",
    "（regionIds の順に、そのエリアのスポットを続けて並べる）。",
    `・${days}日ぶんの予定になるよう、1日あたり${Math.max(3, Math.round(maxSpots / days))}`
      + "か所を目安に選ぶこと。",
    "・同じような場所ばかりにしないこと（寺だけ、展望台だけ、にしない）。",
    // 車の旅は、ほしいものが電車の旅と違います。駅から遠いことは
    // 欠点になりません。むしろ、そこにしか無いものがあります。
    opts.touring
      ? "・**車（またはバイク）で回る旅です。** 駅からの近さは考えなくて"
        + "よいので、走って気持ちのいい道の先にある場所を選んでください"
        + "（峠・岬・展望台・湖畔・海沿い・高原・渓谷・道の駅など）。"
        + "駅前の商店街や、道の細い古い町並みは、駐める場所を探すことに"
        + "なるので、入れるとしても1日1か所までにしてください。"
      : "",
    opts.touring
      ? "・reason には、その場所までの道のどこがよいのかも書いてください"
        + "（「海沿いを30分走った先」など）。"
      : "",
    // 「日本全国」「九州」のような広い指定。点の高い候補はたいてい
    // 近くに固まっているので、言わないと1つの地方で終わります。
    opts.spread && maxRegions > 1
      ? "・行き先の指定が広い範囲（日本全国・地方全体など）です。"
        + "1つの地方や県に固めず、離れた地方・県から選んでください。"
      : "",
    // 移動を楽しみたい人（青春18きっぷ・乗り鉄など）。
    opts.enjoyTravel
      ? "・**移動そのものを楽しみたい人です。** 移動時間が長いことや、"
        + "遠いエリアであることは欠点ではありません。近場の1か所にまとめず、"
        + "列車で長く乗り継いでいけるエリア、車窓のよい路線（海沿い・"
        + "山あい・ローカル線）で結べるエリアを選んでください。"
        + "headline と rationale では、移動の道中の楽しみにも触れてください。"
      : "",
    "・利用者の言葉に地名や施設名があれば、それに当たる候補を必ず入れること。",
    "・reason には、その人の希望のどこに応えているかを書くこと。",
    "　どの場所にも書ける文（「有名です」「人気です」）は書かないこと。",
    feedback ? `\n${feedback}` : "",
    "",
    "候補:",
    describeCandidates(candidates),
    "",
    "次の形の JSON だけを返してください。",
    PLAN_SHAPE,
  ].filter(Boolean).join("\n");


  let raw;
  try {
    // 選定は好みの問題なので温度を残しますが、以前の 0.6 は
    // 「候補にある id」を書き崩すことがありました。
    raw = await callModelJson(prompt,
      { temperature: 0.35, topP: 0.9, schema: PLAN_SCHEMA, thinking: 2048, ...opts });
  } catch (e) {
    noteAiError(e);
    return fallback();
  }

  // モデルが選んだエリア（候補にあるものだけ、順序は保つ）
  const byId = new Map(candidates.map((c) => [c.region.id, c]));
  const rawIds = Array.isArray(raw?.regionIds)
    ? raw.regionIds : [raw?.regionId].filter(Boolean);
  const chosen = [];
  for (const id of rawIds) {
    const c = byId.get(id);
    if (c && !chosen.includes(c)) chosen.push(c);
    if (chosen.length >= maxRegions) break;
  }
  if (!chosen.length) return fallback();
  // 広い範囲の指定なのに、選んだエリアが全部同じ地方なら、言いつけを
  // 守っていません。散らして選ぶ手元の選びかたに切り替えます。
  if (opts.spread && opts.groupById && maxRegions > 1 && chosen.length > 1) {
    const groupOf = (c) => opts.groupById.get(c.region.id);
    const picked = new Set(chosen.map(groupOf));
    const offered = new Set(candidates.map(groupOf));
    if (picked.size === 1 && offered.size > 1) return fallback();
  }

  // 候補に存在するIDだけを採用する（作り話を通さない最後の関門）
  const allowed = new Map();
  for (const c of chosen) {
    for (const s of c.spots) allowed.set(s.spot.id, { spot: s.spot, regionId: c.region.id });
  }
  const seen = new Set();
  const picks = [];
  // 絶対条件は、モデルが落としていても必ず入れる
  for (const [id, hit] of allowed) {
    if (!mustIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    picks.push({ spotId: id, regionId: hit.regionId, pinned: true,
                 reason: "必ず行くと指定された場所です",
                 tier: hit.spot.fame_tier });
  }
  for (const p of raw.picks ?? []) {
    const hit = allowed.get(p?.spotId);
    if (!hit || seen.has(hit.spot.id) || avoidIds.has(hit.spot.id)) continue;
    seen.add(hit.spot.id);
    picks.push({
      spotId: hit.spot.id,
      regionId: hit.regionId,
      reason: String(p.reason ?? "ご希望に近い場所です").slice(0, 60),
      tier: hit.spot.fame_tier,
    });
    if (picks.length >= maxSpots) break;
  }
  // 足りなければ、選ばれたエリアから順に埋める
  for (const c of chosen) {
    for (const s of c.spots) {
      if (picks.length >= maxSpots) break;
      if (seen.has(s.spot.id) || avoidIds.has(s.spot.id)) continue;
      seen.add(s.spot.id);
      picks.push({ spotId: s.spot.id, regionId: c.region.id,
                   reason: "ご希望に近い場所です", tier: s.spot.fame_tier });
    }
  }
  if (!picks.length) return fallback();

  // エリアの並び順に picks をまとめ直す（モデルが混ぜて返してきても崩れない）
  const orderIndex = new Map(chosen.map((c, i) => [c.region.id, i]));
  picks.sort((a, b) => (orderIndex.get(a.regionId) ?? 0) - (orderIndex.get(b.regionId) ?? 0));

  const names = joinAreaNames(chosen.map((c) => c.region.name));
  return {
    regionIds: chosen.map((c) => c.region.id),
    regionId: chosen[0].region.id,
    headline: String(raw.headline || `${names}をめぐる旅`).slice(0, 40),
    rationale: String(raw.rationale || "").slice(0, 200)
      || `${names}周辺にご希望に合う場所が集まっています。`,
    picks,
    fromModel: true,
  };
}

// --- 4. スポットの説明 ------------------------------------------------------

export async function describeSpot(spot, opts = {}) {
  if (!hasApiKey()) return spot.description ?? "";
  const prompt = [
    "次の場所について、旅行者向けに3〜4文で紹介してください。",
    "与えられた情報の範囲で書き、事実を追加しないでください。",
    "説明文だけを返してください。",
    "",
    `名前: ${spot.name}`,
    `分類: ${spot.category}`,
    `場所: ${spot.prefecture ?? ""} ${spot.region ?? ""}`,
    `説明: ${spot.description || "（詳細な説明なし）"}`,
  ].join("\n");
  try {
    return (await callModel(prompt, { temperature: 0.7, ...opts }))
      || spot.description || "";
  } catch (e) {
    noteAiError(e);
    return spot.description ?? "";
  }
}
