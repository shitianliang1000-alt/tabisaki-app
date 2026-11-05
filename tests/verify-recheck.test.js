// 未確認スポットの照らし直し（tools/verify_spots_recheck.mjs）の照合ルールの試験。
// 通信はしません。名前と座標の比べ方だけを見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { nameScore, judge, merge, queryName, isSelf } from "../tools/verify_spots_recheck.mjs";

const KB = path.join(import.meta.dirname, "..", "kb");

test("同じ名前は表記の揺れがあっても一致", () => {
  assert.equal(nameScore("袋田の滝", "袋田ノ滝"), 2);
  assert.equal(nameScore("関ヶ原古戦場", "関ケ原古戦場"), 2);
  assert.equal(nameScore("ｶﾇｰ体験", "カヌー体験"), 2);
  assert.equal(nameScore("白山姫神社（本宮）", "白山姫神社"), 2);
});

test("地名だけが重なる名前は一致にしない", () => {
  assert.equal(nameScore("鹿追町コミュニティセンター郷土資料室", "鹿追町"), 0);
  assert.equal(nameScore("陸別町民スキー場", "陸別町"), 0);
  assert.equal(nameScore("楠美家住宅", "旧楠美家住宅"), 1);
});

test("施設|地区 の名前は施設名で調べる", () => {
  assert.equal(queryName({ name: "黒岳の湯|層雲峡" }), "黒岳の湯");
  assert.equal(queryName({ name: "清水寺" }), "清水寺");
});

test("収録元と同じ OSM ノード・Wikidata 項目は裏付けにならない", () => {
  const spot = { id: "os-1", name: "カヌー体験", lat: 42.74, lng: 141.71, osm: "node/5603040035", src: "osm-tourlist" };
  assert.ok(isSelf(spot, "node/5603040035"));
  assert.equal(judge(spot, [{ name: "カヌー体験", lat: 42.74, lng: 141.71, ref: "node/5603040035" }], 2000), null);
  assert.ok(isSelf({ id: "wd-Q1" }, "Q1"));
});

test("近くの同名は確度 high、遠すぎるものは採らない", () => {
  const spot = { name: "青い森公園", lat: 40.8167, lng: 140.7503 };
  const near = judge(spot, [{ name: "青い森公園", lat: 40.8169, lng: 140.7505, ref: "Q98690974" }], 2000);
  assert.equal(near.confidence, "high");
  assert.ok(near.distanceM < 50);
  assert.equal(judge(spot, [{ name: "青い森公園", lat: 40.9, lng: 140.75 }], 2000), null);
});

test("OSM 由来のスポットが OSM の別オブジェクトと一致しても high にしない", () => {
  const spot = { name: "東北温泉", lat: 40.5, lng: 141.5, src: "osm-tourlist", osm: "node/1" };
  const r = judge(spot, [{ name: "東北温泉", lat: 40.5001, lng: 141.5001, ref: "node/2" }], 2000);
  assert.equal(r.confidence, "medium");
});

test("2つ以上の情報源で一致すれば確度 high", () => {
  const prev = { status: "name_match_low" };
  const one = merge(prev, { osm: { confidence: "medium", matchedName: "x", distanceM: 10, ref: "way/1" } }, "2026-11-03");
  assert.equal(one.status, "verified_osm");
  assert.equal(one.confidence, "medium");
  const two = merge(prev, {
    gsi: { confidence: "medium", matchedName: "x", distanceM: 30 },
    wd: { confidence: "medium", matchedName: "x", distanceM: 20, ref: "Q2" },
  }, "2026-11-03");
  assert.equal(two.confidence, "high");
  assert.deepEqual(two.alsoMatched, ["wd"]);
  assert.equal(two.previous, "name_match_low");
  assert.equal(merge(prev, {}, "2026-11-03"), null);
});

test("kb の検証記録は既知の status だけを使う", () => {
  const known = new Set([
    "verified", "verified_manual", "verified_web", "verified_osm", "verified_wikidata", "verified_gsi",
    "name_match_high", "name_match_medium", "name_match_low", "not_found_web",
  ]);
  for (const f of readdirSync(KB).filter((f) => /^verification-jp.*\.json$/.test(f))) {
    const d = JSON.parse(readFileSync(path.join(KB, f), "utf8"));
    for (const [id, r] of Object.entries(d.records)) {
      assert.ok(known.has(r.status), `${f} ${id}: ${r.status}`);
      if (r.status === "verified_manual") assert.ok(r.source, `${f} ${id}: 手で確かめた記録には出典が要る`);
    }
  }
});

test("候補が短く固有の部分が落ちる名前や、道路名は一致にしない", () => {
  assert.equal(nameScore("宮原八幡宮", "八幡宮"), 0);
  assert.equal(nameScore("権現崎", "権現崎線"), 0);
  assert.equal(nameScore("鶴ヶ城跡", "鶴ヶ城"), 1);
  assert.equal(nameScore("市浦歴史民俗資料館", "五所川原市市浦歴史民俗資料館"), 1);
});
