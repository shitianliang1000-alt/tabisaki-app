// エリア別のページ（tools/build_area_pages.mjs）。
//
// 公開のたびに作るページなので、作り直し忘れは起きません。かわりに、
// 作るものが壊れていないことをここで見ます。
//   ・名前に < や " が入っていても、ページが壊れない（収録は外のデータです）
//   ・アプリへのリンクが `?q=` で文を運ぶ
//   ・おかしなモデルコースは出さない（直す人のいないページです）

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appLink, breadcrumbLd, buildAll, courseFits, courseRadiusKm, courseItems, courseLink, courseSpotIds, curatedRegions, esc,
  examplePrompts, groupByChiho, isFar, nameList, nearbySpots, nextSaturday, pickPrefSpots,
  latestDay, pickFeatured, readableDescription, sentencesOf, shardSlug, sitemapXml, spotIcon,
} from "../tools/build_area_pages.mjs";
import { boundsOf, CARD_H, CARD_W, renderAreaCard } from "../tools/area_card.mjs";
import { inflateSync } from "node:zlib";

const BASE = "https://example.test/app/";

const REGION = {
  id: "hakone", name: "箱根", prefecture: "神奈川県", station: "箱根湯本駅",
  stationLat: 35.23, stationLng: 139.1, lat: 35.23, lng: 139.1,
  genres: ["onsen", "art", "nature"],
  tagline: "湯けむりと芦ノ湖", description: "都心から特急一本で行ける温泉地。",
};

const spot = (id, extra = {}) => ({
  id, name: `場所${id}`, regionId: "hakone", category: "美術館",
  fame_tier: "hidden", fame_score: 10, lat: 35.2, lng: 139.1, ...extra,
});

function itinOf(ids, regionId = "hakone", placeRegion = () => "hakone") {
  const at = (h, m = 0) => new Date(2026, 9, 17, h, m);
  const items = [];
  let h = 9;
  for (const id of ids) {
    items.push({ kind: "transit", title: "移動", start: at(h), end: at(h, 20) });
    items.push({ kind: "spot", title: `場所${id}`, spotId: id,
                 place: { id, regionId: placeRegion(id), description: `説明${id}` },
                 start: at(h, 20), end: at(h + 1) });
    h++;
  }
  return { regionId, days: [{ items }] };
}

test("記号はすべて逃がす", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(esc(null), "");
});

test("県の入れ物の名前から、URLの名前を取る", () => {
  assert.equal(shardSlug("spots-jp13-tokyo.json"), "tokyo");
  assert.equal(shardSlug("regions.json"), null);
});

test("例の日付は、次の土曜", () => {
  // 2026-10-09 は金曜。
  assert.equal(nextSaturday(new Date(2026, 9, 9)).getDate(), 10);
  // 土曜なら翌週の土曜（その日はもう始まっています）。
  assert.equal(nextSaturday(new Date(2026, 9, 10)).getDate(), 17);
  assert.equal(nextSaturday(new Date(2026, 9, 10)).getDay(), 6);
});

test("アプリへのリンクは、文を ?q= で運ぶ", () => {
  assert.equal(appLink("../../", "箱根で温泉 & 美術館"),
    "../../app?q=%E7%AE%B1%E6%A0%B9%E3%81%A7%E6%B8%A9%E6%B3%89%20%26%20%E7%BE%8E%E8%A1%93%E9%A4%A8");
});

test("書きかたの例は、そのエリアの分類から作る", () => {
  const got = examplePrompts(REGION);
  assert.equal(got[0], "箱根を1日でめぐる");
  assert.ok(got.includes("箱根で温泉でゆっくり"));
  assert.ok(got.length <= 4);
});

test("説明の無い穴場は並べない", () => {
  const { major, hidden } = pickPrefSpots([
    spot("a", { fame_tier: "major", fame_score: 90 }),
    spot("b", { description: "静かな寺" }),
    spot("c"),
  ]);
  assert.deepEqual(major.map((s) => s.id), ["a"]);
  assert.deepEqual(hidden.map((s) => s.id), ["b"]);
});

