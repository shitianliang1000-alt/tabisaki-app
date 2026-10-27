// 収録を二段で読む。
//
// 収録は約4MBあります。全部読み終わるまでボタンを押せなくしていたので、
// 低速な回線では、開いてから最初の操作までがそのぶん遅れていました。
//
//   1回目  index.json + regions.json（約380KB）… 条件の入力に要るのはここまで
//   2回目  spots-*.json（約3.7MB）             … 旅程を組むときに要る
//
// 2回目は1回目の結果を使い回します。取り直すと、380KBを2度読むことに
// なって、速くするつもりが遅くなります。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { loadKnowledgeBase, loadRegionIndex } from "../packages/core/src/kb.js";

const root = new URL("../", import.meta.url);

/** kb/ をファイルから返します。何を何回取りにいったかを数えます。 */
function countingFetch() {
  const real = globalThis.fetch;
  const got = [];
  globalThis.fetch = async (url) => {
    const path = String(url).startsWith("file://")
      ? new URL(url).pathname
      : new URL(String(url), root).pathname;
    got.push(path.split("/kb/")[1] ?? path);
    const text = await readFile(path, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  };
  return { got, restore: () => { globalThis.fetch = real; } };
}

test("エリアだけを先に読める（スポットは取りに行かない）", async () => {
  const { got, restore } = countingFetch();
  try {
    const pre = await loadRegionIndex();
    assert.ok(pre?.regions?.length > 100, "エリアが読めていません");
    assert.deepEqual(got, ["index.json", "regions.json"]);
    assert.ok(!got.some((f) => f.startsWith("spots-")),
      "この段階でスポットまで取りに行っています");
  } finally {
    restore();
  }
});

test("2回目は、エリアを取り直さない", async () => {
  const { got, restore } = countingFetch();
  try {
    const pre = await loadRegionIndex();
    got.length = 0;
    const kb = await loadKnowledgeBase(undefined, undefined, pre);
    assert.ok(!got.includes("regions.json"), "エリアを2度読んでいます");
    assert.ok(!got.includes("index.json"), "索引を2度読んでいます");
    assert.ok(got.every((f) => f.startsWith("spots-")), got.join(", "));
    // 中身は、まとめて読んだときと同じであること。
    assert.equal(kb.regions.length, pre.regions.length);
    assert.ok(kb.spots.length > 10000, `スポットが ${kb.spots.length} 件です`);
    assert.ok(kb.spotsById.size === kb.spots.length);
  } finally {
    restore();
  }
});
