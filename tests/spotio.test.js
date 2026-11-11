// スポットの取り込み・書き出し（packages/core/spotio.mjs）の試験。ファイルも通信も使いません。

import assert from "node:assert/strict";
import test from "node:test";

import {
  CSV_COLUMNS, EXPORT_SCHEMA, decodeText, detectFormat, formatSpots, nearIndex, parseCsv, parseSpots,
} from "../packages/core/spotio.mjs";

const SPOTS = [
  { id: "u:aaaaaa01", name: "裏高尾の湧き水", lat: 35.64, lng: 139.25, genres: ["nature", "view"], description: "冷たい、\"おいしい\"水\n2行目", dwell: 20 },
  { id: "u:aaaaaa02", name: "A&B <美術館>", lat: 35.1, lng: 139.2, category: "美術館", url: "https://example.jp/?a=1&b=2", fee: 500 },
];

test("CSV: 引用符・改行入りの欄・CRLF・BOM を読み、同じ中身に戻る", () => {
  const csv = formatSpots(SPOTS, "csv");
  assert.equal(csv.split("\r\n")[0], CSV_COLUMNS.join(","));
  const r = parseSpots("﻿" + csv, { format: "csv" });
  assert.deepEqual(r.bad, []);
  assert.equal(r.ok.length, 2);
  assert.equal(r.ok[0].spot.description, "冷たい、\"おいしい\"水\n2行目");
  assert.deepEqual(r.ok[0].spot.genres, ["nature", "view"]);
  assert.equal(r.ok[1].spot.fee, 500);
  assert.deepEqual(parseCsv('a,b\r\n"x,y","z""w"\r\n'), [["a", "b"], ["x,y", 'z"w']]);
  assert.throws(() => parseCsv('a\n"open'), /閉じていません/);
});

test("CSV: 日本語の列名・タブ区切り・使わない列を知らせる", () => {
  const r = parseSpots("名前\t緯度\t経度\t住所\t好き度\n秘密の滝\t35.1\t139.2\t静岡県\t5\n", { format: "csv" });
  assert.deepEqual(r.bad, []);
  assert.equal(r.ok[0].spot.address, "静岡県");
  assert.deepEqual(r.ignored, ["好き度"]);
  assert.match(parseSpots("title,x\nfoo,1\n", { format: "csv" }).errors.join(), /緯度・経度の列/);
});

test("CSV: おかしい行は行番号と理由を返し、残りは使う（部分失敗）", () => {
  const r = parseSpots([
    "name,lat,lng,fee",
    "よい場所,35.1,139.2,0",
    ",35,139,",                 // 名前が無い
    "外れ,95,139,",             // 範囲外
    "入れ替わり,139.2,35.1,",   // 緯度・経度が逆
    "ゼロ,0,0,",                // 座標が無い
    "料金,35,139,abc",          // 数でない
  ].join("\n"), { format: "csv" });
  assert.equal(r.ok.length, 1);
  assert.deepEqual(r.bad.map((b) => b.line), [3, 4, 5, 6, 7]);
  assert.match(r.bad[2].errors.join(), /入れ替わって/);
  assert.match(r.bad[3].errors.join(), /0,0/);
});

test("CSV の書き出しは、表計算ソフトで式として動かない", () => {
  const csv = formatSpots([{ id: "u:x1", name: "=HYPERLINK(\"http://evil\")", lat: 35, lng: 139 }], "csv");
  assert.match(csv, /"'=HYPERLINK/);
  // 取り込み直すと、頭の ' は外れる
  assert.equal(parseSpots(csv, { format: "csv" }).ok[0].spot.name, "=HYPERLINK(\"http://evil\")");
});

test("GeoJSON: 書き出しと取り込みが往復し、点でないものは断る", () => {
  const g = formatSpots(SPOTS, "geojson");
  const j = JSON.parse(g);
  assert.equal(j.tabisaki.schema, EXPORT_SCHEMA);
  assert.deepEqual(j.features[0].geometry.coordinates, [139.25, 35.64]);
  const r = parseSpots(g, { format: "geojson" });
  assert.equal(r.ok.length, 2);
  assert.equal(r.ok[1].spot.url, "https://example.jp/?a=1&b=2");
  const line = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "道" }, geometry: { type: "LineString", coordinates: [[139, 35], [139.1, 35.1]] } }] });
  assert.match(parseSpots(line, { format: "geojson" }).bad[0].errors.join(), /点ではありません/);
});

