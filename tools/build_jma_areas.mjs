// 気象庁の予報区（府県予報区と一次細分区域）の名前を、
// packages/core/src/jma-areas.js に書き出します。
//
//     node tools/build_jma_areas.mjs [area.json の場所]
//
// 場所を省くと、気象庁から取ってきます
// （https://www.jma.go.jp/bosai/common/const/area.json）。
// 区域はめったに変わらないので、ブラウザで毎回取りに行かず、ここで
// 固めておきます（注意報・警報の本体だけを、そのつど取ります）。
// 出典: 気象庁ホームページ（公共データ利用規約 第1.0版）
import { readFile, writeFile } from "node:fs/promises";

const SRC = "https://www.jma.go.jp/bosai/common/const/area.json";
const OUT = new URL("../packages/core/src/jma-areas.js", import.meta.url);

const given = process.argv[2];
const area = given
  ? JSON.parse(await readFile(given, "utf8"))
  : await (await fetch(SRC)).json();

const offices = Object.fromEntries(Object.entries(area.offices)
  .map(([code, o]) => [code, o.name]));
const class10 = Object.fromEntries(Object.entries(area.class10s)
  .map(([code, c]) => [code, [c.name, c.parent]]));

const body = `// 自動で作ったファイルです。手で直さず、tools/build_jma_areas.mjs を走らせてください。
// 気象庁の予報区の名前（出典: 気象庁ホームページ ${SRC}）。

/** 府県予報区（注意報・警報を出す単位）: コード → 名前 */
export const JMA_OFFICES = ${JSON.stringify(offices, null, 0)};

/** 一次細分区域: コード → [名前, 府県予報区のコード] */
export const JMA_CLASS10 = ${JSON.stringify(class10, null, 0)};
`;
await writeFile(OUT, body.replace(/\],"/g, '],\n  "').replace(/","(?=\d{6}":")/g, '",\n  "'));
console.log(`府県予報区 ${Object.keys(offices).length}・一次細分区域 ${Object.keys(class10).length} を書きました`);
