// ハイブリッドモデルルーター（Issue #439）。
//
// 手元のモデル（Ollama などで動かす小さな Gemma）とクラウドのモデル
// （中継または Google の API で動かす Gemma 26B/31B）を、頼みごとに使い分けます。
//
//   1. Web 検索が要る頼みは、クラウドに回します（手元のモデルは検索できません）。
//   2. それ以外は、まず手元のモデルに聞きます。
//   3. 返事の確信度（トークンごとの確率。logprobs）が閾値より低ければ、
//      同じ頼みをクラウドに聞き直します（ハンドオーバー）。
//   4. どちらかが答えられなければ、もう片方の答えを使います。
//
// どちらに回したか・なぜか・確信度はいくつだったかを、1件ずつ記録します
// （頼みの文そのものは記録しません。長さだけです）。閾値は記録を見て直せます
// （suggestThreshold）。
//
// このファイルは通信しません。判断と記録だけを持ちます（ai.js が呼びます）。
// ブラウザでも端末でも動くよう、Node 専用のものは使いません。

/** 既定の閾値。手元の返事の確信度がこれ未満なら、クラウドに聞き直します。 */
export const DEFAULT_THRESHOLD = 0.75;

/** logprobs が無いときの確信度の目安（形が読めたかどうかしか分からないため）。 */
export const HEURISTIC_OK = 0.8;

/** 記録を手元にいくつまで持つか（それより古いものは捨てます）。 */
export const LOG_SIZE = 200;

/**
 * 閾値を 0〜1 の数に整えます。読めなければ既定に戻します。
 * @param {unknown} v
 */
export function normalizeThreshold(v) {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.min(1, Math.max(0, n));
}

/**
 * OpenAI 互換の返事に付いた logprobs から、確信度（0〜1）を出します。
 *
 * 確信度 = トークンの確率の幾何平均（= exp(logprob の平均)）。
 * 1つでも大きく迷ったトークンがあると下がるよう、最も低い確率も見て、
 * それが 0.05 を下回るときは 1 割だけ下げます（数字や地名の言い切りで迷った印）。
 *
 * @param {{content?: {logprob: number}[]} | {logprob: number}[] | null | undefined} logprobs
 * @returns {number | null} 読めなければ null
 */
export function confidenceFromLogprobs(logprobs) {
  const list = Array.isArray(logprobs) ? logprobs : logprobs?.content;
  if (!Array.isArray(list)) return null;
  const lps = list.map((t) => Number(t?.logprob)).filter((x) => Number.isFinite(x) && x <= 0);
  if (!lps.length) return null;
  const mean = lps.reduce((a, b) => a + b, 0) / lps.length;
  let conf = Math.exp(mean);
  if (Math.exp(Math.min(...lps)) < 0.05) conf *= 0.9;
  return round(conf);
}

/**
 * 手元の返事の確信度を決めます。
 *
 * logprobs があればそれを使います（method: "logprobs"）。無い実行環境では、
 * 返事が空でないか・JSON を頼んだなら読めるかだけで決めます（method: "heuristic"）。
 *
 * @param {{text: string, logprobs?: unknown}} reply
 * @param {{expectJson?: boolean, parse?: (s: string) => unknown}} [opts]
 * @returns {{confidence: number, method: "logprobs" | "heuristic"}}
 */
export function scoreReply(reply, { expectJson = false, parse = null } = {}) {
  const text = String(reply?.text ?? "").trim();
  if (!text) return { confidence: 0, method: "heuristic" };
  if (expectJson && parse) {
    try { parse(text); } catch { return { confidence: 0, method: "heuristic" }; }
  }
  const lp = confidenceFromLogprobs(reply?.logprobs);
  if (lp !== null) return { confidence: lp, method: "logprobs" };
  return { confidence: HEURISTIC_OK, method: "heuristic" };
}

/**
 * はじめにどちらへ回すかを決めます（手元に聞く前に決まるもの）。
 *
 * @param {{needsWeb?: boolean, cloudAvailable?: boolean, localAvailable?: boolean,
 *          force?: "local" | "cloud" | null}} q
 * @returns {{first: "local" | "cloud", reason: string, mayHandOver: boolean}}
 */
