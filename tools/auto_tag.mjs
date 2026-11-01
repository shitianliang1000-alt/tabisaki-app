// 属性タグの自動付与（設計ドキュメント §3.3 Phase 3 / §3.4、Issue #424）。
//
// カテゴリ・genres・名前・説明文・営業時間から §3.4 のタクソノミーのタグを
// ルールベースで推定し、kb/tags.json（オーバーレイ）として出力する。
// 本体シャードは書き換えない（names.json / regions.json と同じ重ね合わせ方式）。
//
// 使い方:
//   node tools/auto_tag.mjs           カバレッジのレポートのみ
//   node tools/auto_tag.mjs --write   kb/tags.json を生成する
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** §3.4 のタクソノミー（このツールが付与しうる範囲）。 */
export const TAXONOMY = {
  activity: ["sightseeing", "railway", "drive", "hiking", "shopping", "food", "onsen",
    "temple_visit", "museum", "aquarium", "zoo", "factory_tour", "night_view",
    "photography", "anime_pilgrimage", "retro_exploration"],
  atmosphere: ["romantic", "quiet", "lively", "nostalgic", "spiritual", "luxury",
    "casual", "adventurous", "educational", "photogenic"],
  time: ["day_only", "night_only", "day_and_night", "seasonal", "year_round"],
  transport: ["train_accessible", "car_recommended", "walkable", "bus_required", "ferry"],
  audience: ["solo_friendly", "couple_friendly", "family_friendly", "senior_friendly",
    "group_friendly", "railway_fans"],
};

const has = (s, re) => re.test(s ?? "");

/** 1スポット分のタグを推定する。根拠のあるタグだけを返す。 */
export function tagsForSpot(spot, region) {
  const t = { activity: [], atmosphere: [], time: [], transport: [], audience: [] };
  const add = (axis, v) => { if (!t[axis].includes(v)) t[axis].push(v); };
  const name = spot.name ?? "", cat = spot.category ?? "", desc = spot.description ?? "";
  const genres = spot.genres ?? [];
  const text = `${name} ${cat} ${desc}`;

  // activity（カテゴリと名前が主根拠）
  if (has(cat + name, /温泉/) || genres.includes("onsen")) add("activity", "onsen");
  if (has(cat + name, /寺|神社|大社|稲荷|八幡宮|天満宮|観音|霊場/)) add("activity", "temple_visit");
  if (has(cat + name, /美術館|博物館|資料館|記念館|文学館|科学館/)) add("activity", "museum");
  if (has(cat + name, /水族館/)) add("activity", "aquarium");
  if (has(cat + name, /動物園/)) add("activity", "zoo");
  if (has(cat + name, /駅|鉄道|電車|SL|ロープウェイ|ケーブルカー/) || genres.includes("railway")) add("activity", "railway");
  if (has(cat + name, /夜景|展望|タワー|スカイツリー/)) add("activity", "night_view");
  if (has(cat + name, /商店街|市場|モール|ショッピング|アウトレット|百貨店/)) add("activity", "shopping");
  if (genres.includes("food") || has(cat, /飲食|グルメ|カフェ|レストラン|食堂|菓子|パン/)) add("activity", "food");
  if (has(name + cat, /山$|岳|高原|渓谷|滝|登山|ハイキング|トレッキング/) || genres.includes("hiking")) add("activity", "hiking");
  if (has(text, /ドライブ|スカイライン|有料道路/)) add("activity", "drive");
  if (has(text, /工場見学|産業遺産|工場夜景/)) add("activity", "factory_tour");
  if (has(text, /アニメ|聖地巡礼/)) add("activity", "anime_pilgrimage");
  if (has(name + cat, /旧|レトロ|昭和|大正|明治|蔵|宿場/)) add("activity", "retro_exploration");
  if (t.activity.length === 0) add("activity", "sightseeing");

  // atmosphere
  if (t.activity.includes("temple_visit")) { add("atmosphere", "spiritual"); add("atmosphere", "quiet"); }
  if (t.activity.includes("onsen")) add("atmosphere", "quiet");
  if (has(cat + name, /商店街|市場|テーマパーク|遊園地/)) add("atmosphere", "lively");
  if (t.activity.includes("retro_exploration")) add("atmosphere", "nostalgic");
  if (t.activity.includes("night_view")) { add("atmosphere", "romantic"); add("atmosphere", "photogenic"); }
  if (has(text, /絶景|映え|フォトジェニック|写真/)) add("atmosphere", "photogenic");
  if (t.activity.includes("museum")) add("atmosphere", "educational");
  if (has(desc, /高級|ラグジュアリー|リゾート/)) add("atmosphere", "luxury");
  if (t.activity.includes("hiking")) add("atmosphere", "adventurous");

  // time（営業時間から機械的に決まる範囲）
  if (Number.isFinite(spot.open) && Number.isFinite(spot.close)) {
    if (spot.open === 0 && spot.close === 24) add("time", "day_and_night");
    else if (spot.close <= 18) add("time", "day_only");
    else if (spot.open >= 17) add("time", "night_only");
    else add("time", "day_and_night");
  }

  // transport / audience
  if (region?.station) add("transport", "train_accessible");
  if (t.activity.includes("railway")) add("audience", "railway_fans");
  if (has(region?.name ?? "", /島$/)) add("transport", "ferry");
  if (t.activity.includes("zoo") || t.activity.includes("aquarium") ||
      has(cat, /公園|テーマパーク|遊園地/)) add("audience", "family_friendly");
  if (t.activity.includes("onsen") || t.activity.includes("night_view")) add("audience", "couple_friendly");
  if (has(desc, /一人|ひとり|ソロ/)) add("audience", "solo_friendly");
  if (has(desc, /バリアフリー|車いす|車椅子/)) add("audience", "senior_friendly");

  const out = {};
  for (const [axis, vals] of Object.entries(t)) if (vals.length) out[axis] = vals;
  return out;
}

