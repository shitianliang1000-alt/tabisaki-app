// 取り込んだ外部データ（kb/）そのもののテスト。
//
// 2つの元データ
//   ・国土数値情報 観光資源（国土交通省）
//   ・観光資源台帳の KML
// を、旅程に使える形にまとめたものです。件数が多いぶん、壊れ方も
// 静かなので（同じ名前が2回並ぶ、有名な場所が丸ごと落ちる、など）
// 出来上がったファイルに対して直接ものを言います。

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { genresForCategory, profileOf } from "../packages/core/src/feasibility.js";

const KB_DIR = path.join(import.meta.dirname, "..", "kb");
const has = fs.existsSync(path.join(KB_DIR, "index.json"));
const read = (f) => JSON.parse(fs.readFileSync(path.join(KB_DIR, f), "utf8"));

const index = has ? read("index.json") : null;
const regions = has ? read("regions.json").regions : [];
const spots = has
  ? index.shards.flatMap((s) => read(s.file).spots)
  : [];

test("知識ベースが生成されている", { skip: !has && "kb/ が未生成" }, () => {
  assert.ok(regions.length > 1000, `エリア ${regions.length}`);
  assert.ok(spots.length > 10000, `スポット ${spots.length}`);
  assert.equal(index.counts.regions, regions.length);
  assert.equal(index.counts.spots, spots.length);
});

test("出典が記録されている（表示が条件のデータを含むため）",
     { skip: !has && "kb/ が未生成" }, () => {
  assert.ok(index.sources?.length >= 2);
  assert.ok(index.sources.some((s) => /国土数値情報/.test(s.name)));
  assert.ok(index.sources.some((s) => s.url));
});

// 名前が同じでも、離れていれば別の場所です。
//
// 「白浜海水浴場」は和歌山にも静岡にもあります。「徴古館」も複数あります。
// 全国で名前が一意であることを求めると、実在する別の場所を落とすことに
// なります。困るのは「同じ旅程に同じ名前が2回並ぶ」ことなので、
// **同じエリアの中**と、**近い距離**で見ます。

function km(a, b) {
  const R = 6371;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = p2 - p1;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

test("同じエリアに、同じ名前の場所が二重に入っていない",
     { skip: !has && "kb/ が未生成" }, () => {
  const seen = new Map();
  const dups = [];
  for (const s of spots) {
    const key = `${s.regionId}\u0000${s.name}`;
    if (seen.has(key)) dups.push(s.name);
    else seen.set(key, s);
  }
  assert.deepEqual(dups, [],
    `同じ旅程に2回出ます: ${dups.slice(0, 5)}`);
});

test("同じ名前で近い場所が、別々に入っていない",
     { skip: !has && "kb/ が未生成" }, () => {
  const byName = new Map();
  for (const s of spots) {
    const list = byName.get(s.name);
    if (list) list.push(s); else byName.set(s.name, [s]);
  }
  const close = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (km(list[i], list[j]) < 5) close.push(name);
      }
    }
  }
  assert.deepEqual(close, [],
    `同じ場所が2件に分かれています: ${close.slice(0, 5)}`);
});

test("名指しで探される場所が落ちていない", { skip: !has && "kb/ が未生成" }, () => {
  const names = new Set(spots.map((s) => s.name));
  const probes = ["宗谷岬", "知床五湖", "白金 青い池", "縄文杉",
                  "兼六園", "厳島神社", "首里城公園", "松山城"];
  const missing = probes.filter((p) => !names.has(p));
  assert.deepEqual(missing, [], `落ちています: ${missing}`);
});

