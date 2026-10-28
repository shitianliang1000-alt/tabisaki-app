// 旅さき — 携帯アプリ（mobile/。Capacitor）の中で開いているときの違い。
//
// アプリでは、Web 版の画面（dist/）をそのまま端末の中から開きます。
// 画面の出どころは https://app.tabisaki（Android）・capacitor://app.tabisaki（iOS）
// のような、その端末の中にしか無いものになります（docs/mobile.md）。

import { PROXY_URL } from "../packages/core/src/config.js";

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
    return `${String(site).replace(/\/+$/, "")}/app`;
  }
  return `${loc.origin}${loc.pathname}`;
}