test("説明: 名前と分類と住所を並べただけのもの・住所だけのものは載せない", () => {
  assert.equal(readableDescription({ name: "アイヌ民族博物館",
    description: "アイヌ民族博物館（博物館）。若草町2-3-4" }), "");
  assert.equal(readableDescription({ name: "新星館（美術館）",
    description: "新星館（美術館）（美術館）。新星の丘" }), "");
  assert.equal(readableDescription({ name: "輪島工房長屋", src: "kokudo",
    description: "河井町4-66-1" }), "");
  assert.equal(readableDescription({ name: "某ダム",
    description: "北海道小樽市に所在するダム。型式:gravity 管理者:北海道" }), "");
  assert.equal(readableDescription({ name: "扇町公園",
    description: "扇町公園は、大阪府大阪市北区扇町にある都市公園である。" }), "");
  assert.equal(readableDescription({ name: "九戸城",
    description: "岩手県二戸市にある城跡・史跡。日本の城郭・城館跡のひとつ。" }), "");
});

test("説明: 読みがなを落とし、文の切れ目で短くし、別のものの記事は載せない", () => {
  assert.equal(readableDescription({ name: "胎内スキー場",
    description: "胎内スキー場（たいないスキーじょう）は、新潟県胎内市にあるスキー場で、春まで滑れる。" }),
  "胎内スキー場は、新潟県胎内市にあるスキー場で、春まで滑れる。");
  const long = readableDescription({ name: "長い場所",
    description: `長い場所は、${"あ".repeat(60)}。${"い".repeat(60)}。${"う".repeat(60)}。` });
  assert.ok(long.length <= 111 && long.endsWith("。"), long);
  assert.equal(readableDescription({ name: "CIAL鎌倉",
    description: "鎌倉駅は、神奈川県鎌倉市小町一丁目にある駅である。" }), "");
  assert.notEqual(readableDescription({ name: "暗門の滝",
    description: "暗門滝は青森県中津軽郡西目屋村に位置する滝。白神山地の暗門川にかかる。" }), "");
});

test("穴場: 定番の表記違い・同じ記事・駐車場・閉じた場所・隣の県は並べない", () => {
  const ok = (id, extra) => spot(id, { description: `場所${id}は、谷あいの静かな寺。`, ...extra });
  const { major, hidden } = pickPrefSpots([
    spot("a", { name: "高徳院", fame_tier: "major", fame_score: 90 }),
    ok("b", { name: "鎌倉大仏 高徳院", description: "鎌倉大仏 高徳院は、露座の大仏で知られる寺。" }),
    ok("c", { name: "八戸鉱山", description: "露天掘りの鉱山。今も石灰石を掘っています。" }),
    ok("d", { name: "住金鉱業", description: "露天掘りの鉱山。今も石灰石を掘っています。" }),
    ok("e", { name: "智恩寺 駐車場" }),
    ok("f", { name: "さるふつ温泉", description: "さるふつ温泉は、北海道宗谷郡猿払村にあった温泉。" }),
    ok("g", { name: "くずはモール", description: "くずはモールは、大阪府枚方市にある大きな商業施設。駅に近い。" }),
    ok("h"),
  ], "神奈川県");
  assert.deepEqual(major.map((s) => s.id), ["a"]);
  // 同じ記事を持つ c と d は、どちらか1つだけ。
  const ids = hidden.map((s) => s.id).sort();
  assert.equal(ids.length, 2);
  assert.ok(ids.includes("h") && (ids.includes("c") || ids.includes("d")), ids.join(","));
});

test("穴場: 同じ分類は3つまで", () => {
  const list = ["a", "b", "c", "d", "e"].map((id) =>
    spot(id, { category: "スキー場", description: `場所${id}は、雪の多い山の斜面。` }));
  list.push(spot("f", { category: "温泉", description: "場所fは、川沿いの湯。" }));
  const { hidden } = pickPrefSpots(list, "神奈川県");
  assert.equal(hidden.filter((s) => s.category === "スキー場").length, 3);
  assert.ok(hidden.some((s) => s.id === "f"));
});

test("穴場: 名前の順ではなく、説明から見どころが読み取れる順", () => {
  // 以前は有名さの点の無いものが あいうえお順 で並び、長野県の穴場が
  // スキー場・温水プール・中央道のトンネル・山塊になっていました。
  const wiki = (id, name, category, description) =>
    spot(id, { name, category, description, fame_score: undefined });
  const { hidden } = pickPrefSpots([
    wiki("a", "あの横穴墓群", "史跡", "あの横穴墓群は、横浜市栄区にある古代横穴墓群遺跡。"),
    wiki("b", "いの川", "川", "いの川は、相模原市を流れる相模川水系の一級河川。"),
    wiki("c", "うの山地", "山", "うの山地は、県の北部に広がる山地である。"),
    wiki("d", "えのスキー場", "スキー場", "えのスキー場は、山ノ内町にあるスキー場。2010年に改名された。"),
    wiki("e", "おの花火大会", "観光名所", "おの花火大会は、毎年夏に開かれる花火大会。"),
    wiki("f", "OSC", "観光名所", "OSCは、平塚市にある複合商業施設・ショッピングセンター。"),
    wiki("y", "八島ヶ原湿原", "観光名所", "八島ヶ原湿原は、霧ヶ峰の北西にある標高約1632mの高層湿原。夏は花が咲き、木道を散策できる。"),
    wiki("z", "御射鹿池", "観光名所", "御射鹿池は、茅野市にあるため池。水面に森が映る景観で知られる。"),
  ], "長野県");
  assert.deepEqual(hidden.map((s) => s.id), ["y", "z"]);
});

