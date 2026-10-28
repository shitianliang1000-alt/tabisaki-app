// 知識ベース（kb/）の点検。
//
// 壊れていたら止める「誤り」と、人が見て決める「気になる点」を分けて出します。
//   ・誤り … 必須の項目が無い、座標が日本の外、id が重なる、知らない分類、営業時間の形が
//            おかしい、索引（index.json）の件数と中身が合わない、など
//   ・気になる点 … 説明文が無い、営業時間が「目安」のまま、同じ名前が近くに
//            ある、など（直すかどうかは人が決めます。自動では書き換えません）
//
//     node tools/kb_check.mjs            # 結果を出す。誤りがあれば終了コード 1
//     node tools/kb_check.mjs --md       # Markdown で出す（CI のまとめ欄に貼る用）
//
// 試験（tests/kb-check.test.js）からは checkKb() を直接呼びます。
// 週に1回の点検（.github/workflows/kb-check.yml）も、これを走らせます。

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { TAGS } from "../packages/core/src/tags.js";
import { categoryFix } from "./kb_rules.mjs";

const ROOT = path.join(import.meta.dirname, "..");

export const REQUIRED = ["id", "regionId", "name", "category", "lat", "lng", "fame_tier"];
export const FAME_TIERS = new Set(["major", "known", "hidden"]);
// アプリが知っている分類（packages/core/src/feasibility.js の滞在時間・営業時間の表と、
// ジャンルの表にあるもの）。ここに無い分類は、営業時間も料金も既定値に
// 黙って落ちるので、誤りとして止めます。足すときは packages/core/src/feasibility.js にも足します。
export const CATEGORIES = new Set([
  "観光名所", "寺院", "神社", "教会", "城", "史跡", "世界遺産", "町並み", "建築", "名勝", "天然記念物",
  "博物館", "美術館", "文化施設", "公園", "庭園", "国立公園", "国定公園", "自然",
  "山", "登山", "丘", "高原", "峠", "滝", "渓谷", "川", "湖", "島", "岬", "海岸", "海水浴場", "漁港", "灯台",
  "ダム", "展望台", "ロープウェイ", "乗り物", "温泉", "温泉地", "スキー場",
  "動物園", "水族館", "牧場", "遊園地", "テーマパーク",
  "道の駅", "市場", "商店街", "商業施設", "グルメ", "飲食店", "酒蔵", "年中行事",
]);
export const STATUSES = new Set(["open", "closed", "temporarily_closed", "seasonal"]);
export const BEST_TIMES = new Set(["morning", "evening", "sunset", "night"]);
const MMDD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// 定番コースで、となりのスポットまでこれより離れていたら誤り（バスで移る区間も含めた上限）
export const COURSE_HOP_KM = 5;

// 日本の範囲（沖ノ鳥島・南鳥島を含む、ゆるい箱）
const JP = { latMin: 20, latMax: 46, lngMin: 122, lngMax: 154 };

