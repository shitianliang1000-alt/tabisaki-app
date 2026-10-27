// locales/*.json を読み、言語を決めて i18n を作る（Node.js 用）。
import { readFileSync } from "node:fs";
import { createI18n, LANGS, pickLang, SOURCE_LANG } from "./i18n.mjs";

const dir = new URL("../../locales/", import.meta.url);
let cache;

export function loadCatalogs() {
  cache ??= Object.fromEntries(LANGS.map((l) => [l, JSON.parse(readFileSync(new URL(`${l}.json`, dir), "utf8"))]));
  return cache;
}

/**
 * 言語を決めます。--lang の値 → TABISAKI_LANG → 日本語。
 * 端末の LANG は見ません（英語の端末で日本語を使っている人が多いので、勝手に変えない）。
 */
export function resolveLang(explicit, env = process.env) {
  return pickLang(explicit) ?? pickLang(env.TABISAKI_LANG) ?? SOURCE_LANG;
}

export const i18nFor = (lang) => createI18n(lang ?? SOURCE_LANG, loadCatalogs());