test("穴場: 見どころの語が無くても、悪い語も無いものは6件まで足す", () => {
  const list = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) =>
    spot(id, { category: id < "e" ? "寺院" : "神社", fame_score: undefined,
      description: `場所${id}は、谷あいにある寺。${"本堂は江戸時代の建物。".repeat(id.charCodeAt(0) % 3)}` }));
  const { hidden } = pickPrefSpots(list, "神奈川県");
  assert.equal(hidden.length, 6);
  // 説明の長いものから。
  assert.ok(hidden.slice(0, 2).every((s) => s.description.length >= hidden.at(-1).description.length));
});

test("分類の記号は、読み上げない線の SVG", () => {
  const svg = spotIcon({ category: "温泉" });
  assert.match(svg, /^<svg class="sp-ic"[^>]*aria-hidden="true"/);
  assert.match(svg, /<path d="[^"]+"\/><\/svg>$/);
  assert.notEqual(svg, spotIcon({ category: "神社" }));
});

test("紹介できるのは、説明と駅を持つエリアだけ", () => {
  const got = curatedRegions([REGION, { id: "n0054", name: "村", prefecture: "新潟県" }]);
  assert.deepEqual(got.map((r) => r.id), ["hakone"]);
});

test("モデルコース: そのエリアの旅程で、必ず入れた場所が残っていれば出す", () => {
  assert.equal(courseFits(itinOf(["a", "b", "c"]), REGION, ["a", "b", "c"]), true);
  assert.equal(courseFits(itinOf(["a", "b", "x"]), REGION, ["a", "b", "c"]), true);
});

test("モデルコース: 必ず入れた場所が2か所以上抜けたら出さない", () => {
  assert.equal(courseFits(itinOf(["a", "x", "y"]), REGION, ["a", "b", "c"]), false);
});

test("モデルコース: よそのエリアへ行った旅程は出さない", () => {
  assert.equal(courseFits(itinOf(["a", "b"], "n0235"), REGION, ["a", "b"]), false);
  const leak = itinOf(["a", "b", "z"], "hakone", (id) => (id === "z" ? "n0009" : "hakone"));
  assert.equal(courseFits(leak, REGION, ["a", "b"]), false);
  assert.equal(courseFits(null, REGION, []), false);
});

test("モデルコースの行は、時刻・名前・分で並ぶ", () => {
  const got = courseItems(itinOf(["a"]));
  assert.deepEqual(got.map((x) => [x.kind, x.time, x.minutes]),
    [["move", "9:00", 20], ["spot", "9:20", 40], ["end", "10:00", 0]]);
  assert.equal(got[1].text, "説明a");
  assert.equal(got[2].title, "解散");
  assert.equal(courseItems({ days: [] }), null);
});

test("モデルコースの最後は、着く駅と時刻で終わる", () => {
  const itin = itinOf(["a"]);
  itin.days[0].items.push({ kind: "transit", title: "移動", to: { name: "箱根湯本駅" },
    start: new Date(2026, 9, 17, 10), end: new Date(2026, 9, 17, 10, 25) });
  const got = courseItems(itin);
  assert.deepEqual(got.at(-1), { kind: "end", time: "10:25", minutes: 0, title: "箱根湯本駅着・解散" });
});

test("モデルコースをアプリで開くリンクに、寄る場所とエリアが入る", () => {
  assert.deepEqual(courseSpotIds(itinOf(["a", "b", "a"])), ["a", "b"]);
  const url = courseLink("../../", "箱根を1日でめぐる", "hakone", ["a", "b"]);
  assert.match(url, /^\.\.\/\.\.\/app\?/);
  const q = new URLSearchParams(url.split("?")[1]);
  assert.equal(q.get("q"), "箱根を1日でめぐる");
  assert.equal(q.get("pin"), "a,b");
  assert.equal(q.get("area"), "hakone");
  assert.equal(courseLink("", "x", "hakone", []), "app?q=x");
});

