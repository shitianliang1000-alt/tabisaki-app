// 収録の名前から、出どころの書きかたの残り（曖昧さ回避のかっこ、
// 前に付いた市町村の名前、分類を書き足したかっこ）を落とす道具。
//
// 規則は tools/spotname.mjs にあります。**ここに規則を書きません。**
// tests/spotname.test.js が、kb/ に直し残しがあると落ちます。
// 取り込み直したら、tools/drop_not_spots.mjs と一緒にこれも通してください。
//
//     node tools/clean_names.mjs           確認するだけ
//     node tools/clean_names.mjs --write   直して書き戻す

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanAll, cleanSpot, sameNamedTwins } from "./spotname.mjs";

const KB = new URL("../kb/", import.meta.url).pathname;
const write = process.argv.includes("--write");
const dump = (obj) => JSON.stringify(obj);

const files = readdirSync(KB).filter((f) => /^spots-.*\.json$/.test(f)).sort();
const shards = new Map(files.map((f) => [f, JSON.parse(readFileSync(join(KB, f), "utf8"))]));

// 先に、かっこの書きかたが違うだけの同じ場所の2件を1件にします。
const twins = sameNamedTwins([...shards.values()].flatMap((d) => d.spots));
console.log(`同じ場所の2件目 ${twins.size}件: ${[...twins].map((s) => s.name).slice(0, 8).join("、")}`);
for (const doc of shards.values()) doc.spots = doc.spots.filter((s) => !twins.has(s));

const all = [...shards.values()].flatMap((d) => d.spots);
const plan = cleanAll(all);
const changed = [];
for (const [s, name] of plan) {
  const was = s.name;
  cleanSpot(s);
  if (s.name !== name) throw new Error(`${was}: ${s.name} と ${name} が食い違います`);
  changed.push(`${was} → ${s.name}`);
}

console.log(`名前を直すもの ${changed.length}件`);
for (const line of changed.slice(0, 40)) console.log(`  ${line}`);
if (changed.length > 40) console.log(`  …ほか ${changed.length - 40}件`);

if (!write) {
  console.log("\n--write を付けると書き戻します。");
  process.exit(0);
}

for (const [file, doc] of shards) writeFileSync(join(KB, file), dump(doc));

// 件数は kb/index.json と kb/regions.json にあります（tools/drop_not_spots.mjs と同じ）。
// エリアのページもアプリも README もここから引くので、外したら必ず書き直します。
if (twins.size) {
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
  console.log(`収録 ${all.length}件になりました（README の件数の表も直してください）。`);
}

// 名前の索引（tools/reshard_kb.py・tools/drop_not_spots.mjs と同じ作り）。
const seen = new Set();
const names = [];
for (const doc of shards.values()) {
  for (const s of doc.spots) {
    if (s.name && !seen.has(s.name)) { seen.add(s.name); names.push(s.name); }
  }
}
writeFileSync(join(KB, "names.json"), dump({ names: names.join("\n") }));
console.log("書き戻しました。");
