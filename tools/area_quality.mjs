// エリアページの内容品質レポート（設計ドキュメント §1.2、Issue #428）。
//
// エリアごとに「説明文が無い・短いスポットの割合」と「名前とカテゴリの不整合
// 候補」を集計し、悪い順に出す。データの書き換えはしない（是正は手動補完の
// Issue #427 側で行う）。ここでの役割は、直すべき場所を機械的に特定すること。
//
// 使い方:
//   node tools/area_quality.mjs              全エリアの要約レポート
//   node tools/area_quality.mjs --top 20     ワースト20エリアの詳細
//   node tools/area_quality.mjs --out report.json
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKb } from "./auto_tag.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 名前に現れたらカテゴリ側にも対応する語があってほしい対応表。 */
export const MISMATCH_RULES = [
  { nameRe: /温泉/, catRe: /温泉/, label: "温泉" },
  { nameRe: /[^旧]寺$|寺院|大師|霊場/, catRe: /寺/, label: "寺院" },
  { nameRe: /神社|大社|八幡宮|天満宮|稲荷/, catRe: /神社|寺/, label: "神社" },
  { nameRe: /城$|城跡|城址/, catRe: /城|史跡|歴史|公園/, label: "城" },
  { nameRe: /美術館/, catRe: /美術館/, label: "美術館" },
  { nameRe: /博物館|資料館/, catRe: /博物館|資料館|美術館|記念館/, label: "博物館" },
  { nameRe: /水族館/, catRe: /水族館/, label: "水族館" },
  { nameRe: /動物園/, catRe: /動物園/, label: "動物園" },
  { nameRe: /展望台|タワー/, catRe: /展望|タワー|夜景|公園/, label: "展望" },
  { nameRe: /市場$/, catRe: /市場|商店街|グルメ|飲食/, label: "市場" },
];

export const SHORT_DESC = 30;

/** 名前×カテゴリの不整合候補を返す。 */
export function mismatchOf(spot) {
  const name = spot.name ?? "", cat = spot.category ?? "";
  for (const rule of MISMATCH_RULES) {
    if (rule.nameRe.test(name) && !rule.catRe.test(cat)) {
      return { label: rule.label, category: cat };
    }
  }
  return null;
}

/** エリア単位の品質指標を集計し、悪い順に並べて返す（純関数）。 */
export function analyzeAreaQuality(regions, spots) {
  const byRegion = new Map(regions.map((r) => [r.id, {
    id: r.id, name: r.name, prefecture: r.prefecture,
    spots: 0, descMissing: 0, descShort: 0, mismatches: [],
  }]));
  for (const s of spots) {
    const a = byRegion.get(s.regionId);
    if (!a) continue;
    a.spots++;
    const desc = s.description ?? "";
    if (!desc) a.descMissing++;
    else if (desc.length < SHORT_DESC) a.descShort++;
    const mm = mismatchOf(s);
    if (mm) a.mismatches.push({ id: s.id, name: s.name, ...mm });
  }
  const rows = [...byRegion.values()].map((a) => {
    const mismatchCount = a.mismatches.length;
    return {
      ...a,
      mismatchCount,
      // 品質スコア: 説明不足率と不整合率の重み付き合計（大きいほど要対応）
      score: a.spots === 0 ? 0 :
        Math.round((100 * (a.descMissing * 2 + a.descShort + mismatchCount * 2) / a.spots) * 10) / 10,
    };
  });
  rows.sort((x, y) => y.score - x.score);
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const kbDir = path.join(ROOT, "kb");
  const { regions, spots } = loadKb(kbDir);
  const rows = analyzeAreaQuality(regions, spots);
  const totals = rows.reduce((acc, r) => ({
    descMissing: acc.descMissing + r.descMissing,
    descShort: acc.descShort + r.descShort,
    mismatch: acc.mismatch + r.mismatchCount,
  }), { descMissing: 0, descShort: 0, mismatch: 0 });
  console.log(`スポット ${spots.length} 件 / 説明なし ${totals.descMissing} 件 / ` +
    `説明が短い ${totals.descShort} 件 / 分類の不整合候補 ${totals.mismatch} 件`);
  const topIdx = process.argv.indexOf("--top");
  const top = topIdx >= 0 ? Number(process.argv[topIdx + 1]) : 10;
  for (const r of rows.slice(0, top)) {
    console.log(`score ${r.score}\t${r.name}（${r.prefecture}）スポット${r.spots}件 ` +
      `説明なし${r.descMissing} 短い${r.descShort} 不整合${r.mismatchCount}`);
    for (const m of r.mismatches.slice(0, 3)) {
      console.log(`    例: ${m.name}（現カテゴリ: ${m.category}、観点: ${m.label}）`);
    }
  }
  const outIdx = process.argv.indexOf("--out");
  if (outIdx >= 0) {
    writeFileSync(process.argv[outIdx + 1], JSON.stringify(rows, null, 1));
    console.log(`${process.argv[outIdx + 1]} に書き出しました`);
  }
}