test("全ページ: 一覧・県・エリアができ、名前は逃がしてある", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [
      spot("a", { name: `<script>alert(1)</script>`, fame_tier: "major", fame_score: 80 }),
      spot("b", { description: "静かな寺", fame_score: 30 }),
    ]]]),
  };
  const planCourse = async () => itinOf(["a"]);
  const { pages, sitemap } = await buildAll(kbDoc,
    { base: BASE, now: new Date(2026, 9, 9), planCourse });
  assert.deepEqual(pages.map((p) => p.path),
    ["areas/index.html", "areas/kanagawa/index.html", "areas/kanagawa/hakone.html"]);
  for (const p of pages) {
    assert.ok(!p.html.includes("<script>alert"), `${p.path} に生の名前が入っています`);
    assert.match(p.html, /<link rel="canonical" href="https:\/\/example\.test\/app\/areas\//);
    // 画面の中で動くものは置きません（読み物のページです）。
    assert.match(p.html, /script-src 'none'/);
  }
  const region = pages[2].html;
  assert.match(region, /1日のモデルコース/);
  assert.match(region, /10月10日（土）/);
  assert.match(region, /app\?q=/);
  // JSON-LD の中でも、< は逃がしてあること。
  assert.ok(!/<\/script>alert/.test(region));
  assert.match(sitemap, /<loc>https:\/\/example\.test\/app\/<\/loc>/);
  assert.match(sitemap, /areas\/kanagawa\/hakone\.html/);
  assert.match(sitemap, /sitemaps\.org/);
});

test("モデルコースが組めなかったエリアも、観光地の一覧のページは出る", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a")]]]),
  };
  const { pages } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null });
  const region = pages.find((p) => p.path.endsWith("hakone.html")).html;
  assert.ok(!region.includes('class="course"'));
  assert.match(region, /箱根の観光地/);
});

test("sitemap: 日の分からないページだけ、作った日になる", () => {
  const xml = sitemapXml(BASE, [`${BASE}areas/index.html`], new Date("2026-10-09T00:00:00Z"));
  assert.match(xml, /<lastmod>2026-10-09<\/lastmod>/);
});

test("sitemap: lastmod はページごとの更新日（全部が作った日にならない）", () => {
  const xml = sitemapXml(BASE, [
    { url: `${BASE}areas/kanagawa/index.html`, lastmod: "2026-10-03" },
    { url: `${BASE}areas/nagano/index.html`, lastmod: "2026-10-11" },
  ], new Date("2026-10-14T00:00:00Z"), { rootLastmod: "2026-10-12" });
  const rows = [...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [
    [BASE, "2026-10-12"],
    [`${BASE}areas/kanagawa/index.html`, "2026-10-03"],
    [`${BASE}areas/nagano/index.html`, "2026-10-11"],
  ]);
  assert.ok(!xml.includes("2026-10-14"));
});

test("sitemap: 県とエリアはその県の収録の日、一覧はいちばん新しい日", async () => {
  const kbDoc = {
    index: { shards: [
      { file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" },
      { file: "spots-jp20-nagano.json", prefecture: "長野県" },
    ] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a")]], ["spots-jp20-nagano.json", []]]),
  };
  const updated = new Map([
    ["spots-jp14-kanagawa.json", "2026-10-03"],
    ["spots-jp20-nagano.json", "2026-10-11"],
    ["regions.json", "2026-10-05"],
  ]);
  const { pages, sitemap } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null,
    updated, siteUpdated: "2026-10-12", now: new Date("2026-10-14T00:00:00Z") });
  const day = (path) => new RegExp(`<loc>${BASE}${path}</loc>\\s*<lastmod>([^<]+)`).exec(sitemap)?.[1];
  assert.equal(day("areas/kanagawa/index.html"), "2026-10-03");
  assert.equal(day("areas/kanagawa/hakone.html"), "2026-10-03");
  assert.equal(day("areas/nagano/index.html"), "2026-10-11");
  assert.equal(day("areas/index.html"), "2026-10-11");
  assert.equal(day(""), "2026-10-12");
  assert.ok(!sitemap.includes("2026-10-14"));
  assert.equal(pages.find((p) => p.path === "areas/kanagawa/hakone.html").lastmod, "2026-10-03");
});

test("いちばん新しい日を選ぶ（日でないものは無視）", () => {
  assert.equal(latestDay(["2026-10-03", "2026-10-11", "2026-09-30"]), "2026-10-11");
  assert.equal(latestDay([null, "", "x"]), null);
});

