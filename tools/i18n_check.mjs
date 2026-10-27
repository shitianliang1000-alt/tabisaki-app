// 翻訳の点検（locales/*.json と、スポットの訳 kb/i18n/<言語>/*.json）。
//
//   ・誤り … 原文（ja.json）に無い鍵がある、{名前} の差し込みが原文と合わない、
//            JSON が読めない、訳の元のスポットが収録に無い
//   ・気になる点 … まだ訳していない鍵（原文の日本語が出ます）、原文が直って古くなった訳
//
//     node tools/i18n_check.mjs          # 結果を出す。誤りがあれば終了コード 1
//     node tools/i18n_check.mjs --md     # Markdown で出す（CI のまとめ欄に貼る用）
//
// 決まりは docs/i18n.md にあります。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { sourceHash, SOURCE_LANG } from "../packages/core/i18n.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const PLURAL = /\.(zero|one|two|few|many|other)$/;

const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const baseKey = (k) => k.replace(PLURAL, "");

/**
 * 画面の文の訳を、原文とくらべます。
 * @param {Record<string, Record<string, any>>} catalogs { ja: {...}, en: {...} }
 */
export function checkLocales(catalogs) {
  const errors = [];
  const warnings = [];
  const stats = {};
  const src = catalogs[SOURCE_LANG];
  if (!src) return { errors: [`${SOURCE_LANG}.json がありません`], warnings, stats };
  const srcKeys = Object.keys(src).filter((k) => k !== "_meta");
  const srcBases = new Set(srcKeys.map(baseKey));
  // 原文の鍵ごとの差し込み（数で変わる文は .other を見る）
  const srcVars = new Map(srcKeys.map((k) => [baseKey(k), vars(src[k])]));

  for (const [lang, cat] of Object.entries(catalogs)) {
    if (lang === SOURCE_LANG) continue;
    if (cat._meta?.lang !== lang) errors.push(`${lang}.json: _meta.lang が "${lang}" ではありません`);
    const keys = Object.keys(cat).filter((k) => k !== "_meta");
    for (const k of keys) {
      if (typeof cat[k] !== "string") { errors.push(`${lang}.json: ${k} が文字列ではありません`); continue; }
      if (!srcBases.has(baseKey(k))) { errors.push(`${lang}.json: ${k} は原文（${SOURCE_LANG}.json）にありません`); continue; }
      if (vars(cat[k]) !== srcVars.get(baseKey(k))) {
        errors.push(`${lang}.json: ${k} の差し込み {${vars(cat[k])}} が原文の {${srcVars.get(baseKey(k))}} と合いません`);
      }
    }
    const have = new Set(keys.map(baseKey));
    const missing = [...srcBases].filter((k) => !have.has(k));
    for (const k of missing) warnings.push(`${lang}.json: ${k} がまだ訳されていません（原文が出ます）`);
    stats[lang] = { translated: srcBases.size - missing.length, total: srcBases.size };
  }
  return { errors, warnings, stats };
}

/**
 * スポットの訳（kb/i18n/<言語>/<収録ファイル名>）を点検します。
 * @param {string} kbDir
 */
export function checkSpotOverlays(kbDir = path.join(ROOT, "kb")) {
  const errors = [];
  const warnings = [];
  const stats = {};
  const base = path.join(kbDir, "i18n");
  if (!existsSync(base)) return { errors, warnings, stats };
  for (const lang of readdirSync(base)) {
    let n = 0;
    for (const file of readdirSync(path.join(base, lang)).filter((f) => f.endsWith(".json"))) {
      const where = `kb/i18n/${lang}/${file}`;
      let overlay;
      try { overlay = JSON.parse(readFileSync(path.join(base, lang, file), "utf8")); } catch { errors.push(`${where}: JSON として読めません`); continue; }
      if (overlay.lang !== lang) errors.push(`${where}: lang が "${lang}" ではありません`);
      const shard = path.join(kbDir, file);
      if (!existsSync(shard)) { errors.push(`${where}: 元の収録ファイル kb/${file} がありません`); continue; }
      const spots = new Map(JSON.parse(readFileSync(shard, "utf8")).spots.map((s) => [s.id, s]));
      for (const [id, tr] of Object.entries(overlay.spots ?? {})) {
        n++;
        const spot = spots.get(id);
        if (!spot) { errors.push(`${where}: ${id} は収録にありません`); continue; }
        if (!tr.name) errors.push(`${where}: ${id} に name がありません`);
        if (!["human", "machine"].includes(tr.by)) errors.push(`${where}: ${id} の by は human か machine にしてください`);
        if (tr.sourceHash !== sourceHash(spot)) warnings.push(`${where}: ${id}（${spot.name}）は原文が変わりました。訳を見直してください（それまでは原文が出ます）`);
      }
    }
    stats[lang] = { spots: n };
  }
  return { errors, warnings, stats };
}

export function loadLocaleDir(dir = path.join(ROOT, "locales")) {
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(path.join(dir, f), "utf8"))]));
}

export function toMarkdown({ errors, warnings, stats }) {
  const out = ["## 翻訳の点検", ""];
  out.push("| 言語 | 画面の文 | スポットの訳 |", "| --- | --- | --- |");
  for (const [lang, s] of Object.entries(stats.locales ?? {})) {
    out.push(`| ${lang} | ${s.translated} / ${s.total} | ${stats.spots?.[lang]?.spots ?? 0} |`);
  }
  out.push("");
  out.push(errors.length ? `### 誤り（${errors.length}）` : "誤りはありません。", "", ...errors.map((e) => `- ${e}`), "");
  if (warnings.length) out.push(`### 気になる点（${warnings.length}）`, "", ...warnings.slice(0, 50).map((w) => `- ${w}`), "");
  return out.join("\n");
}

if (process.argv[1] === import.meta.filename) {
  let loc;
  try { loc = checkLocales(loadLocaleDir()); } catch (e) { loc = { errors: [`locales/ が読めません: ${e.message}`], warnings: [], stats: {} }; }
  const kb = checkSpotOverlays();
  const result = {
    errors: [...loc.errors, ...kb.errors],
    warnings: [...loc.warnings, ...kb.warnings],
    stats: { locales: loc.stats, spots: kb.stats },
  };
  if (process.argv.includes("--md")) {
    process.stdout.write(toMarkdown(result) + "\n");
  } else {
    for (const [lang, s] of Object.entries(result.stats.locales)) console.log(`${lang}: 画面の文 ${s.translated}/${s.total}`);
    for (const e of result.errors) console.log(`誤り: ${e}`);
    for (const w of result.warnings) console.log(`気になる点: ${w}`);
    if (!result.errors.length) console.log("誤りはありません。");
  }
  process.exitCode = result.errors.length ? 1 : 0;
}