function km(a, b) {
  const R = 6371;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = p2 - p1;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * kb/ を読んで点検する。
 * @param {string} dir kb/ の場所
 * @returns {{errors: string[], warnings: string[], stats: object}}
 */
export function checkKb(dir = path.join(ROOT, "kb")) {
  const errors = [];
  const warnings = [];
  const read = (f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  if (!existsSync(path.join(dir, "index.json"))) {
    return { errors: ["kb/index.json がありません"], warnings, stats: {} };
  }
  const index = read("index.json");
  const regions = read(index.regionsFile ?? "regions.json").regions ?? [];
  const regionIds = new Set();
  for (const r of regions) {
    if (!r.id || !r.name) errors.push(`エリアに id か name がありません: ${JSON.stringify(r).slice(0, 80)}`);
    if (regionIds.has(r.id)) errors.push(`エリアの id が重なっています: ${r.id}`);
    regionIds.add(r.id);
  }

  const ids = new Set();
  const byName = new Map();
  const perPref = {};
  let total = 0;
  let withDesc = 0;
  let withHours = 0;
  let estHours = 0;
  const suspectOnsen = [];
  const noDescKnown = [];
  const byId = new Map();

  for (const shard of index.shards ?? []) {
    if (!existsSync(path.join(dir, shard.file))) {
      errors.push(`${shard.file}: 索引にあるのにファイルがありません`);
      continue;
    }
    const spots = read(shard.file).spots ?? [];
    if (shard.count !== spots.length) {
      errors.push(`${shard.file}: 索引の件数 ${shard.count} と中身 ${spots.length} が違います`);
    }
    const listed = new Set(shard.regions ?? []);
    perPref[shard.prefecture ?? shard.file] = spots.length;
    for (const s of spots) {
      total++;
      const where = `${shard.file} ${s.id ?? "(id なし)"} ${s.name ?? ""}`.trim();
      for (const k of REQUIRED) {
        if (s[k] === undefined || s[k] === null || s[k] === "") errors.push(`${where}: ${k} がありません`);
      }
      if (s.id) {
        byId.set(s.id, s);
        if (ids.has(s.id)) errors.push(`${where}: id が重なっています`);
        ids.add(s.id);
      }
      if (!isNum(s.lat) || !isNum(s.lng)
        || s.lat < JP.latMin || s.lat > JP.latMax || s.lng < JP.lngMin || s.lng > JP.lngMax) {
        errors.push(`${where}: 座標が日本の範囲の外です（${s.lat}, ${s.lng}）`);
      }
      if (s.regionId && !regionIds.has(s.regionId)) errors.push(`${where}: エリア ${s.regionId} がありません`);
      if (s.regionId && listed.size && !listed.has(s.regionId)) {
        errors.push(`${where}: エリア ${s.regionId} が索引のこの段に書かれていません`);
      }
      if (s.category && !CATEGORIES.has(s.category)) errors.push(`${where}: 分類「${s.category}」は知らない値です`);
      if (s.fame_tier && !FAME_TIERS.has(s.fame_tier)) errors.push(`${where}: fame_tier「${s.fame_tier}」は知らない値です`);
      // 営業時間は「時」の数（9.5 = 9:30）。夜をまたぐ店のため 30 までは許します。
      for (const k of ["open", "close"]) {
        if (s[k] !== undefined && (!isNum(s[k]) || s[k] < 0 || s[k] > 30)) {
          errors.push(`${where}: ${k} の形がおかしいです（${s[k]}）`);
        }
      }
      if (isNum(s.open) && isNum(s.close) && s.open >= s.close) {
        errors.push(`${where}: 開く時刻 ${s.open} が閉まる時刻 ${s.close} より後です`);
      }
      for (const k of ["dwell", "fee"]) {
        if (s[k] !== undefined && (!isNum(s[k]) || s[k] < 0)) errors.push(`${where}: ${k} がおかしいです（${s[k]}）`);
      }
      // 人が足した項目（kb/curated.json → tools/apply_curated.mjs）
      if (s.tags !== undefined) {
        if (!Array.isArray(s.tags)) errors.push(`${where}: tags が配列ではありません`);
        else for (const tg of s.tags) if (!(tg in TAGS)) errors.push(`${where}: タグ「${tg}」は知らない値です（packages/core/src/tags.js）`);
      }
      if (s.status !== undefined && !STATUSES.has(s.status)) errors.push(`${where}: status「${s.status}」は知らない値です`);
      if (s.best_time !== undefined && !(Array.isArray(s.best_time) && s.best_time.every((b) => BEST_TIMES.has(b)))) {
        errors.push(`${where}: best_time の形がおかしいです`);
      }
      if (s.season !== undefined) {
        const ok = Array.isArray(s.season) && s.season.every((x) => x?.key && x?.label && MMDD.test(x.from ?? "") && MMDD.test(x.to ?? ""));
        if (!ok) errors.push(`${where}: season の形がおかしいです（{key, label, from: "MM-DD", to: "MM-DD"}）`);
      }
      // 名前と分類が食い違っている（tools/fix_kb_quality.mjs --write で直せます）
      const fix = categoryFix(s);
      if (fix) warnings.push(`分類の取り違え: ${s.name}（${s.category} → ${fix.to}）`);
      // 「温泉」なのに名前に湯も温泉も無い（健康センター・宿のことが多い）
      if (s.category === "温泉" && s.name && !/温泉|湯|泉|スパ|spa|SPA|銭湯|サウナ/.test(s.name)) {
        suspectOnsen.push(s.name);
      }
      if (s.description) withDesc++;
      else if (s.fame_tier !== "hidden") noDescKnown.push(s.name);
      if (isNum(s.open)) withHours++;
      else estHours++;
      if (s.name) {
        const list = byName.get(s.name);
        if (list) list.push(s); else byName.set(s.name, [s]);
      }
    }
  }

  if (index.counts?.spots !== undefined && index.counts.spots !== total) {
    errors.push(`index.json の counts.spots ${index.counts.spots} と中身 ${total} が違います`);
  }
  if (index.counts?.regions !== undefined && index.counts.regions !== regions.length) {
    errors.push(`index.json の counts.regions ${index.counts.regions} と中身 ${regions.length} が違います`);
  }
  if (!(index.sources?.length > 0)) errors.push("index.json に出典（sources）がありません");

  // 同じ名前が 5〜20km の近さにある（5km 未満は試験で止めています）。
  // 別の場所のことも多いので、気になる点として人が見ます。
  for (const [name, list] of byName) {
    if (list.length < 2 || list.length > 20) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        // Wikidata で別の項目になっているものは、別の場所と分かっています。
        if (/^wd-/.test(list[i].id) && /^wd-/.test(list[j].id)) continue;
        const d = km(list[i], list[j]);
        if (d >= 5 && d < 20) warnings.push(`同じ名前が ${d.toFixed(1)}km の近さにあります: ${name}（${list[i].id} / ${list[j].id}）`);
      }
    }
  }

  if (suspectOnsen.length) {
    warnings.push(`「温泉」なのに名前に湯・温泉の無いもの ${suspectOnsen.length}件（健康センター・宿のことが多い）: ${suspectOnsen.slice(0, 8).join("、")}…`);
  }
  if (noDescKnown.length) {
    warnings.push(`有名・定番なのに説明文が無いもの ${noDescKnown.length}件: ${noDescKnown.slice(0, 8).join("、")}…`);
  }

  // 人が足した補い（kb/curated.json）と、定番の回り方（kb/model_courses.json）
  if (existsSync(path.join(dir, "curated.json"))) {
    const cur = read("curated.json");
    for (const id of Object.keys(cur.spots ?? {})) {
      if (!byId.has(id)) errors.push(`curated.json: ${id} が kb/ にありません（node tools/apply_curated.mjs で確かめられます）`);
    }
    for (const c of cur.closed ?? []) {
      if (byId.has(c.id)) errors.push(`curated.json: 閉館した ${c.name}（${c.id}）が収録に戻っています`);
    }
  }
  let courses = 0;
  if (existsSync(path.join(dir, "model_courses.json"))) {
    const seen = new Set();
    for (const c of read("model_courses.json").courses ?? []) {
      courses++;
      const at = `model_courses.json ${c.id ?? "(id なし)"}`;
      if (!c.id || !c.name || !Array.isArray(c.spots) || c.spots.length < 2) { errors.push(`${at}: id・name・2か所以上の spots が要ります`); continue; }
      if (seen.has(c.id)) errors.push(`${at}: id が重なっています`);
      seen.add(c.id);
      if (c.regionId && !regionIds.has(c.regionId)) errors.push(`${at}: エリア ${c.regionId} がありません`);
      const list = c.spots.map((id) => byId.get(id));
      c.spots.forEach((id, i) => { if (!list[i]) errors.push(`${at}: スポット ${id} がありません`); });
      for (let i = 1; i < list.length; i++) {
        if (!list[i - 1] || !list[i]) continue;
        const d = km(list[i - 1], list[i]);
        if (d > COURSE_HOP_KM) errors.push(`${at}: ${list[i - 1].name} → ${list[i].name} が ${d.toFixed(1)}km 離れています`);
      }
    }
  }

  const stats = {
    modelCourses: courses,
    spots: total,
    regions: regions.length,
    shards: (index.shards ?? []).length,
    withDescription: withDesc,
    withHours,
    hoursUnknown: estHours,
    perPrefecture: perPref,
    sources: (index.sources ?? []).map((s) => s.name),
  };
  return { errors, warnings, stats };
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");

export function toMarkdown({ errors, warnings, stats }, limit = 50) {
  const out = [];
  out.push(`## 知識ベースの点検`, "");
  out.push(errors.length ? `**誤り ${errors.length} 件**（直すまで公開できません）` : "誤りはありません。", "");
  out.push(`| 項目 | 件数 |`, `| --- | ---: |`);
  out.push(`| スポット | ${stats.spots ?? 0} |`);
  out.push(`| エリア | ${stats.regions ?? 0} |`);
  out.push(`| 説明文のあるスポット | ${stats.withDescription ?? 0}（${pct(stats.withDescription, stats.spots)}） |`);
  out.push(`| 営業時間のあるスポット | ${stats.withHours ?? 0}（${pct(stats.withHours, stats.spots)}） |`);
  out.push(`| 気になる点 | ${warnings.length} |`, "");
  if (errors.length) {
    out.push(`### 誤り`, "", ...errors.slice(0, limit).map((e) => `- ${e}`));
    if (errors.length > limit) out.push(`- …ほか ${errors.length - limit} 件`);
    out.push("");
  }
  if (warnings.length) {
    out.push(`### 気になる点（人が見て決めます）`, "", ...warnings.slice(0, limit).map((w) => `- ${w}`));
    if (warnings.length > limit) out.push(`- …ほか ${warnings.length - limit} 件`);
    out.push("");
  }
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkKb();
  if (process.argv.includes("--md")) {
    console.log(toMarkdown(result));
  } else {
    for (const e of result.errors) console.log(`誤り: ${e}`);
    for (const w of result.warnings.slice(0, 50)) console.log(`気になる点: ${w}`);
    if (result.warnings.length > 50) console.log(`気になる点: …ほか ${result.warnings.length - 50} 件`);
    const s = result.stats;
    console.log(`スポット ${s.spots}・エリア ${s.regions}・誤り ${result.errors.length}・気になる点 ${result.warnings.length}`);
  }
  process.exitCode = result.errors.length ? 1 : 0;
}