/** 全スポット分のタグマップを作る。 */
export function buildTags(regions, spots) {
  const byRegion = new Map(regions.map((r) => [r.id, r]));
  const tags = {};
  for (const s of spots) {
    const t = tagsForSpot(s, byRegion.get(s.regionId));
    if (Object.keys(t).length) tags[s.id] = t;
  }
  return tags;
}

export function loadKb(kbDir) {
  const regions = JSON.parse(readFileSync(path.join(kbDir, "regions.json"), "utf8")).regions;
  const index = JSON.parse(readFileSync(path.join(kbDir, "index.json"), "utf8"));
  const spots = [];
  for (const shard of index.shards) {
    const data = JSON.parse(readFileSync(path.join(kbDir, shard.file), "utf8"));
    spots.push(...(data.spots ?? []));
  }
  return { regions, spots };
}

const LICENSE = {
  derivedFrom: ["kb-spots"],
  note: "タグは kb のカテゴリ・説明文等からのルールベース推定。説明文由来の判定を含むため、派生物としては kb/attribution.json の kb-spots の扱いに従う。",
};

/** シャード（spots-jpXX-*.json）単位にタグファイルを組み立てる。 */
export function buildTagShards(kbDir, regions) {
  const index = JSON.parse(readFileSync(path.join(kbDir, "index.json"), "utf8"));
  const byRegion = new Map(regions.map((r) => [r.id, r]));
  const shards = [];
  for (const shard of index.shards) {
    const data = JSON.parse(readFileSync(path.join(kbDir, shard.file), "utf8"));
    const tags = {};
    for (const s of data.spots ?? []) {
      const t = tagsForSpot(s, byRegion.get(s.regionId));
      if (Object.keys(t).length) tags[s.id] = t;
    }
    shards.push({
      file: shard.file.replace(/^spots-/, "tags-"),
      out: { version: 1, generatedBy: "tools/auto_tag.mjs", license: LICENSE, tags },
    });
  }
  return shards;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const kbDir = path.join(ROOT, "kb");
  const { regions, spots } = loadKb(kbDir);
  const tags = buildTags(regions, spots);
  const perAxis = {};
  for (const t of Object.values(tags)) {
    for (const axis of Object.keys(t)) perAxis[axis] = (perAxis[axis] ?? 0) + 1;
  }
  console.log(`スポット ${spots.length} 件 / タグ付与 ${Object.keys(tags).length} 件`);
  console.log("軸別カバレッジ:", JSON.stringify(perAxis));
  if (process.argv.includes("--write")) {
    // スポットと同じシャード単位で出す（1ファイルに集約すると配布・差分が重いため）
    for (const s of buildTagShards(kbDir, regions)) {
      writeFileSync(path.join(kbDir, s.file), JSON.stringify(s.out));
    }
    console.log("kb/tags-*.json を書き出しました");
  }
}