test("エリアの代表に選んだ場所が、穴場になっていない",
  { skip: !has && "kb/ が未生成" }, () => {
  // 手で選んだエリアの見どころ（kamakura-1 など）は、知られている順に
  // 並べてあります。その知名度が**逆向きに**付いていて、東大寺・平等院・
  // 姫路城・鶴岡八幡宮が「穴場」（30点）、若草山が「定番」（82点）でした。
  // 「鎌倉を1日で」の旅程に、鶴岡八幡宮が入らなかった原因です。
  const curated = spots.filter((s) => /^[a-z]+-1$/.test(s.id)
    && s.id.startsWith(`${s.regionId}-`) && !s.id.startsWith("csv-"));
  assert.ok(curated.length > 30, `代表 ${curated.length}件`);
  const hidden = curated.filter((s) => s.fame_tier === "hidden");
  assert.deepEqual(hidden.map((s) => s.name), []);
  for (const id of ["nara-1", "uji-1", "himeji-1", "kamakura-1", "nikko-1"]) {
    const s = spots.find((x) => x.id === id);
    const rest = spots.filter((x) => x.regionId === s.regionId
      && /^[a-z]+-\d+$/.test(x.id) && x.id !== id);
    assert.ok(rest.every((x) => (x.fame_score ?? 0) <= s.fame_score),
      `${s.name}（${s.fame_score}）より知られている扱いの場所があります`);
  }
});

test("座標が日本の範囲に収まっている", { skip: !has && "kb/ が未生成" }, () => {
  const bad = spots.filter((s) =>
    !(s.lat >= 20 && s.lat <= 46 && s.lng >= 122 && s.lng <= 154));
  assert.equal(bad.length, 0, `範囲外: ${bad.slice(0, 3).map((s) => s.name)}`);
});

test("すべてのスポットが、実在するエリアに属している",
     { skip: !has && "kb/ が未生成" }, () => {
  const ids = new Set(regions.map((r) => r.id));
  const orphan = spots.filter((s) => !ids.has(s.regionId));
  assert.equal(orphan.length, 0);
});

test("エリアの拠点が、そのエリアの範囲内にある",
     { skip: !has && "kb/ が未生成" }, () => {
  // 宿を取る地点になります。中心から遠いと、まったく別の町を指します。
  const far = regions.filter((r) => {
    const dLat = Math.abs(r.stationLat - r.lat);
    const dLng = Math.abs(r.stationLng - r.lng);
    return dLat > 0.6 || dLng > 0.6;
  });
  assert.equal(far.length, 0, `拠点が離れすぎ: ${far.slice(0, 3).map((r) => r.name)}`);
});

test("外部データの営業時間は「目安」として扱われる",
     { skip: !has && "kb/ が未生成" }, () => {
  const sample = spots.find((s) => s.src);
  assert.ok(sample, "外部データの印が付いていません");
  const prof = profileOf({ ...sample, verified: false });
  assert.equal(prof.estimated, true,
    "確認していない営業時間が、確定値として扱われています");
});

test("分類からジャンルを補える（ファイルには持たせていない）", () => {
  assert.deepEqual(genresForCategory("温泉"), ["onsen"]);
  assert.deepEqual(genresForCategory("城"), ["history"]);
  assert.deepEqual(genresForCategory("知らない分類"), ["city"]);
});

test("読み込み時に、省いた項目が補われる", async () => {
  // fetch を差し替えて、公開知識ベースの読み込み経路を通します
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const name = String(url).split("/").pop();
    const body = name === "index.json"
      ? { regionsFile: "regions.json", shards: [{ file: "spots-00.json" }],
          counts: { regions: 1, spots: 1 },
          sources: [{ name: "テスト", url: "https://example.test" }] }
      : name === "regions.json"
        ? { regions: [{ id: "r1", name: "テスト町", prefecture: "北海道",
                        lat: 43, lng: 141, stationLat: 43, stationLng: 141 }] }
        : { spots: [{ id: "r1-1", regionId: "r1", name: "テスト城",
                      category: "城", lat: 43.01, lng: 141.01,
                      fame_tier: "known", src: "kokudo" }] };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const kb = await loadKnowledgeBase();
    const spot = kb.spots[0];
    assert.equal(spot.region, "テスト町");
    assert.equal(spot.prefecture, "北海道");
    assert.deepEqual(spot.genres, ["history"]);
    assert.equal(spot.wikipedia, "テスト城");
    assert.equal(spot.fame_score, 55);
    assert.equal(spot.verified, false);
    assert.equal(kb.attribution[0].name, "テスト");
  } finally {
    globalThis.fetch = real;
  }
});

