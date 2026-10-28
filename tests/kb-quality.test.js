// 分類とエリアの取り違えを直すルール（tools/kb_rules.mjs）の試験。
// 本物の kb/ にルールで直せる取り違えが残っていないことも見ます。
// 残っていたら node tools/fix_kb_quality.mjs --write → node tools/clean_names.mjs --write。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { categoryFix, regionFix } from "../tools/kb_rules.mjs";

const KB = path.join(import.meta.dirname, "..", "kb");
const has = existsSync(path.join(KB, "index.json"));

test("スキー場は温泉や山ではなくスキー場", () => {
  assert.equal(categoryFix({ name: "ジャイアントスキー場", category: "温泉" }).to, "スキー場");
  assert.equal(categoryFix({ name: "岩木山百沢スキー場", category: "山" }).to, "スキー場");
  assert.equal(categoryFix({ name: "白馬八方尾根スキー場", category: "スキー場" }), null);
});

test("美術館と博物館、寺と神社を名前で分ける", () => {
  assert.equal(categoryFix({ name: "青森県立美術館", category: "博物館" }).to, "美術館");
  assert.equal(categoryFix({ name: "刀剣博物館", category: "美術館" }).to, "博物館");
  // 美術と博物の両方を名乗るものは、どちらとも決めない
  assert.equal(categoryFix({ name: "豊橋市美術博物館", category: "美術館" }), null);
  assert.equal(categoryFix({ name: "薬師寺", category: "神社" }).to, "寺院");
  assert.equal(categoryFix({ name: "出雲大社京都分院", category: "神社" }), null);
  assert.equal(categoryFix({ name: "出羽三山神社", category: "寺院" }).to, "神社");
  assert.equal(categoryFix({ name: "道の駅あさひかわ", category: "観光名所" }).to, "道の駅");
});

test("別の県のエリアにぶら下がったスポットは、同じ県のいちばん近いエリアへ", () => {
  const regions = [
    { id: "katsushika", name: "葛飾区", prefecture: "東京都", lat: 35.74, lng: 139.85 },
    { id: "ichikawa", name: "市川市", prefecture: "千葉県", lat: 35.72, lng: 139.93 },
    { id: "chiba", name: "千葉市", prefecture: "千葉県", lat: 35.6, lng: 140.12 },
  ];
  const byId = new Map(regions.map((r) => [r.id, r]));
  const spot = { name: "戸定歴史館", regionId: "katsushika", lat: 35.78, lng: 139.91 };
  assert.equal(regionFix(spot, "千葉県", byId, regions).id, "ichikawa");
  assert.equal(regionFix({ ...spot, regionId: "ichikawa" }, "千葉県", byId, regions), null);
});

test("本物の kb/ にルールで直せる取り違えが残っていない", { skip: !has && "kb/ が未生成" }, () => {
  const read = (f) => JSON.parse(readFileSync(path.join(KB, f), "utf8"));
  const index = read("index.json");
  const regions = read(index.regionsFile ?? "regions.json").regions;
  const byId = new Map(regions.map((r) => [r.id, r]));
  const left = [];
  for (const shard of index.shards) {
    for (const s of read(shard.file).spots) {
      const c = categoryFix(s);
      if (c) left.push(`${s.name}: ${s.category} → ${c.to}`);
      const r = regionFix(s, shard.prefecture, byId, regions);
      if (r) left.push(`${s.name}: エリア → ${r.name}`);
    }
  }
  assert.deepEqual(left.slice(0, 10), [], `${left.length}件`);
});