test("エリアの観光地には、中心から遠いもの（同じ市町村の別の街）を並べない", () => {
  const region = { id: "enoshima", lat: 35.2996, lng: 139.4803 };
  const near = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, lat: 35.30 + i * 0.001, lng: 139.48 }));
  const far = { id: "atsugi", lat: 35.4475, lng: 139.3616 }; // 約20km
  const ids = nearbySpots(region, [...near, far]).map((s) => s.id);
  assert.equal(ids.length, 8);
  assert.ok(!ids.includes("atsugi"));
});

test("近くに少ししか無いエリアは、近い順に並べる（空のページにしない）", () => {
  const region = { id: "x", lat: 35, lng: 139 };
  const spots = [
    { id: "far", lat: 35.2, lng: 139 },
    { id: "mid", lat: 35.1, lng: 139 },
    { id: "near", lat: 35.01, lng: 139 },
  ];
  assert.deepEqual(nearbySpots(region, spots).map((s) => s.id), ["near", "mid", "far"]);
  assert.equal(nearbySpots({ id: "nogeo" }, spots).length, 3);
});

test("パンくずの構造化データは、順番と URL を持つ", () => {
  const ld = breadcrumbLd([{ name: "エリア", url: `${BASE}areas/index.html` }, { name: "箱根" }]);
  assert.equal(ld["@type"], "BreadcrumbList");
  assert.deepEqual(ld.itemListElement.map((x) => x.position), [1, 2]);
  assert.equal(ld.itemListElement[0].item, `${BASE}areas/index.html`);
  assert.equal(ld.itemListElement[1].item, undefined);
});

test("県とエリアのページは、トップ › エリア › 県 › エリアで行き来できる", async () => {
  const ENOSHIMA = { ...REGION, id: "enoshima", name: "江の島", tagline: "海と灯台" };
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION, ENOSHIMA],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a")]]]),
  };
  const { pages } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null });
  const html = (path) => pages.find((p) => p.path === path).html;
  const pref = html("areas/kanagawa/index.html");
  assert.match(pref, /href="hakone\.html"/);
  assert.match(pref, /href="enoshima\.html"/);
  const hakone = html("areas/kanagawa/hakone.html");
  // パンくずの頭はサイトのトップ（/。構造化データのパンくずと同じ）。県のページへも戻れる。
  assert.match(hakone, /class="crumbs"[^>]*><a href="\.\.\/\.\.\/">旅さき<\/a>/);
  assert.match(hakone, /class="brand" href="\.\.\/\.\.\/"/);
  assert.match(hakone, /href="\.\.\/\.\.\/areas\/kanagawa\/index\.html"/);
  // 同じ県のほかのエリアへ。自分自身は並べない。
  assert.match(hakone, /同じ県のほかのエリア[\s\S]*href="enoshima\.html"/);
  assert.ok(!/同じ県のほかのエリア[\s\S]*href="hakone\.html"/.test(hakone));
  // 構造化データのパンくずも、トップから始まる。
  const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(hakone)[1]);
  const crumbs = ld["@graph"].find((x) => x["@type"] === "BreadcrumbList").itemListElement;
  assert.deepEqual(crumbs.map((c) => c.name), ["旅さき", "エリア", "神奈川県", "箱根"]);
  assert.equal(crumbs[0].item, BASE);
});

