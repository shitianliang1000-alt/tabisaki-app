// 収録にある場所へ、OpenStreetMap から営業時間・電話・サイト・車いすの可否を足す
// 道具（tools/osm_enrich.py。Issue #423）。
//
// 配布ファイルは数GBあるので、ここでは小さな作り物（tests/fixtures/
// osm-enrich-mini.osm）に罠を仕込んで、決まりが働くことを確かめます。
//
//   ① 同じ名前の別のもの（バス停・土産物店）を採らない
//   ② 離れた同名を採らない
//   ③ 名前の表記が違っても、Wikidata の番号が同じなら採る。番号が違えば採らない
//   ④ 点と面に分かれた値を1つにまとめる（近いほうが勝つ）
//   ⑤ おかしな値（電話「あり」）を捨てる。値を作らない
//   ⑥ 収録のほかの項目に触らない。走らせ直すと前回のぶんが外れる
//   ⑦ Overpass API を使わない
//
// Python と osmium（pip install osmium）があるときだけ、実際に動かします。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const tool = fs.readFileSync(new URL("tools/osm_enrich.py", root), "utf8");

const py = spawnSync("python3", ["-c", "import osmium"], { encoding: "utf8" });
const skip = py.error || py.status !== 0
  ? "python3 か osmium（pip install osmium）がありません" : false;

const SPOTS = [
  { id: "t-museum", name: "試験美術館", category: "美術館", lat: 35.0001, lng: 135.0001 },
  { id: "t-temple", name: "試験寺", category: "寺院", lat: 35.1005, lng: 135.1005 },
  { id: "wd-Q999001", name: "別名寺", category: "寺院", lat: 35.2000, lng: 135.2000 },
  { id: "t-castle", name: "試験城", category: "城", lat: 35.3000, lng: 135.3000 },
  { id: "t-far", name: "遠い試験館", category: "博物館", lat: 35.4000, lng: 135.4000 },
  { id: "t-park", name: "値試験公園", category: "公園", lat: 35.5000, lng: 135.5000 },
  { id: "wd-Q999002", name: "番号試験神社", category: "神社", lat: 35.6000, lng: 135.6000 },
  { id: "t-market", name: "試験市場", category: "市場", lat: 35.7000, lng: 135.7000 },
  { id: "t-none", name: "値なし公園", category: "公園", lat: 35.8000, lng: 135.8000 },
  { id: "t-keep", name: "前回のぶんが残っている場所", category: "公園", lat: 36.5, lng: 136.5,
    description: "説明はそのまま", osmInfo: { ref: "node/999", phone: "000" } },
];

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osm-enrich-"));
  const kb = path.join(dir, "kb");
  fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, "spots-test.json"), JSON.stringify({ spots: SPOTS }));
  fs.writeFileSync(path.join(kb, "index.json"),
    JSON.stringify({ sources: [{ name: "もとの出典", url: "" }] }));
  const fixture = path.join(dir, "mini.osm");
  fs.copyFileSync(new URL("tests/fixtures/osm-enrich-mini.osm", root), fixture);
  const r = spawnSync("python3", ["tools/osm_enrich.py", "--kb", kb, "--write", fixture],
    { cwd: root.pathname, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const spots = JSON.parse(fs.readFileSync(path.join(kb, "spots-test.json"), "utf8")).spots;
  const index = JSON.parse(fs.readFileSync(path.join(kb, "index.json"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  return { by: Object.fromEntries(spots.map((s) => [s.id, s])), index, out: r.stdout };
}

let cached;
const result = () => (cached ??= run());

test("営業時間・電話・サイト・車いすの可否を、OSM にあるとおりに足す", { skip }, () => {
  const info = result().by["t-museum"].osmInfo;
  assert.equal(info.ref, "node/1");
  assert.equal(info.opening_hours, "Tu-Su 10:00-18:00");
  assert.equal(info.phone, "+81 75-123-4567");
  assert.equal(info.website, "https://example.jp/museum");
  assert.equal(info.wheelchair, "yes");
  assert.equal(info.fee, "yes");
  assert.equal(info.via, "name");
  assert.ok(info.m < 50, `距離 ${info.m}m`);
});

test("同じ名前のバス停・土産物店は、別のものなので採らない", { skip }, () => {
  const { by } = result();
  // バス停の wheelchair=no が、美術館の値を上書きしていないこと。
  assert.equal(by["t-museum"].osmInfo.wheelchair, "yes");
  assert.equal(by["t-museum"].osmInfo.refs, undefined);
  // 城と同じ名前の土産物店。
  assert.equal(by["t-castle"].osmInfo, undefined);
});

test("市場のように店を行き先として収録している分類は、店も採る", { skip }, () => {
  assert.equal(result().by["t-market"].osmInfo.opening_hours, "Mo-Sa 06:00-14:00");
});

test("離れた同名は採らない", { skip }, () => {
  assert.equal(result().by["t-far"].osmInfo, undefined);
});

test("Wikidata の番号が同じなら、名前の表記が違っても採る。違えば採らない", { skip }, () => {
  const { by } = result();
  const info = by["wd-Q999001"].osmInfo;
  assert.equal(info.ref, "node/20");
  assert.equal(info.via, "wikidata");
  assert.equal(info.phone, "+81-88-000-0000");
  // 名前は同じでも、OSM の側に別の番号が付いている。
  assert.equal(by["wd-Q999002"].osmInfo, undefined);
});

test("点と面に分かれた値を1つにまとめる。食い違ったら近いほうが勝つ", { skip }, () => {
  const info = result().by["t-temple"].osmInfo;
  // 収録の座標は面の重心（35.1005,135.1005）と同じ。面が先に来ます。
  assert.equal(info.ref, "way/100");
  assert.equal(info.opening_hours, "09:00-16:30");
  assert.equal(info.phone, "075-000-0000");
  assert.deepEqual(info.refs, ["node/14"]);
});

test("おかしな値は捨てる。値を作らない", { skip }, () => {
  const { by } = result();
  const info = by["t-park"].osmInfo;
  assert.equal(info.phone, undefined);
  assert.equal(info.wheelchair, undefined);
  assert.equal(info.website, "http://example.jp/park");
  // 足す値が OSM に無い場所には、何も足しません。
  assert.equal(by["t-none"].osmInfo, undefined);
});

test("収録のほかの項目には触らない。前回のぶんは外れる", { skip }, () => {
  const { by } = result();
  const keep = by["t-keep"];
  assert.equal(keep.osmInfo, undefined, "OSM に無くなった値が残っている");
  assert.equal(keep.description, "説明はそのまま");
  const m = by["t-museum"];
  assert.deepEqual([m.name, m.category, m.lat, m.lng],
    ["試験美術館", "美術館", 35.0001, 135.0001]);
});

test("索引に、ODbL の表示と数を書く", { skip }, () => {
  const { index } = result();
  assert.ok(index.sources.some((s) => s.name === "もとの出典"));
  assert.equal(index.sources.filter((s) => /© OpenStreetMap contributors/.test(s.name)
    && /ODbL/.test(s.name)).length, 1);
  assert.equal(index.osmEnrich.attribution, "© OpenStreetMap contributors");
  assert.equal(index.osmEnrich.license, "ODbL 1.0");
  assert.equal(index.osmEnrich.matched, 5);
  assert.equal(index.osmEnrich.fields.opening_hours, 3);
});

test("Overpass API を使わない（道具のどこにも問い合わせ先が無い）", () => {
  assert.doesNotMatch(tool, /overpass-api|overpass\.kumi|interpreter\?data=/i);
  assert.doesNotMatch(tool, /urllib|requests\.|http\.client|curl/);
});
