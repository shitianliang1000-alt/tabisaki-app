// 似たスポット検索の当たりぐあいを測る（Issue #353）。
//
//     node tools/similar_eval.mjs            # 全国の索引で、tests/fixtures/similar-eval.json を測る
//     node tools/similar_eval.mjs --region=関東
//
// 出すのは precision@5（上位5件のうち、期待した分類に入るものの割合）の平均と、1件ずつの上位5件です。
// 索引の作りかた（packages/core/kbtools.mjs の重み）を変えたら、走らせて下がっていないか見てください。

import { readFileSync } from "node:fs";
import { buildIndex, evaluate, extractRegion } from "../packages/core/kbtools.mjs";

const region = process.argv.find((a) => a.startsWith("--region="))?.slice(9) ?? "全国";
const { cases } = JSON.parse(readFileSync(new URL("../tests/fixtures/similar-eval.json", import.meta.url), "utf8"));
const index = buildIndex(await extractRegion(region));
const r = evaluate(index, cases, 5);
for (const row of r.rows) {
  console.log(`${row.precision.toFixed(1)}  ${row.query}${row.found ? "" : "（文として）"}  → ${row.top.join(" / ")}`);
}
console.log(`\nprecision@${r.k} の平均: ${r.mean}（${region}・${index.spots.length}件・kb ${index.kbHash}）`);