test("共有カード: エリアごとの題と説明を持つ", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a")]]]),
  };
  const { pages } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null });
  const hakone = pages.find((p) => p.path.endsWith("hakone.html")).html;
  // コースが組めなかったページは、題で「モデルコース」を約束しません。
  assert.match(hakone, /<meta property="og:title" content="箱根の観光地と1日の旅行プラン/);
  assert.doesNotMatch(hakone, /<title>[^<]*モデルコース/);
  assert.match(hakone, /<meta property="og:description" content="箱根（神奈川県）/);
  assert.match(hakone, /<meta name="twitter:title" content="箱根の/);
  // 共有の絵はエリアごと（箱根を貼っても金沢を貼っても同じ絵、にしない）。
  assert.match(hakone, /<meta property="og:image" content="https:\/\/example\.test\/app\/areas\/kanagawa\/hakone\.png"/);
  assert.match(hakone, /<meta property="og:image:alt" content="箱根（神奈川県）の場所を示す地図"/);
  const pref = pages.find((p) => p.path === "areas/kanagawa/index.html").html;
  assert.match(pref, /<meta property="og:image" content="https:\/\/example\.test\/app\/areas\/kanagawa\/index\.png"/);
  // 一覧は全国のページなので、いつもの絵のまま。
  const index = pages.find((p) => p.path === "areas/index.html").html;
  assert.match(index, /<meta property="og:image" content="https:\/\/example\.test\/app\/og\.png"/);
  // 絵を描く元（どの県の、どのエリアか）をページが持つ。
  const page = pages.find((p) => p.path === "areas/kanagawa/hakone.html");
  assert.equal(page.image, "areas/kanagawa/hakone.png");
  assert.equal(page.card.shard, "spots-jp14-kanagawa.json");
  assert.equal(page.card.region.id, "hakone");
});

function readPng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const chunks = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i);
    chunks.push({ type: buf.toString("ascii", i + 4, i + 8), data: buf.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
  return { w: ihdr.readUInt32BE(0), h: ihdr.readUInt32BE(4), chunks, raw: inflateSync(idat) };
}

test("共有カード: 1200×630 の PNG で、エリアの印が描かれる", () => {
  const all = [];
  for (let i = 0; i < 400; i++) all.push({ id: `x${i}`, lat: 33 + (i % 20) * 0.5, lng: 131 + Math.floor(i / 20) * 0.6 });
  const pref = Array.from({ length: 40 }, (_, i) => ({ id: `k${i}`, lat: 35.2 + (i % 8) * 0.06, lng: 139.0 + Math.floor(i / 8) * 0.1, regionId: i < 5 ? "hakone" : "x" }));
  const png = renderAreaCard({ all: [...all, ...pref], pref, region: REGION,
                               regionSpots: pref.filter((s) => s.regionId === "hakone") });
  const { w, h, chunks, raw } = readPng(png);
  assert.equal(w, CARD_W);
  assert.equal(h, CARD_H);
  assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "PLTE", "IDAT", "IEND"]);
  assert.equal(raw.length, (w + 1) * h);
  // 下地だけの絵ではない（点と輪が描かれている）。色番号 5 は輪の色。
  assert.ok(raw.includes(5));
  assert.ok(raw.includes(4));
  // 小さく保つ（95枚を公開するので）。
  assert.ok(png.length < 80_000, `${png.length} bytes`);
});

test("共有カード: 離島の外れ値で県の地図が小さくならない", () => {
  const main = Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, lat: 35.6 + (i % 10) * 0.01, lng: 139.5 + Math.floor(i / 10) * 0.03 }));
  const islands = [{ id: "o1", lat: 27.1, lng: 142.2 }, { id: "o2", lat: 27.0, lng: 142.1 }];
  const b = boundsOf([...main, ...islands]);
  assert.ok(b.minLat > 35, JSON.stringify(b));
  assert.equal(boundsOf([]), null);
});

test("404.html: どの深さで出ても、どちらのホストでも崩れない根からのリンクで、検索には載せない", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a")]]]),
  };
  const { pages, notFound, sitemap } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null });
  assert.equal(notFound.path, "404.html");
  assert.ok(!pages.includes(notFound));
  assert.ok(!sitemap.includes("404"));
  const html = notFound.html;
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.ok(!html.includes('rel="canonical"'));
  // 公開URLを丸ごと書くと、PHP 版（別のホスト）では CSP でスタイルが止まります。
  assert.match(html, /href="\/css\/area\.css"/);
  assert.match(html, /href="\/app"/);
  assert.match(html, /href="\/areas\/kanagawa\/index\.html"/);
  assert.ok(!/(href|src)="(?!\/|https:)/.test(html), "相対リンクが残っています");
  assert.ok(!/(href|src)="https:\/\/example/.test(html), "公開URLのリンクが残っています");
  // OGP の絵だけは、よそから読まれるので絶対URLです。
  assert.match(html, /og:image" content="https:\/\/example\.test\/app\/og\.png"/);
  assert.match(html, /script-src 'none'/);
});

test("説明文: エリアはコースで寄る有名な場所、県は定番の名前を入れて、ページごとに違う文にする", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [
      spot("a", { name: "大涌谷", fame_tier: "major", fame_score: 80 }),
      spot("b", { name: "駅前の店", fame_tier: "known", fame_score: 20 }),
    ]]]),
  };
  const itin = itinOf(["b", "a"]);
  // 寄る順は b → a。説明文は有名な順に a を先に書く。
  itin.days[0].items.find((i) => i.spotId === "a").place.fame_score = 80;
  itin.days[0].items.find((i) => i.spotId === "b").place.fame_score = 20;
  itin.days[0].items.find((i) => i.spotId === "a").title = "大涌谷";
  itin.days[0].items.find((i) => i.spotId === "b").title = "駅前の店";
  const { pages } = await buildAll(kbDoc, { base: BASE, planCourse: async () => itin });
  const hakone = pages.find((p) => p.path.endsWith("hakone.html")).html;
  assert.match(hakone, /<meta name="description" content="箱根（神奈川県）を箱根湯本駅から1日で、大涌谷・駅前の店とまわる/);
  const pref = pages.find((p) => p.path === "areas/kanagawa/index.html").html;
  assert.match(pref, /<meta name="description" content="神奈川県の観光地。大涌谷・駅前の店などの定番と/);
  assert.match(pref, /<h2>神奈川県の定番・主な観光地<\/h2>/);

  // コースが無いエリアは、観光地の名前で書く。
  const { pages: noCourse } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null });
  assert.match(noCourse.find((p) => p.path.endsWith("hakone.html")).html,
    /<meta name="description" content="箱根（神奈川県）の観光地（大涌谷・駅前の店など）/);
});

