// 収録を、要るぶんだけ読む。
//
// 収録は 29,706件・4.8MB（gzip で約1MB）あります。これを起動時に全部
// 読んでいました。ところが「島根の旅程」に使うのは島根のぶんだけで、
// 残り46県は読んで、照合して、捨てていました。
//
// 段は**出典ごと**に切られていたので（国土数値情報、Wikidata）、
// 県で選ぶことができませんでした。県ごとに切り直し（tools/reshard_kb.py）、
// 段ごとに「どのエリアが入っているか」を索引に書いてあります。
//
// ここで確かめたいのは、**足りないまま使われても壊れないこと**と、
// **要るものを黙って落とさないこと**です。行けたはずの旅先が消えるのが
// いちばん悪い結果なので、絞る材料が無いときは全部読みます。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  ensureAllSpots, ensureNames, ensureRegions, hasAllShards, shardsForRegions,
  stagedKb,
} from "../packages/core/src/kb.js";
import { unknownPlaceTerms } from "../packages/core/src/areas.js";

const root = new URL("../", import.meta.url);

/** kb/ をファイルから返します。何を取りにいったかを数えます。 */
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

async function staged() {
  const index = JSON.parse(
    await readFile(new URL("kb/index.json", root), "utf8"));
  const regions = JSON.parse(
    await readFile(new URL("kb/regions.json", root), "utf8")).regions;
  return stagedKb({
    base: new URL("kb/index.json", root).toString(),
    manifest: index,
    regions,
  });
}

test("段ごとに、どのエリアが入っているかが索引に書かれている", async () => {
  const kb = await staged();
  assert.ok(kb, "段を遅れて読める索引になっていません");
  assert.equal(kb.spots.length, 0, "この段階でスポットを持っています");
  for (const shard of kb.manifest.shards) {
    assert.ok(shard.regions?.length > 0, `${shard.file} にエリアがありません`);
    assert.ok(shard.prefecture !== undefined, `${shard.file} に県名がありません`);
  }
  // どのエリアも、どこかの段に入っていること（迷子のエリアが無いこと）
  const inShards = new Set(kb.manifest.shards.flatMap((s) => s.regions));
  const withSpots = kb.regions.filter((r) => inShards.has(r.id));
  assert.ok(withSpots.length > 1000,
    `段に入っているエリアが ${withSpots.length} しかありません`);
});

test("エリアを指定すると、その県の段だけを取りにいく", async () => {
  const kb = await staged();
  // 出雲（島根県）のエリアを1つ選びます
  const izumo = kb.regions.find((r) => r.prefecture === "島根県");
  assert.ok(izumo, "島根県のエリアがありません");

  const files = shardsForRegions(kb, [izumo.id]);
  assert.equal(files.length, 1, `${files.length}枚を取ろうとしています`);
  assert.match(files[0], /shimane/);

  const { got, restore } = countingFetch();
  try {
    const added = await ensureRegions(kb, [izumo.id]);
    assert.equal(got.length, 1, `${got.join(", ")} を読んでいます`);
    assert.ok(added > 100, `${added}件しか読めていません`);
    assert.ok(kb.spotsByRegion.get(izumo.id)?.length > 0,
      "指定したエリアのスポットが入っていません");
    // ほかの県は読んでいないこと
    assert.equal(kb.spots.some((s) => s.prefecture === "東京都"), false);
    assert.equal(hasAllShards(kb), false);
  } finally {
    restore();
  }
});

test("同じ段は二度読まない", async () => {
  const kb = await staged();
  const izumo = kb.regions.find((r) => r.prefecture === "島根県");
  const { got, restore } = countingFetch();
  try {
    await ensureRegions(kb, [izumo.id]);
    got.length = 0;
    const added = await ensureRegions(kb, [izumo.id]);
    assert.equal(added, 0);
    assert.deepEqual(got, []);
  } finally {
    restore();
  }
});

test("読んだスポットは、まとめて読んだときと同じ形になっている", async () => {
  const kb = await staged();
  const izumo = kb.regions.find((r) => r.prefecture === "島根県");
  const { restore } = countingFetch();
  try {
    await ensureRegions(kb, [izumo.id]);
    const spot = kb.spots[0];
    // hydrate が通っていること（エリア名・県名・分類の既定値）
    assert.ok(spot.region, "エリア名が入っていません");
    assert.ok(spot.prefecture, "県名が入っていません");
    assert.ok(Array.isArray(spot.genres), "genres が入っていません");
    assert.ok(kb.spotsById.get(spot.id) === spot, "索引が張られていません");
  } finally {
    restore();
  }
});