test("KML: 書き出しと取り込みが往復する。エスケープ・CDATA を読み、DOCTYPE は読まない", () => {
  const k = formatSpots(SPOTS, "kml");
  assert.match(k, /A&amp;B &lt;美術館&gt;/);
  const r = parseSpots(k, { format: "kml" });
  assert.equal(r.ok.length, 2);
  assert.equal(r.ok[1].spot.name, "A&B <美術館>");
  assert.equal(r.ok[1].spot.fee, 500);
  assert.deepEqual(r.ok[0].spot.genres, ["nature", "view"]);
  const mymaps = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
    <name><![CDATA[滝 & 茶屋]]></name><description><![CDATA[<b>おすすめ</b>]]></description>
    <Point><coordinates>139.2,35.1,0</coordinates></Point></Placemark></Document></kml>`;
  const m = parseSpots(mymaps, { format: "kml" });
  assert.equal(m.ok[0].spot.name, "滝 & 茶屋");
  assert.equal(m.ok[0].spot.lat, 35.1);
  const xxe = `<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY x SYSTEM "file:///etc/passwd">]><kml><Placemark><name>&x;</name></Placemark></kml>`;
  assert.match(parseSpots(xxe, { format: "kml" }).errors.join(), /DOCTYPE/);
});

test("JSON: 旅さきの形と、新しい版は断る", () => {
  const r = parseSpots(formatSpots(SPOTS, "json"), { format: "json" });
  assert.equal(r.ok.length, 2);
  assert.match(parseSpots(JSON.stringify({ schema: "tabisaki.spots/9", spots: [] }), { format: "json" }).errors.join(), /新しい版/);
});

test("形を当てる・文字コードを当てる（UTF-8 と Shift_JIS）", () => {
  assert.equal(detectFormat("a.csv"), "csv");
  assert.equal(detectFormat("a.kml"), "kml");
  assert.equal(detectFormat("a.geojson"), "geojson");
  assert.equal(detectFormat("a.json", '{"type":"FeatureCollection","features":[]}'), "geojson");
  assert.equal(detectFormat("a.json", '{"spots":[]}'), "json");
  assert.equal(detectFormat("", "<kml>"), "kml");

  const utf8 = new TextEncoder().encode("﻿名前,緯度,経度\n滝,35,139\n");
  assert.deepEqual(decodeText(utf8), { text: "名前,緯度,経度\n滝,35,139\n", encoding: "utf-8" });
  // 「名前」の Shift_JIS
  const sjis = new Uint8Array([0x96, 0xbc, 0x91, 0x4f]);
  assert.deepEqual(decodeText(sjis), { text: "名前", encoding: "shift_jis" });
  assert.equal(decodeText(sjis, "shift_jis").text, "名前");
  assert.throws(() => decodeText(utf8, "ebcdic"), /使えません/);
});

test("重なり: 近くて名前が同じものだけ", () => {
  const idx = nearIndex([{ id: "a", name: "高尾山薬王院", lat: 35.6256, lng: 139.2472 }, { id: "b", name: "別の寺", lat: 35.6256, lng: 139.2472 }]);
  assert.deepEqual(idx.find({ name: "高尾山薬王院", lat: 35.6257, lng: 139.2473 }).map((h) => h.spot.id), ["a"]);
  assert.deepEqual(idx.find({ name: "高尾山薬王院", lat: 35.64, lng: 139.2472 }), []);
});