test("名前の並びは重なりを除いて先頭から", () => {
  assert.equal(nameList(["a", "b", "a", "", "c", "d"]), "a・b・c");
  assert.equal(nameList([]), "");
});

test("県の定番の欄は、本当に定番（major）を先に並べる", () => {
  const { major } = pickPrefSpots([
    spot("k", { name: "島", fame_tier: "known", fame_score: 90, category: "島" }),
    spot("m", { name: "遺跡", fame_tier: "major", fame_score: 60, category: "史跡" }),
  ], "神奈川県");
  assert.deepEqual(major.map((s) => s.name), ["遺跡", "島"]);
});

test("エリアの一覧は地方ごとの見出しで区切る（知らない名前も落とさない）", async () => {
  const groups = groupByChiho([
    { name: "沖縄県" }, { name: "北海道" }, { name: "東京都" }, { name: "どこか" },
  ]);
  assert.deepEqual(groups.map((g) => [g.chiho, g.list.map((p) => p.name)]), [
    ["北海道・東北", ["北海道"]], ["関東", ["東京都"]], ["九州・沖縄", ["沖縄県"]], ["その他", ["どこか"]],
  ]);
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a")]]]),
  };
  const { pages } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null });
  const index = pages.find((p) => p.path === "areas/index.html").html;
  assert.match(index, /<h2>関東<\/h2>\n<ul class="prefs">\n  <li><a href="kanagawa\/index\.html">/);
});

test("モデルコースには、エリアの中心から遠い場所（鎌倉に横須賀の三笠）を入れない", () => {
  const kamakura = { lat: 35.3192, lng: 139.5467 };
  assert.equal(isFar(kamakura, { lat: 35.2848, lng: 139.6743 }), true); // 記念艦三笠 約12km
  assert.equal(isFar(kamakura, { lat: 35.3167, lng: 139.5357 }), false); // 長谷寺
  assert.equal(isFar(kamakura, { name: "座標なし" }), false);
});

test("町歩きのエリアは、名所のかたまり具合で寄る範囲を狭める（松本の四賀化石館）", () => {
  const matsumoto = { lat: 36.2384, lng: 137.969, genres: ["history", "nature", "view", "city"] };
  const own = [
    { name: "松本城", lat: 36.2384, lng: 137.969, fame_score: 90 },
    { name: "旧開智学校", lat: 36.242, lng: 137.967, fame_score: 70 },
    { name: "冠着山", lat: 36.3, lng: 138.04, fame_score: 60 },          // 約9.6km、山の上
    { name: "四賀化石館", lat: 36.317853, lng: 137.998342, fame_score: 10 },
  ];
  const r = courseRadiusKm(matsumoto, own);
  assert.equal(r, 3, "城と旧開智学校がすぐ近くなので、最小の3kmになる");
  assert.equal(isFar(matsumoto, own[3], r), true, "9km 先の化石館は外れる");
  assert.equal(isFar(matsumoto, own[1], r), false);
  // 町歩きでないエリア（山・温泉）は、これまでどおりの10km。
  assert.equal(courseRadiusKm({ ...matsumoto, genres: ["onsen", "nature"] }, own), 10);
  // 名所が3つ無いときは、狭めない。
  assert.equal(courseRadiusKm(matsumoto, own.slice(0, 2)), 10);
});

test("コースがあるページだけ、題に「モデルコース」と書く", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a"), spot("b"), spot("c")]]]),
  };
  const { pages } = await buildAll(kbDoc, { base: BASE,
    planCourse: async () => itinOf(["a", "b", "c"]) });
  const hakone = pages.find((p) => p.path.endsWith("hakone.html")).html;
  assert.match(hakone, /<title>箱根の1日モデルコースと観光地/);
});