test("全部読めば、段の合計から「同じ場所」を引いた件数になる", async () => {
  // 索引の件数（29,706）は**収録の件数**です。読み込むときに、
  // 座標も名前も同じものを1つにまとめるので（packages/core/src/dedupe.js）、
  // 実際に行ける場所の数はそのぶん少なくなります。
  //
  //   高徳院（鎌倉大仏） と 鎌倉大仏 高徳院  → 1つ
  //   高千穂神社 と 観光神楽 高千穂神社       → 1つ
  //
  // まとめた数を数えているので、足すと索引の件数に戻ります。
  const kb = await staged();
  const { got, restore } = countingFetch();
  try {
    await ensureAllSpots(kb);
    assert.ok(kb.merged > 0, "1組もまとめていません");
    assert.equal(kb.spots.length + kb.merged, kb.manifest.counts.spots);
    assert.equal(kb.spotsById.size, kb.spots.length);
    assert.equal(hasAllShards(kb), true);
    assert.equal(got.length, kb.manifest.shards.length);
  } finally {
    restore();
  }
});

test("同じ場所が、2件のまま残らない", async () => {
  // 使う人から挙がった例をそのまま固定します。
  const kb = await staged();
  const { restore } = countingFetch();
  try {
    await ensureAllSpots(kb);
    // 鎌倉のものだけを見ます。「桶狭間古戦場伝説地・高徳院」（愛知県）は
    // 名前に高徳院を含みますが、別の場所です。
    const named = (n) => kb.spots.filter((s) => s.name.includes(n)
      && Math.abs(s.lat - 35.3167) < 0.05 && Math.abs(s.lng - 139.5358) < 0.05);
    // 高徳院と鎌倉大仏は、同じ座標の同じお寺です。
    assert.equal(named("高徳院").length, 1,
      named("高徳院").map((s) => s.name).join(" / "));
    // まとめた側の名前は、別名として残ります（「鎌倉大仏」で探した人が
    // たどり着けなくなると、直したつもりで壊れます）。
    assert.ok(named("高徳院")[0].aka?.some((a) => a.includes("鎌倉大仏")),
      "別名が残っていません");
    // 「観光神楽 高千穂神社」は、催しの名前が神社の前に付いたものです。
    // 残すのは神社のほうです（催しは毎日あるとは限りません）。
    const takachiho = kb.spots.filter((s) => s.name.includes("高千穂神社"));
    assert.equal(takachiho.length, 1);
    assert.equal(takachiho[0].name, "高千穂神社");
  } finally {
    restore();
  }
});

test("同じ建物の別の施設は、まとめない", async () => {
  // 小樽美術館と小樽文学館は同じ建物にありますが、別の施設です。
  // 座標だけで潰すと、行けたはずの場所が消えます。
  const kb = await staged();
  const { restore } = countingFetch();
  try {
    await ensureAllSpots(kb);
    assert.ok(kb.spots.some((s) => s.name.includes("小樽美術館")));
    assert.ok(kb.spots.some((s) => s.name.includes("小樽文学館")));
  } finally {
    restore();
  }
});

test("名前の索引だけで、収録にある土地かどうかを言える", async () => {
  // 読んでいない県の場所を「収録に無い」と言うと、要らない調べものが
  // 走ります。名前だけを別に持っておけば、段の読み込みと関係なく
  // 正しく答えられます。
  const kb = await staged();
  const { got, restore } = countingFetch();
  try {
    await ensureNames(kb);
    assert.deepEqual(got, ["names.json"]);
    assert.ok(kb.names.length > 100000, `索引が ${kb.names.length} 字です`);
    // スポットを1件も読んでいないのに、判定できること
    assert.equal(kb.spots.length, 0);
    assert.deepEqual(unknownPlaceTerms("出雲大社に行きたい", kb), []);
    assert.deepEqual(unknownPlaceTerms("架空遺跡に行きたい", kb), ["架空遺跡"]);
  } finally {
    restore();
  }
});

test("照らす相手がいないときは、何も言わない", async () => {
  // スポットも索引も無い段階で「全部知らない場所」と言い出したら、
  // 断り文句だけが並びます。黙っているほうが正しいです。
  const kb = await staged();
  assert.deepEqual(unknownPlaceTerms("出雲大社に行きたい", kb), []);
});

test("古い索引（エリアの書かれていない段）では、分けない", () => {
  // 段に「どのエリアが入っているか」が無ければ、選ぶことはできません。
  // 選べないのに選んだふりをすると、あるはずの場所が落ちます。
  const kb = stagedKb({
    base: "https://example.test/kb/index.json",
    manifest: { shards: [{ file: "spots-00.json", count: 10 }] },
    regions: [{ id: "r1", name: "どこか" }],
  });
  assert.deepEqual(shardsForRegions(kb, ["r1"]), ["spots-00.json"]);
  assert.deepEqual(shardsForRegions(kb, ["nope"]), ["spots-00.json"]);
});
