// 知識ベース（kb/）の分類とエリアの取り違えを、決まったルールで直します。
//
//     node tools/fix_kb_quality.mjs           # 何が変わるかを出すだけ
//     node tools/fix_kb_quality.mjs --write   # kb/ に書き戻す（そのあと clean_names.mjs --write で数え直し）
//
// 直すのは、名前を見れば分類がはっきりするものと、別の県のエリアにぶら下がっているものだけです。
// 迷うもの（「温泉」なのに健康センターらしい、など）は tools/kb_check.mjs が「気になる点」に出します。
// ルールは tools/kb_rules.mjs にあり、試験（tests/kb-quality.test.js）も同じものを使います。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { categoryFix, regionFix } from "./kb_rules.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const KB = path.join(ROOT, "kb");
const write = process.argv.includes("--write");
const read = (f) => JSON.parse(readFileSync(path.join(KB, f), "utf8"));

const index = read("index.json");
const regions = read(index.regionsFile ?? "regions.json").regions;
const byId = new Map(regions.map((r) => [r.id, r]));

const changes = [];
for (const shard of index.shards) {
  const doc = read(shard.file);
  let dirty = false;
  for (const s of doc.spots) {
    const cat = categoryFix(s);
    if (cat) {
      changes.push(`${shard.prefecture}\t分類\t${s.name}\t${s.category} → ${cat.to}\t${cat.why}`);
      s.category = cat.to;
      dirty = true;
    }
    const reg = regionFix(s, shard.prefecture, byId, regions);
    if (reg) {
      changes.push(`${shard.prefecture}\tエリア\t${s.name}\t${byId.get(s.regionId).name}（${byId.get(s.regionId).prefecture}） → ${reg.name}`);
      s.regionId = reg.id;
      if ("region" in s) s.region = reg.name;
      dirty = true;
    }
  }
  if (dirty && write) writeFileSync(path.join(KB, shard.file), JSON.stringify(doc));
}
for (const c of changes) console.log(c);
console.log(`${changes.length}件${write ? "を書き戻しました。つづけて node tools/clean_names.mjs --write で数え直してください" : "（--write で書き戻します）"}`);
