// 行き先ではないもの（宿・町や会社の記事・湖まるごとの「浜」）を
// 収録から外す道具。
//
// 判定は packages/core/src/notaspot.js にあります。**ここに規則を書きません。**
// 読み込み（packages/core/src/kb.js）も同じ判定で外すので、ここで外し忘れても
// 旅程には出ません。ここで外すのは、エリアのページ（areas/）と
// 件数の表示と、配る量のためです。
//
//     node tools/drop_not_spots.mjs           確認するだけ
//     node tools/drop_not_spots.mjs --write   外して書き戻す

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { whyNotASpot } from "../packages/core/src/notaspot.js";

const KB = new URL("../kb/", import.meta.url).pathname;
const write = process.argv.includes("--write");
const dump = (obj) => JSON.stringify(obj);

const files = readdirSync(KB).filter((f) => /^spots-.*\.json$/.test(f)).sort();
const shards = new Map(files.map((f) => [f, JSON.parse(readFileSync(join(KB, f), "utf8"))]));

const drops = [];
for (const [file, doc] of shards) {
  for (const s of doc.spots) {
    const why = whyNotASpot(s);
    // 休館中は再開に備えて残します（読み込むときに外れます）
    if (why && why !== "休館中") drops.push({ file, why, s });
  }
}

const total = [...shards.values()].reduce((n, d) => n + d.spots.length, 0);
console.log(`収録 ${total}件 のうち、行き先ではないもの ${drops.length}件`);
const byWhy = new Map();
for (const d of drops) byWhy.set(d.why, [...(byWhy.get(d.why) ?? []), d.s.name]);
for (const [why, names] of byWhy) {
  console.log(`  ${why} ${names.length}件  例: ${names.slice(0, 6).join("、")}`);
}

if (!write) {
  console.log("\n--write を付けると書き戻します。");
  process.exit(0);
}

const gone = new Set(drops.map((d) => d.s.id));
for (const [file, doc] of shards) {
  doc.spots = doc.spots.filter((s) => !gone.has(s.id));
  writeFileSync(join(KB, file), dump(doc));
}

// 件数は kb/index.json と kb/regions.json にも書いてあります。
const all = [...shards.values()].flatMap((d) => d.spots);
const perRegion = new Map();
for (const s of all) perRegion.set(s.regionId, (perRegion.get(s.regionId) ?? 0) + 1);

const regionsPath = join(KB, "regions.json");
const regions = JSON.parse(readFileSync(regionsPath, "utf8"));
for (const r of regions.regions) {
  if ("spotCount" in r) r.spotCount = perRegion.get(r.id) ?? 0;
}
writeFileSync(regionsPath, dump(regions));

const indexPath = join(KB, "index.json");
const index = JSON.parse(readFileSync(indexPath, "utf8"));
for (const sh of index.shards ?? []) {
  const doc = shards.get(sh.file);
  if (!doc) continue;
  sh.count = doc.spots.length;
  sh.regions = [...new Set(doc.spots.map((s) => s.regionId).filter(Boolean))].sort();
}
if (index.counts) index.counts.spots = all.length;
writeFileSync(indexPath, dump(index));

// 名前の索引（tools/reshard_kb.py と同じ作り）。外した名前が残ると、
// 「収録にある地名」として扱われ、調べにいかなくなります。
const seen = new Set();
const names = [];
for (const s of all) {
  if (s.name && !seen.has(s.name)) { seen.add(s.name); names.push(s.name); }
}
writeFileSync(join(KB, "names.json"), dump({ names: names.join("\n") }));

console.log(`\n収録 ${all.length}件になりました。`);
