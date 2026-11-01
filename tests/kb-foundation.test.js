// Phase 1 データ基盤ツール群のテスト（Issue #421 / #424 / #425 / #426 / #428）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stampSpots, countMissing, dateToMs } from "../tools/stamp_fetched_at.mjs";
import { tagsForSpot, buildTags, TAXONOMY } from "../tools/auto_tag.mjs";
import { buildSummaries, BLOCKS } from "../tools/build_summaries.mjs";
import { buildAttribution, validateAttribution } from "../tools/build_attribution.mjs";
import { analyzeAreaQuality, mismatchOf } from "../tools/area_quality.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- #421 fetchedAt ----------
test("stampSpots は不足分だけに付与し、既存値は保持する", () => {
  const spots = [{ id: "a" }, { id: "b", fetchedAt: 123 }, { id: "c", fetchedAt: "x" }];
  assert.equal(countMissing(spots), 2);
  const { spots: out, stamped } = stampSpots(spots, 999);
  assert.equal(stamped, 2);
  assert.equal(out[0].fetchedAt, 999);
  assert.equal(out[1].fetchedAt, 123);
  assert.equal(countMissing(out), 0);
});

test("dateToMs は YYYY-MM-DD を UTC 0時へ変換する", () => {
  assert.equal(dateToMs("2026-10-31"), Date.UTC(2026, 9, 31));
  assert.throws(() => dateToMs("2026/10/31"));
});

test("実 kb の全スポットに fetchedAt が付与されている（#421 の完了条件）", () => {
  const index = JSON.parse(readFileSync(path.join(ROOT, "kb", "index.json"), "utf8"));
  let total = 0, missing = 0;
  for (const shard of index.shards) {
    const data = JSON.parse(readFileSync(path.join(ROOT, "kb", shard.file), "utf8"));
    total += data.spots.length;
    missing += countMissing(data.spots);
  }
  assert.ok(total > 50000, `スポット総数が想定外: ${total}`);
  assert.equal(missing, 0, `fetchedAt 未付与が ${missing} 件残っています`);
});

// ---------- #424 自動タグ ----------
test("tagsForSpot はカテゴリと名前から根拠のあるタグを付ける", () => {
  const onsen = tagsForSpot(
    { name: "草津温泉 湯畑", category: "温泉", genres: ["onsen"], open: 0, close: 24, description: "日本三名泉のひとつ" },
    { station: "長野原草津口駅" });
  assert.ok(onsen.activity.includes("onsen"));
  assert.ok(onsen.transport.includes("train_accessible"));
  assert.ok(onsen.audience.includes("couple_friendly"));
  assert.ok(onsen.time.includes("day_and_night"));

  const zoo = tagsForSpot({ name: "上野動物園", category: "動物園", genres: [], description: "" }, null);
  assert.ok(zoo.activity.includes("zoo"));
  assert.ok(zoo.audience.includes("family_friendly"));
});

test("付与されるタグは §3.4 のタクソノミーの範囲内だけ", () => {
  const spots = [
    { id: "1", name: "某寺", category: "寺院", genres: ["history"], regionId: "r", description: "静かな境内" },
    { id: "2", name: "夜景タワー", category: "展望台", genres: [], regionId: "r", open: 10, close: 22, description: "" },
  ];
  const tags = buildTags([{ id: "r", name: "どこか", station: "駅" }], spots);
  for (const t of Object.values(tags)) {
    for (const [axis, vals] of Object.entries(t)) {
      for (const v of vals) assert.ok(TAXONOMY[axis].includes(v), `${axis}:${v} はタクソノミー外`);
    }
  }
});

test("kb/tags-*.json がシャード単位で生成されていて大半のスポットを覆う", () => {
  const files = readdirSync(path.join(ROOT, "kb")).filter((f) => /^tags-jp\d+-.+\.json$/.test(f));
  assert.equal(files.length, 47, "タグのシャードは47ファイルのはず");
  let total = 0;
  for (const f of files) {
    const data = JSON.parse(readFileSync(path.join(ROOT, "kb", f), "utf8"));
    assert.ok(data.license, `${f} にライセンス情報がありません`);
    total += Object.keys(data.tags).length;
  }
  assert.ok(total > 40000, `タグ付与総数が想定外: ${total}`);
});