export function planRoute({ needsWeb = false, cloudAvailable = true, localAvailable = true, force = null } = {}) {
  if (force === "local" && localAvailable) return { first: "local", reason: "forced_local", mayHandOver: false };
  if (force === "cloud" && cloudAvailable) return { first: "cloud", reason: "forced_cloud", mayHandOver: false };
  if (!cloudAvailable) return { first: "local", reason: needsWeb ? "web_needed_but_offline" : "cloud_unavailable", mayHandOver: false };
  if (needsWeb) return { first: "cloud", reason: "web_search", mayHandOver: false };
  if (!localAvailable) return { first: "cloud", reason: "local_unavailable", mayHandOver: false };
  return { first: "local", reason: "local_first", mayHandOver: true };
}

/**
 * 手元の確信度を見て、クラウドへ聞き直すかを決めます。
 * @param {number} confidence
 * @param {number} threshold
 */
export function shouldHandOver(confidence, threshold = DEFAULT_THRESHOLD) {
  return !(Number(confidence) >= normalizeThreshold(threshold));
}

/**
 * 記録の入れもの。新しいものが後ろです。
 * onRecord を渡すと、1件ごとに呼びます（端末ではファイルへ書き足します）。
 *
 * @param {{size?: number, onRecord?: (entry: object) => void}} [opts]
 */
export function createRouteLog({ size = LOG_SIZE, onRecord = null } = {}) {
  const items = [];
  let seq = 0;
  return {
    /** @param {object} entry */
    record(entry) {
      const e = { seq: ++seq, at: new Date().toISOString(), ...entry };
      items.push(e);
      if (items.length > size) items.splice(0, items.length - size);
      try { onRecord?.(e); } catch { /* 記録に失敗しても、答えは返します */ }
      return e;
    },
    entries: () => items.slice(),
    clear: () => { items.length = 0; },
  };
}

/**
 * 記録をまとめます（どちらへ何件・聞き直した割合・確信度の分布）。
 * @param {object[]} entries
 */
export function summarizeRoutes(entries = []) {
  const list = entries.filter((e) => e && typeof e === "object");
  const by = (k) => list.reduce((m, e) => { m[e[k]] = (m[e[k]] ?? 0) + 1; return m; }, {});
  const scored = list.filter((e) => Number.isFinite(e.confidence)).map((e) => e.confidence).sort((a, b) => a - b);
  const localTried = list.filter((e) => Number.isFinite(e.confidence)).length;
  const handed = list.filter((e) => e.handedOver).length;
  return {
    total: list.length,
    byRoute: by("route"),
    byReason: by("reason"),
    localTried,
    handedOver: handed,
    handOverRate: localTried ? round(handed / localTried) : 0,
    confidence: scored.length
      ? { min: scored[0], p25: pct(scored, 0.25), median: pct(scored, 0.5), p75: pct(scored, 0.75), max: scored.at(-1) }
      : null,
  };
}

/**
 * 「手元で答えた返事のうち、何割をクラウドに回したいか」から閾値を出します。
 *
 * 記録の確信度を並べ、下から target の割合のところを閾値にします。
 * 記録が少なすぎる（minSamples 未満）ときは、決めずに null を返します。
 *
 * @param {object[]} entries
 * @param {{target?: number, minSamples?: number}} [opts] target は 0〜1（既定 0.2 = 2割を回す）
 * @returns {number | null}
 */
export function suggestThreshold(entries = [], { target = 0.2, minSamples = 20 } = {}) {
  const scored = entries.filter((e) => e?.method === "logprobs" && Number.isFinite(e.confidence))
    .map((e) => e.confidence).sort((a, b) => a - b);
  if (scored.length < minSamples) return null;
  const t = Math.min(1, Math.max(0, Number(target) || 0));
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // 下から t の割合が「閾値未満」になる値。同じ値が続くときは、その値の少し上にします。
  const i = Math.min(scored.length - 1, Math.ceil(scored.length * t) - 1);
  return round(Math.min(1, scored[i] + 0.001));
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
