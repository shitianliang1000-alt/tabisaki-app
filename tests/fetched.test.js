// スポットの「いつの情報か」（fetchedAt）。
//
// 収録には確認日が書かれていませんでした。js/confidence.js は鮮度を
// 出す仕組みを持っているのに、材料が無いので「確認日は不明です」しか
// 出せませんでした。出どころごとの取り込み日を、1件ずつに渡します。

import assert from "node:assert/strict";
import test from "node:test";

import { FETCHED_ON, fetchedAtOf } from "../packages/core/src/kb.js";
import { freshnessOf } from "../js/confidence.js";

test("出どころが分かるものには、取り込んだ日が付く", () => {
  const at = fetchedAtOf({ src: "wikidata" });
  assert.ok(Number.isFinite(at));
  const d = new Date(at);
  // 日本の日付で読む（UTC で読むと前の日になる）
  assert.equal(d.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }),
               "2026/9/10");
});

test("シャードに書かれた出どころ（国土数値情報 文化施設）も読む", () => {
  assert.ok(Number.isFinite(fetchedAtOf({ dataSource: "国土数値情報 文化施設(P27-13)" })));
});

test("分からないものに、それらしい日付を作らない", () => {
  assert.equal(fetchedAtOf({}), undefined);
  assert.equal(fetchedAtOf({ src: "unknown-source" }), undefined);
  assert.equal(freshnessOf(fetchedAtOf({})).level, "unknown");
});

test("データの側に日付があれば、そちらが勝つ", () => {
  const mine = Date.parse("2026-10-01T00:00:00+09:00");
  assert.equal(fetchedAtOf({ src: "wikidata", fetchedAt: mine }), mine);
});

test("取り込み日は、どれも本当の日付で、未来ではない", () => {
  for (const [src, day] of Object.entries(FETCHED_ON)) {
    const ms = Date.parse(`${day}T00:00:00+09:00`);
    assert.ok(Number.isFinite(ms), src);
    assert.ok(ms <= Date.parse("2026-10-10T23:59:59+09:00"), `${src} が未来です`);
  }
});

test("収録で使われている出どころは、ぜんぶ日付を持つ", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("../kb/", import.meta.url);
  const seen = new Set();
  for (const f of await readdir(dir)) {
    if (!/^spots-.*\.json$/.test(f)) continue;
    const doc = JSON.parse(await readFile(new URL(f, dir), "utf8"));
    for (const s of doc.spots ?? []) if (s.src) seen.add(s.src);
  }
  const missing = [...seen].filter((s) => !FETCHED_ON[s]);
  assert.deepEqual(missing, [],
    `取り込み日の無い出どころ（packages/core/src/kb.js の FETCHED_ON に足してください）: ${missing.join(" ")}`);
});
