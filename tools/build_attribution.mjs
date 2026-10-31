// データのライセンス分離とアトリビューション自動出力（設計ドキュメント
// §3.2・§10、Issue #426）。
//
// kb は自前収集データと Wikipedia 由来テキスト（説明文・wikipedia フィールド）が
// 混在している。派生物（tags.json / summaries.json）を含め、どの成果物のどの
// 部分にどのライセンスが掛かるかを kb/attribution.json に機械可読な形で出力し、
// 表示側・配布側がそのまま出典表示に使えるようにする。
//
// 使い方: node tools/build_attribution.mjs [--write]
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCES = [
  {
    id: "kb-spots",
    name: "旅さきプロジェクト収集データ（位置・カテゴリ・営業時間等の構造的事実）",
    license: "Project data",
    attribution: "旅さき (tabisaki)",
    appliesTo: ["kb/spots-*.json の構造フィールド", "kb/regions.json", "kb/index.json"],
  },
  {
    id: "wikipedia",
    name: "Wikipedia（説明文・wikipedia フィールドの参照先テキスト）",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/deed.ja",
    attribution: "Wikipedia contributors",
    appliesTo: ["スポットの description の素材", "kb/summaries.json の summary 文"],
  },
  {
    id: "osm",
    name: "OpenStreetMap（将来の OSM PBF 補完フィールド用に予約）",
    license: "ODbL 1.0",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "© OpenStreetMap contributors",
    appliesTo: ["（現行 kb には未収録。混入した場合はこの出典表示が必須）"],
  },
];

export const ARTIFACTS = [
  { file: "kb/spots-*.json", derivedFrom: ["kb-spots", "wikipedia"], note: "構造フィールドはプロジェクトデータ、description は Wikipedia 由来の素材を含む" },
  { file: "kb/tags-*.json", derivedFrom: ["kb-spots", "wikipedia"], note: "カテゴリ等の構造情報が主根拠だが、説明文由来の判定を含むため両出典を併記する" },
  { file: "kb/summaries.json", derivedFrom: ["kb-spots", "wikipedia"], note: "summary 文は CC BY-SA 4.0、件数等の構造部分はプロジェクトデータ" },
  { file: "kb/regions.json", derivedFrom: ["kb-spots"], note: "プロジェクトデータのみ" },
];

/** attribution.json の内容を構築する（純関数）。 */
export function buildAttribution() {
  return {
    version: 1,
    generatedBy: "tools/build_attribution.mjs",
    sources: SOURCES,
    artifacts: ARTIFACTS,
    displayText: SOURCES.filter((s) => s.id !== "osm")
      .map((s) => `${s.name}: ${s.attribution}（${s.license}）`).join(" / "),
  };
}

/** 全成果物が宣言済みソースだけから派生しているか検証する。 */
export function validateAttribution(data) {
  const ids = new Set(data.sources.map((s) => s.id));
  const problems = [];
  for (const a of data.artifacts) {
    for (const d of a.derivedFrom) {
      if (!ids.has(d)) problems.push(`${a.file}: 未宣言のソース ${d} を参照しています`);
    }
    if (!a.note) problems.push(`${a.file}: ライセンス注記がありません`);
  }
  for (const s of data.sources) {
    if (!s.attribution) problems.push(`ソース ${s.id}: attribution がありません`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const out = buildAttribution();
  const problems = validateAttribution(out);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`ソース ${out.sources.length} 件 / 成果物 ${out.artifacts.length} 件、検証 OK`);
  if (process.argv.includes("--write")) {
    writeFileSync(path.join(ROOT, "kb", "attribution.json"), JSON.stringify(out, null, 1));
    console.log("kb/attribution.json を書き出しました");
  }
}
