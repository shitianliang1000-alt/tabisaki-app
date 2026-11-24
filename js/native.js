// 旅さき — 携帯アプリ（mobile/。Capacitor）の中で開いているときの違い。
//
// アプリでは、Web 版の画面（dist/）をそのまま端末の中から開きます。
// 画面の出どころは https://app.tabisaki（Android）・capacitor://app.tabisaki（iOS）
// のような、その端末の中にしか無いものになります（docs/mobile.md）。

import { PROXY_URL } from "../packages/core/src/config.js";

// 末尾の「/」をすべて外す。/\/+$/ は「/」が続く長い文字列で遅くなる
// （CodeQL: polynomial regular expression）ので、正規表現を使わない。
function trimSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** 携帯アプリの中で開いているか。Capacitor が window.Capacitor を置きます。 */
export function isNativeApp(cap = globalThis.Capacitor) {
  try {
    return cap?.isNativePlatform?.() === true;
  } catch {
    return false;
  }
}

/**
 * 共有するリンクの行き先（?p=… や旅程を付ける前の部分）。
 *
 * アプリの出どころのまま渡すと、受け取った人には開けません。アプリからは、
 * 公開しているチャットの画面（中継の Worker が配る /app）を渡します。
 *
 * @param {{origin:string, pathname:string}} loc
 * @param {boolean} native
 * @param {string} site 公開しているサイト（packages/core/src/config.js の PROXY_URL）
 */
export function shareBase(loc = globalThis.location, native = isNativeApp(), site = PROXY_URL) {
  if (native && /^https:\/\//.test(String(site ?? ""))) {
    return `${trimSlashes(String(site))}/app`;
  }
  return `${loc.origin}${loc.pathname}`;
}

/**
 * 携帯アプリの中から、相手のサイトを直接読む fetch（スクレイピングの設定のときだけ使います）。
 *
 * ブラウザの fetch はほかのサイトに断られる（CORS）ので、Capacitor の CapacitorHttp で
 * 端末から読みます。全体の fetch は差し替えません（中継への頼みは、いままでどおり
 * Origin を付けたブラウザの fetch で送ります）。
 *
 * @returns {null | ((url: string, init?: object) => Promise<object>)} アプリでなければ null
 */
export function nativeHttpFetch(cap = globalThis.Capacitor) {
  const http = cap?.Plugins?.CapacitorHttp;
  if (!isNativeApp(cap) || !http?.request) return null;
  return async (url, init = {}) => {
    const r = await http.request({
      url: String(url), method: "GET", headers: init.headers ?? {},
      responseType: "text", connectTimeout: 10000, readTimeout: 10000,
    });
    const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = typeof r.data === "string" ? r.data : JSON.stringify(r.data ?? "");
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status, url: r.url || String(url),
      headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
      text: async () => body,
    };
  };
}