test("説明は、かっこの中の句点では切らない", () => {
  assert.deepEqual(sentencesOf("A（「あ」と読む。）はB。C。"), ["A（「あ」と読む。）はB。", "C。"]);
  // 閉じないまま終わる文は、文として返しません。
  assert.deepEqual(sentencesOf("A。B（「い」と読む。"), ["A。"]);
  const d = readableDescription({ name: "千畳閣",
    description: "千畳閣は、厳島にある神社建築であり、豊国神社（「とよくにじんじゃ」と読む。）の本殿である。豊臣秀吉が建てた。" });
  assert.equal((d.match(/（/g) ?? []).length, (d.match(/）/g) ?? []).length);
});

// 「松本・上高地」で1つのエリアにしていたころ、上高地（河童橋）は松本駅から
// 30km 先で、モデルコースにも一覧にも出ないのに、題名と紹介文だけが
// 上高地を約束していました。上高地は別のエリアです。
test("上高地は自分のエリアを持ち、河童橋がそのコース圏内にある", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = async (p) => JSON.parse(await readFile(new URL(`../kb/${p}`, import.meta.url), "utf8"));
  const regions = curatedRegions((await read("regions.json")).regions);
  const byId = new Map(regions.map((r) => [r.id, r]));
  const kamikochi = byId.get("kamikochi");
  assert.ok(kamikochi, "上高地のエリアがない");
  assert.equal(kamikochi.prefecture, "長野県");
  assert.ok(!/上高地/.test(byId.get("matsumoto").name + byId.get("matsumoto").description),
    "松本のエリアが上高地を約束している");
  const { spots } = await read("spots-jp20-nagano.json");
  const kappa = spots.find((s) => s.name === "河童橋" && s.regionId === "kamikochi");
  assert.ok(kappa, "河童橋が上高地のエリアにない");
  assert.equal(isFar(kamikochi, kappa), false);
  assert.ok(nearbySpots(kamikochi, spots.filter((s) => s.regionId === "kamikochi"))
    .some((s) => s.id === kappa.id));
});

test("紹介ページ: 組めたコースを例に載せ、エリアへつなぎ、sitemap に入る", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [
      spot("a", { name: "大涌谷", fame_tier: "major", fame_score: 80 }),
    ]]]),
  };
  const { pages, intro, sitemap } = await buildAll(kbDoc,
    { base: BASE, now: new Date(2026, 9, 9), planCourse: async () => itinOf(["a"]),
      siteUpdated: "2026-10-20" });
  assert.equal(intro.path, "about.html");
  assert.ok(!pages.includes(intro));
  const html = intro.html;
  assert.match(html, /<link rel="canonical" href="https:\/\/example\.test\/app\/about\.html">/);
  assert.match(html, /実際に組んだ例: 箱根の1日/);
  assert.match(html, /class="course"/);
  assert.match(html, /href="areas\/kanagawa\/hakone\.html"/);
  assert.match(html, /href="app"/);
  assert.match(html, /script-src 'none'/);
  assert.match(sitemap, /<loc>https:\/\/example\.test\/app\/about\.html<\/loc>\s*<lastmod>2026-10-20<\/lastmod>\s*<priority>0\.8/);
  // どのページの下にも、紹介ページへのリンクがあること。
  for (const p of pages) assert.match(p.html, /about\.html">旅さきとは</);
});

test("紹介ページ: コースが1つも組めなくても、例の欄を出さずに作れる", async () => {
  const kbDoc = {
    index: { shards: [{ file: "spots-jp14-kanagawa.json", prefecture: "神奈川県" }] },
    regions: [REGION],
    shards: new Map([["spots-jp14-kanagawa.json", [spot("a")]]]),
  };
  const { intro } = await buildAll(kbDoc, { base: BASE, planCourse: async () => null });
  assert.ok(!intro.html.includes('class="course"'));
  assert.ok(!intro.html.includes("実際に組んだ例"));
  assert.match(intro.html, /旅さきで旅程をつくる/);
});

test("pickFeatured: 名の知れたエリアを先に、8件まで", () => {
  const f = (id) => ({ region: { id } });
  const got = pickFeatured([f("zzz"), f("kamakura"), f("hakone"), ...Array.from({ length: 10 }, (_, i) => f(`x${i}`))]);
  assert.deepEqual(got.slice(0, 2).map((x) => x.region.id), ["hakone", "kamakura"]);
  assert.equal(got.length, 8);
});
