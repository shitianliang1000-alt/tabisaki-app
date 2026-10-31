// 階層的知識構造（層1〜層3）の要約生成（設計ドキュメント §3.1、Issue #425）。
//
//   層3: 地方ブロック要約（8ブロック）   … モデルに確実に記憶させる想定
//   層2: 都道府県要約（47都道府県）     … モデルに記憶させる想定
//   層1: エリア要約（regions.json のエリア）… モデルに部分的に記憶させる想定
//
// 要約は kb の実データ（エリアの tagline/説明文、スポットの fame 上位・カテゴリ
// 集計）から決定的に生成する。生成日時を含めないので、入力が同じなら出力も同じ。
//
// 使い方: node tools/build_summaries.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKb } from "./auto_tag.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 都道府県→地方ブロック（§3.1 の8ブロック）。 */
export const BLOCKS = {
  "北海道": "北海道", "青森県": "東北", "岩手県": "東北", "宮城県": "東北", "秋田県": "東北",
  "山形県": "東北", "福島県": "東北", "茨城県": "関東", "栃木県": "関東", "群馬県": "関東",
  "埼玉県": "関東", "千葉県": "関東", "東京都": "関東", "神奈川県": "関東",
  "新潟県": "中部", "富山県": "中部", "石川県": "中部", "福井県": "中部", "山梨県": "中部",
  "長野県": "中部", "岐阜県": "中部", "静岡県": "中部", "愛知県": "中部", "三重県": "中部",
  "滋賀県": "近畿", "京都府": "近畿", "大阪府": "近畿", "兵庫県": "近畿", "奈良県": "近畿",
  "和歌山県": "近畿", "鳥取県": "中国", "島根県": "中国", "岡山県": "中国", "広島県": "中国",
  "山口県": "中国", "徳島県": "四国", "香川県": "四国", "愛媛県": "四国", "高知県": "四国",
  "福岡県": "九州・沖縄", "佐賀県": "九州・沖縄", "長崎県": "九州・沖縄", "熊本県": "九州・沖縄",
  "大分県": "九州・沖縄", "宮崎県": "九州・沖縄", "鹿児島県": "九州・沖縄", "沖縄県": "九州・沖縄",
};
export const BLOCK_ORDER = ["北海道", "東北", "関東", "中部", "近畿", "中国", "四国", "九州・沖縄"];

const topNames = (items, n) => items.slice(0, n).map((x) => x.name);
const byFame = (a, b) => (b.fame_score ?? 0) - (a.fame_score ?? 0);

function categorySummary(spots, n = 4) {
  const counts = new Map();
  for (const s of spots) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c);
}

/** 層1〜層3の要約を構築する（純関数）。 */
export function buildSummaries(regions, spots) {
  const byRegion = new Map();
  const byPref = new Map();
  for (const s of spots) {
    if (!byRegion.has(s.regionId)) byRegion.set(s.regionId, []);
    byRegion.get(s.regionId).push(s);
    if (!byPref.has(s.prefecture)) byPref.set(s.prefecture, []);
    byPref.get(s.prefecture).push(s);
  }

  // 層1: エリア要約
  const areas = regions.map((r) => {
    const rs = byRegion.get(r.id) ?? [];
    const famous = topNames([...rs].sort(byFame), 3);
    const cats = categorySummary(rs, 3);
    const summary = `${r.name}: ${r.tagline ?? ""}。代表スポットは${famous.join("、") || "—"}` +
      `（スポット${rs.length}件、主なカテゴリは${cats.join("・") || "—"}）。`;
    return { id: r.id, name: r.name, prefecture: r.prefecture, spotCount: rs.length, summary };
  });

  // 層2: 都道府県要約（prefecture が無い・未知のスポットは層2に数えない）
  const prefectures = [];
  for (const pref of [...byPref.keys()].filter((p) => p in BLOCKS).sort()) {
    const ps = byPref.get(pref);
    const areaNames = regions.filter((r) => r.prefecture === pref)
      .sort((a, b) => (b.spotCount ?? 0) - (a.spotCount ?? 0)).slice(0, 5).map((r) => r.name);
    const famous = topNames([...ps].sort(byFame), 5);
    const summary = `${pref}: ${areaNames.join("、")}などのエリアがある。代表スポットは${famous.join("、")}` +
      `（スポット${ps.length}件）。`;
    prefectures.push({ name: pref, block: BLOCKS[pref] ?? null, spotCount: ps.length, summary });
  }

  // 層3: 地方ブロック要約
  const blocks = BLOCK_ORDER.map((block) => {
    const prefs = prefectures.filter((p) => p.block === block);
    const total = prefs.reduce((a, p) => a + p.spotCount, 0);
    const famousAreas = regions.filter((r) => BLOCKS[r.prefecture] === block)
      .sort((a, b) => (b.spotCount ?? 0) - (a.spotCount ?? 0)).slice(0, 6).map((r) => r.name);
    return {
      name: block,
      prefectures: prefs.map((p) => p.name),
      spotCount: total,
      summary: `${block}: ${prefs.map((p) => p.name).join("、")}。主なエリアは${famousAreas.join("、")}（スポット${total}件）。`,
    };
  });

  return {
    version: 1,
    generatedBy: "tools/build_summaries.mjs",
    license: {
      derivedFrom: ["kb-spots", "wikipedia"],
      fieldLicenses: {
        summary: "エリア tagline・説明文を素材に含むため CC BY-SA 4.0（出典: Wikipedia・旅さきプロジェクト）",
        structure: "件数・分類などの構造的事実はプロジェクトデータ（kb/attribution.json 参照）",
      },
    },
    layers: { block: blocks, prefecture: prefectures, area: areas },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const kbDir = path.join(ROOT, "kb");
  const { regions, spots } = loadKb(kbDir);
  const out = buildSummaries(regions, spots);
  console.log(`層3 ${out.layers.block.length} / 層2 ${out.layers.prefecture.length} / 層1 ${out.layers.area.length}`);
  if (process.argv.includes("--write")) {
    writeFileSync(path.join(kbDir, "summaries.json"), JSON.stringify(out));
    console.log("kb/summaries.json を書き出しました");
  }
}
