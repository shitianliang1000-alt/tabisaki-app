// ブラウザに残す設定（APIキーとプロキシの入口）。
//
// なぜ要るか
// ----------
// これまでキーを書ける場所は packages/core/src/config.js の1か所だけでした。
// 手元で動かすならそれで足りますが、GitHub Pages のように **公開した
// サイトを開いて使う** 人には、書き換える手段がありません。
// 「Routes API が使えない」の正体の一つがこれです。config.js が空の
// まま公開されているので、誰が開いても距離からの推定に落ちていました。
//
// ここでは、設定画面から入れたキーを **その端末の localStorage** に
// 残します。サーバーへは送りません。同じ端末・同じブラウザの中だけで
// 効きます（他の人がそのサイトを開いても、あなたのキーは見えません）。
//
// 優先順位
// --------
//   1. 設定画面で入れたもの（localStorage）
//   2. packages/core/src/config.js に書いたもの
//   3. 空（＝使わない）
//
// 「設定画面で空にする」と、config.js の値に戻ります。config.js の値を
// 上書きして「空にする」ことはできません。公開サイトで config.js に
// キーを書く構成は、そもそも避けてください（誰からも見えます）。

import { GEMINI_API_KEY, MAPS_API_KEY, PROXY_URL } from "./config.js";

export const SETTINGS_KEY = "tabisaki.settings";

/** 設定画面で扱う項目。ここに無いものは保存しません。 */
const FIELDS = ["proxyUrl", "geminiKey", "mapsKey"];

function store(storage) {
  return storage ?? globalThis.localStorage ?? null;
}

/**
 * 保存してある設定を読みます。壊れていたら空扱いです。
 * @param {Storage} [storage] 試験用の差し替え口
 * @returns {{proxyUrl:string, geminiKey:string, mapsKey:string}}
 */
export function loadSettings(storage) {
  const out = { proxyUrl: "", geminiKey: "", mapsKey: "" };
  try {
    const raw = store(storage)?.getItem(SETTINGS_KEY);
    if (!raw) return out;
    const doc = JSON.parse(raw);
    for (const f of FIELDS) {
      if (typeof doc?.[f] === "string") out[f] = doc[f].trim();
    }
  } catch { /* 読めなければ、無かったことにします */ }
  return out;
}

/**
 * 入力を整えて、受け付けられない値には理由を返します。
 *
 * ここで弾くのは「動かないことが分かっている形」だけです。
 * キーが本物かどうかは、設定画面の「確認」ボタンで実際に1回叩いて
 * 確かめます（このモジュールは通信しません）。
 *
 * @returns {{value:object, errors:string[]}}
 */
export function normalizeSettings(input = {}) {
  const value = { proxyUrl: "", geminiKey: "", mapsKey: "" };
  const errors = [];
  for (const f of FIELDS) value[f] = String(input[f] ?? "").trim();

  if (value.proxyUrl) {
    if (!/^https:\/\/[^\s/]+/i.test(value.proxyUrl)) {
      errors.push("プロキシの入口は https:// で始まるURLを指定してください"
        + "（http では通信の中身が読まれます）");
    }
    value.proxyUrl = value.proxyUrl.replace(/\/+$/, "");
  }
  for (const f of ["geminiKey", "mapsKey"]) {
    // 貼り付けで紛れ込みやすいものだけを落とします。
    // 引用符・空白・改行が入ったキーは、必ず 400 で拒否されます。
    value[f] = value[f].replace(/^["'`\s]+|["'`\s]+$/g, "");
    if (/\s/.test(value[f])) {
      errors.push(`${f === "geminiKey" ? "AI" : "経路"}のキーに空白や改行が入っています`);
    }
  }
  return { value, errors };
}

/**
 * 保存します。空文字は「config.js の値に戻す」の意味です。
 * @returns {{ok:boolean, errors:string[], value:object}}
 */
export function saveSettings(input, storage) {
  const { value, errors } = normalizeSettings(input);
  if (errors.length) return { ok: false, errors, value };
  try {
    const s = store(storage);
    if (!s) return { ok: false, errors: ["この環境では設定を保存できません"], value };
    if (!value.proxyUrl && !value.geminiKey && !value.mapsKey) {
      s.removeItem(SETTINGS_KEY);
    } else {
      s.setItem(SETTINGS_KEY, JSON.stringify(value));
    }
    return { ok: true, errors: [], value };
  } catch (e) {
    return { ok: false, errors: [`保存できませんでした（${e?.message ?? e}）`], value };
  }
}

/** 保存したものを消して、config.js の値に戻します。 */
export function clearSettings(storage) {
  try { store(storage)?.removeItem(SETTINGS_KEY); } catch { /* 無視 */ }
}

/**
 * いま実際に効いている設定。routes.js / ai.js はこれを見ます。
 *
 * 毎回読み直すので、設定画面で保存した直後から効きます
 * （ページの再読み込みは要りません）。localStorage の読み出しは
 * 1回の旅程作成で数十回ですが、数μs なので気にしなくて構いません。
 *
 * @returns {{proxyUrl:string, geminiKey:string, mapsKey:string,
 *            from:{proxyUrl:string, geminiKey:string, mapsKey:string}}}
 *   from は "settings" | "config" | "none"。設定画面の表示に使います。
 */
export function effectiveConfig(storage, defaults = {}) {
  const saved = loadSettings(storage);
  const base = {
    proxyUrl: String(defaults.proxyUrl ?? PROXY_URL ?? "").trim(),
    geminiKey: String(defaults.geminiKey ?? GEMINI_API_KEY ?? "").trim(),
    mapsKey: String(defaults.mapsKey ?? MAPS_API_KEY ?? "").trim(),
  };
  const out = { from: {} };
  for (const f of FIELDS) {
    if (saved[f]) { out[f] = saved[f]; out.from[f] = "settings"; }
    else if (base[f]) { out[f] = base[f]; out.from[f] = "config"; }
    else { out[f] = ""; out.from[f] = "none"; }
  }
  return out;
}

/** 画面に出すときの伏せ字。末尾4文字だけ残します。 */
export function maskKey(key) {
  const k = String(key ?? "");
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return `${"•".repeat(Math.min(12, k.length - 4))}${k.slice(-4)}`;
}

/**
 * index.html の CSP（connect-src）が、その行き先を許しているか。
 *
 * ブラウザで入れたプロキシは、CSP の meta タグを書き換えられないため、
 * connect-src に無ければ接続そのものが拒まれます。保存はできても
 * 動かない、を黙って通さないための確認です。
 */
export function cspAllows(url, doc = globalThis.document) {
  if (!url || !doc) return true;
  const meta = doc.querySelector?.('meta[http-equiv="Content-Security-Policy"]');
  const csp = meta?.getAttribute("content") ?? "";
  const m = /connect-src([^;]*)/i.exec(csp);
  if (!m) return true;
  let origin;
  try { origin = new URL(url).origin; } catch { return false; }
  const sources = m[1].trim().split(/\s+/);
  return sources.some((s) => {
    if (s === "*" || s === "https:") return true;
    if (s === "'self'" && globalThis.location?.origin === origin) return true;
    if (s.startsWith("https://*.")) {
      return origin.endsWith(s.slice("https://*".length));
    }
    return s.replace(/\/+$/, "") === origin;
  });
}
