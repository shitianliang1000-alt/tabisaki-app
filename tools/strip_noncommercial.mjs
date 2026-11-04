// 国土数値情報の「非商用」のデータを、kb/ の写しから外します。
//
//     node tools/strip_noncommercial.mjs <kb の写しの場所>
//
// 外すもの（docs/data-licenses.md の「国土数値情報の『非商用』のデータ」）:
//   ・観光資源（P12）  src が "kokudo" のスポット
//   ・文化施設（P27）  dataSource に「文化施設」を含むスポット
//   ・バス停（P11）    kb/stops-bus.json と kb/stops-bus/
//
// 非商用のデータは複製物の再配布ができないので、PHP 版（tools/build_php.sh）は
// これを通した kb/ を配ります。**リポジトリの kb/ には使わないでください**
// （書きかえるのは、渡した場所の中だけです）。
//
// スポットを外したあと、index.json の件数・エリア一覧、regions.json の件数、
// names.json（地名の索引）、tags-*・verification-* の該当分もそろえます。
// スポットが1件も残らないエリアは、エリアごと外します。
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const isNoncommercial = (s) =>
  s?.src === "kokudo" || String(s?.dataSource ?? "").includes("文化施設");

/** 非商用の出典として index.json の sources に載っているもの */
const NONCOMMERCIAL_SOURCE = /国土数値情報 (観光資源|文化施設)/;

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const writeJson = (p, v) => writeFile(p, JSON.stringify(v));

export async function stripNoncommercial(dir) {
  const index = await readJson(join(dir, "index.json"));
  const removed = new Set();
  const kept = [];
  const perRegion = new Map();
  for (const shard of index.shards ?? []) {
    const p = join(dir, shard.file);
    const doc = await readJson(p);
    const spots = [];
    for (const s of doc.spots ?? []) {
      if (isNoncommercial(s)) { removed.add(s.id); continue; }
      spots.push(s);
      kept.push(s);
      if (s.regionId) perRegion.set(s.regionId, (perRegion.get(s.regionId) ?? 0) + 1);
    }
    doc.spots = spots;
    await writeJson(p, doc);
    shard.count = spots.length;
    shard.regions = [...new Set(spots.map((s) => s.regionId).filter(Boolean))].sort();
  }

  // エリア
  const regionsPath = join(dir, index.regionsFile ?? "regions.json");
  const regionsDoc = await readJson(regionsPath);
  const list = Array.isArray(regionsDoc) ? regionsDoc : regionsDoc.regions ?? [];
  const regions = list.filter((r) => perRegion.has(r.id));
  for (const r of regions) if ("spotCount" in r) r.spotCount = perRegion.get(r.id);
  await writeJson(regionsPath, Array.isArray(regionsDoc) ? regions : { ...regionsDoc, regions });
  const droppedRegions = list.length - regions.length;

  index.counts = { ...(index.counts ?? {}), regions: regions.length, spots: kept.length };
  if (Array.isArray(index.sources)) {
    index.sources = index.sources.filter((src) => !NONCOMMERCIAL_SOURCE.test(src?.name ?? ""));
  }
  await writeJson(join(dir, "index.json"), index);

  // 地名の索引（tools/reshard_kb.py と同じ作りかた: 名前を順に、重ねずに）
  if (existsSync(join(dir, "names.json"))) {
    const names = [...new Set(kept.map((s) => s.name).filter(Boolean))];
    await writeJson(join(dir, "names.json"), { names: names.join("\n") });
  }

  // スポットごとの付けたし（タグ・確認の記録）
  for (const f of await readdir(dir)) {
    if (!/^(tags|verification)-.*\.json$/.test(f)) continue;
    const p = join(dir, f);
    const doc = await readJson(p);
    const key = doc.tags ? "tags" : doc.records ? "records" : null;
    if (!key) continue;
    for (const id of Object.keys(doc[key])) if (removed.has(id)) delete doc[key][id];
    await writeJson(p, doc);
  }

  // バス停は、タイルの無い索引だけを残します（アプリは「バス停なし」として動きます）。
  await rm(join(dir, "stops-bus"), { recursive: true, force: true });
  if (existsSync(join(dir, "stops-bus.json"))) {
    await writeJson(join(dir, "stops-bus.json"), { tiles: [] });
  }

  return { spots: removed.size, regions: droppedRegions, kept: kept.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("使いかた: node tools/strip_noncommercial.mjs <kb の写しの場所>");
    process.exit(2);
  }
  const r = await stripNoncommercial(dir);
  console.log(`非商用のデータを外しました: スポット ${r.spots}件・エリア ${r.regions}件・バス停（残り ${r.kept}件）`);
}