// ---------- #425 階層要約 ----------
test("buildSummaries は層1〜層3を実データから作る", () => {
  const regions = [{ id: "karuizawa", name: "軽井沢", prefecture: "長野県", tagline: "避暑地", spotCount: 2 }];
  const spots = [
    { id: "a", regionId: "karuizawa", prefecture: "長野県", name: "雲場池", category: "公園", fame_score: 69 },
    { id: "b", regionId: "karuizawa", prefecture: "長野県", name: "旧軽井沢銀座", category: "商店街", fame_score: 82 },
  ];
  const out = buildSummaries(regions, spots);
  assert.equal(out.layers.block.length, 8);
  const chubu = out.layers.block.find((b) => b.name === "中部");
  assert.ok(chubu.summary.includes("長野県"));
  const nagano = out.layers.prefecture.find((p) => p.name === "長野県");
  assert.equal(nagano.block, "中部");
  assert.ok(nagano.summary.includes("旧軽井沢銀座"));
  const area = out.layers.area.find((a) => a.id === "karuizawa");
  assert.ok(area.summary.includes("軽井沢"));
  assert.equal(BLOCKS["沖縄県"], "九州・沖縄");
});

test("kb/summaries.json が生成されていて47都道府県・8ブロックを含む", () => {
  assert.ok(existsSync(path.join(ROOT, "kb", "summaries.json")), "kb/summaries.json がありません");
  const data = JSON.parse(readFileSync(path.join(ROOT, "kb", "summaries.json"), "utf8"));
  assert.equal(data.layers.block.length, 8);
  assert.equal(data.layers.prefecture.length, 47);
  assert.ok(data.layers.area.length >= 300);
  assert.ok(data.license.fieldLicenses, "summaries.json にフィールド別ライセンスがありません");
});

// ---------- #426 ライセンス分離 ----------
test("attribution は全成果物の派生元を宣言済みソースで説明できる", () => {
  const data = buildAttribution();
  assert.deepEqual(validateAttribution(data), []);
  const wiki = data.sources.find((s) => s.id === "wikipedia");
  assert.equal(wiki.license, "CC BY-SA 4.0");
  assert.ok(existsSync(path.join(ROOT, "kb", "attribution.json")), "kb/attribution.json がありません");
  const onDisk = JSON.parse(readFileSync(path.join(ROOT, "kb", "attribution.json"), "utf8"));
  assert.deepEqual(validateAttribution(onDisk), []);
});

// ---------- #428 エリア品質 ----------
test("mismatchOf は名前とカテゴリの不整合を検出する", () => {
  assert.ok(mismatchOf({ name: "湯の峰温泉", category: "公園" }));
  assert.equal(mismatchOf({ name: "湯の峰温泉", category: "温泉" }), null);
  assert.ok(mismatchOf({ name: "姫路城", category: "テーマパーク" }));
  assert.equal(mismatchOf({ name: "姫路城", category: "城・史跡" }), null);
  assert.equal(mismatchOf({ name: "ただの公園", category: "公園" }), null);
});

test("analyzeAreaQuality は説明不足と不整合をエリア別に集計する", () => {
  const regions = [{ id: "r1", name: "エリア1", prefecture: "長野県" }];
  const spots = [
    { id: "a", regionId: "r1", name: "良いスポット", category: "公園", description: "十分な長さの説明文がここに入っています。散策路も案内しています。" },
    { id: "b", regionId: "r1", name: "説明なし", category: "公園", description: "" },
    { id: "c", regionId: "r1", name: "変な温泉", category: "商店街", description: "短い" },
  ];
  const rows = analyzeAreaQuality(regions, spots);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].descMissing, 1);
  assert.equal(rows[0].descShort, 1);
  assert.equal(rows[0].mismatchCount, 1);
  assert.ok(rows[0].score > 0);
});