test("公開知識ベースを読めないときは、同梱データに落ちて理由を言う", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("接続できません"); };
  try {
    const kb = await loadKnowledgeBase();
    assert.equal(kb.source, "sample");
    assert.match(kb.loadError, /読み込めませんでした/);
    assert.ok(kb.spots.length > 0, "真っ白になっています");
  } finally {
    globalThis.fetch = real;
  }
});

// --- 停留所データ ----------------------------------------------------------
//
// もとは国土数値情報の2008年度版（鉄道）と2012年3月時点（バス停）です。
// 17年ぶんの変化は tools/station_updates.py の差分であてています。
// 網羅ではないので、「入れたはずのものが入っているか」だけを固定します。

import { readFileSync } from "node:fs";

const railStops = JSON.parse(
  readFileSync(new URL("../kb/stops-rail.json", import.meta.url), "utf8"));

test("駅データに、延伸で増えた新幹線の駅が入っている", () => {
  const names = new Set(railStops.stops.map((s) => s[2]));
  for (const n of ["新函館北斗", "上越妙高", "七戸十和田", "黒部宇奈月温泉",
                   "新高岡", "越前たけふ", "嬉野温泉", "新大村", "新鳥栖"]) {
    assert.ok(names.has(n), `${n} が入っていません`);
  }
});

test("廃止された路線の駅は、出発地の候補に出てこない", () => {
  const names = new Set(railStops.stops.map((s) => s[2]));
  // 三江線・日高本線・夕張支線・札沼線・岩泉線・江差線
  for (const n of ["石見川本", "様似", "夕張", "新十津川", "岩泉", "江差",
                   "増毛", "幾寅"]) {
    assert.ok(!names.has(n), `${n} が残っています（廃止された駅です）`);
  }
});

test("同じ名前の別の駅まで消していない", () => {
  const names = new Set(railStops.stops.map((s) => s[2]));
  // 「長谷」は三江線にもありましたが、兵庫と神奈川のものは残ります。
  for (const n of ["長谷", "金山", "大和田", "中里", "神明", "落合",
                   "三次", "江津", "富良野", "新得", "木古内"]) {
    assert.ok(names.has(n), `${n} まで消えています`);
  }
});

test("座標は日本の範囲に収まっている", () => {
  for (const [lat, lng, name] of railStops.stops) {
    assert.ok(lat > 24 && lat < 46, `${name} の緯度が範囲外: ${lat}`);
    assert.ok(lng > 122 && lng < 154, `${name} の経度が範囲外: ${lng}`);
  }
});

// --- 同じ場所が二重に入っていないか ------------------------------------------
//
// 収録は複数の出典を継ぎ足して作っているので、同じ建物が別々の名前で
// 入ることがありました（萬翠荘 と 愛媛県美術館分館郷土美術館）。
// そのままだと、同じ場所が1つの旅程に2回出ます。

function spotsOf() {
  const out = [];
  // 段の一覧は index.json が持っています。ここに書き写すと、段が
  // 増えたときに、増えたぶんだけ黙って見ないテストになります。
  for (const shard of index.shards) {
    const url = new URL(`../kb/${shard.file}`, import.meta.url);
    out.push(...JSON.parse(readFileSync(url, "utf8")).spots);
  }
  return out;
}

/** tools/dedupe_spots.py と同じ見かた。括弧の中どうしは比べません。 */
function nameParts(name) {
  const clean = (t) => t
    .normalize("NFKC")
    .replace(/[\s　・､,、\-−―/／]/g, "")
    .replace(/(市|町|村|区|県|都|府|道|国)立/g, "$1");
  const m = /[（(](.+?)[)）]/.exec(name);
  return {
    full: clean(name),
    base: clean(name.replace(/[（(].*?[)）]/g, "")),
    paren: m ? clean(m[1]) : null,
  };
}

