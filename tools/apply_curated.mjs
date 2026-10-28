// 人が確かめて足した補い（kb/curated.json）を、kb/ のシャードに当てます。
//
//     node tools/apply_curated.mjs           # 当たらない id が無いかを見るだけ
//     node tools/apply_curated.mjs --write   # シャードに書き戻す
//
// 当てる項目（どれも省略できます）:
//   tags       … 名前や分類からは分からないタグ（世界遺産・紅葉の名所など。一覧は packages/core/src/tags.js）
//   season     … 例年の見頃 [{key, label, from: "MM-DD", to: "MM-DD"}]
//   best_time  … 行くと良い時間帯 ["morning" | "evening" | "sunset" | "night"]
//   status     … "open" | "closed"（閉館）| "temporarily_closed"（休館中）| "seasonal"（季節営業）
//   note       … status の訳（画面や点検で出す一言）
//   fame_tier / category … 取り込みで付いた値が明らかに違うときの上書き
//
// 休館中のスポットは、読み込むときに行き先から外れます（packages/core/src/notaspot.js）。
// 閉館したものは収録から外し、kb/curated.json の closed に記録だけ残します
// （同じものを取り込み直したときに気づけるように。tools/kb_check.mjs が見ます）。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KB = path.join(import.meta.dirname, "..", "kb");
const write = process.argv.includes("--write");
const read = (f) => JSON.parse(readFileSync(path.join(KB, f), "utf8"));

export const CURATED_FIELDS = ["tags", "season", "best_time", "status", "note", "fame_tier", "category"];

const curated = read("curated.json").spots;
const index = read("index.json");
const seen = new Set();
let changed = 0;
for (const shard of index.shards) {
  const doc = read(shard.file);
  let dirty = false;
  for (const s of doc.spots) {
    const c = curated[s.id];
    if (!c) continue;
    seen.add(s.id);
    for (const k of CURATED_FIELDS) {
      if (!(k in c)) continue;
      if (JSON.stringify(s[k]) === JSON.stringify(c[k])) continue;
      s[k] = c[k];
      dirty = true;
      changed++;
    }
  }
  if (dirty && write) writeFileSync(path.join(KB, shard.file), JSON.stringify(doc));
}
const missing = Object.keys(curated).filter((id) => !seen.has(id));
for (const id of missing) console.log(`kb/ に無い id: ${id}`);
console.log(`変える項目 ${changed}件${write ? "（書き戻しました）" : "（--write で書き戻します）"}`);
process.exitCode = missing.length ? 1 : 0;