function samePlace(a, b) {
  const x = nameParts(a.name);
  const y = nameParts(b.name);
  if (x.full === y.full) return true;
  // 括弧の中が、相手の名前そのもの（別名として書かれている）
  if (x.paren && x.paren === y.full) return true;
  if (y.paren && y.paren === x.full) return true;
  // 片方だけ括弧つき。両方にあるときは比べません
  // （「(海水浴場)」「(駐車場)」のような分類の札が多いため）
  if (x.paren && !y.paren && x.base === y.full) return true;
  if (y.paren && !x.paren && y.base === x.full) return true;
  return false;
}

test("同じ場所が、別の名前で二重に入っていない", () => {
  const all = spotsOf();
  const cell = new Map();
  for (const s of all) {
    const key = `${Math.round(s.lat / 0.02)},${Math.round(s.lng / 0.02)}`;
    (cell.get(key) ?? cell.set(key, []).get(key)).push(s);
  }
  const dupes = [];
  const seen = new Set();
  for (const s of all) {
    const gx = Math.round(s.lat / 0.02);
    const gy = Math.round(s.lng / 0.02);
    // 隣の升も見ます。升の境目をまたぐ組を見落とさないため。
    const near = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) near.push(...(cell.get(`${gx + dx},${gy + dy}`) ?? []));
    }
    for (const b of near) {
      const a = s;
      if (a.id >= b.id || seen.has(`${a.id}|${b.id}`)) continue;
      seen.add(`${a.id}|${b.id}`);
      {
        if (!samePlace(a, b)) continue;
        const dy = (a.lat - b.lat) * 111;
        const dx = (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180);
        if (Math.hypot(dx, dy) <= 2) {
          dupes.push(`${a.name}[${a.id}] / ${b.name}[${b.id}]`);
        }
      }
    }
  }
  assert.deepEqual(dupes, [], `同じ場所が二重に入っています:\n${dupes.join("\n")}`);
});

test("id はひとつだけ", () => {
  const ids = spotsOf().map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "id が重複しています");
});

test("収録件数の表示と、中身が一致している", () => {
  const index = JSON.parse(
    readFileSync(new URL("../kb/index.json", import.meta.url), "utf8"));
  assert.equal(index.counts.spots, spotsOf().length,
    "index.json の件数が中身とずれています");
});

// ---------------------------------------------- 拠点は、実在する駅である --
//
// エリアの拠点は、1,370件のうち1,323件が「千代田区中心部」「京都市中心部」
// でした。座標はエリアの代表点、名前は自動で付けたものです。これが
// 画面の3つの不満の正体でした。
//
//   東京駅発なのに   8:00 東京駅 → 千代田区中心部（0.8km）
//   無駄な移動       8:15 貨幣博物館へ移動（1.2km・東京駅の隣）
//   時間が出ない     Yahoo!は「千代田区中心部」を解決できません
//
// 直しかたは tools/region_stations.py にあります。

test("エリアの拠点は、実在する駅になっている",
     { skip: !has && "kb/ が未生成" }, () => {
  const named = regions.filter((r) => r.station);
  const fake = named.filter((r) => r.station.includes("中心部"));
  // 鉄道の無い離島や山間部は残ります（佐渡市など）。それ以外は駅です。
  assert.ok(fake.length < named.length * 0.2,
    `拠点が駅でないエリアが多すぎます: ${fake.length}/${named.length}`);
  const kyoto = regions.find((r) => r.name === "京都市");
  assert.equal(kyoto?.station, "京都駅");
});

test("拠点の駅は、そのエリアから遠くない",
     { skip: !has && "kb/ が未生成" }, () => {
  const far = regions.filter((r) => r.stationLat
    && km(r, { lat: r.stationLat, lng: r.stationLng }) > 35);
  assert.deepEqual(far.map((r) => `${r.name}:${r.station}`), []);
});
