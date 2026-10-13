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
  appLink, breadcrumbLd, buildAll, courseFits, courseItems, courseLink, courseSpotIds, curatedRegions, esc,
  examplePrompts, groupByChiho, isFar, nameList, nearbySpots, nextSaturday, pickPrefSpots,
  readableDescription, sentencesOf, shardSlug, sitemapXml, spotIcon,
} from "../tools/build_area_pages.mjs";

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
    "../../index.html?q=%E7%AE%B1%E6%A0%B9%E3%81%A7%E6%B8%A9%E6%B3%89%20%26%20%E7%BE%8E%E8%A1%93%E9%A4%A8");
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
  assert.match(url, /^\.\.\/\.\.\/index\.html\?/);
  const q = new URLSearchParams(url.split("?")[1]);
  assert.equal(q.get("q"), "箱根を1日でめぐる");
  assert.equal(q.get("pin"), "a,b");
  assert.equal(q.get("area"), "hakone");
  assert.equal(courseLink("", "x", "hakone", []), "index.html?q=x");
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
  assert.match(region, /index\.html\?q=/);
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

test("sitemap は日付つき", () => {
  const xml = sitemapXml(BASE, [`${BASE}areas/index.html`], new Date("2026-10-09T00:00:00Z"));
  assert.match(xml, /<lastmod>2026-10-09<\/lastmod>/);
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
  // パンくずの頭はアプリのトップ。県のページへも戻れる。
  assert.match(hakone, /class="crumbs"[^>]*><a href="\.\.\/\.\.\/index\.html">旅さき<\/a>/);
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
  assert.match(hakone, /<meta property="og:image" content="https:\/\/example\.test\/app\/og\.png"/);
});

test("404.html: どの深さで出ても崩れない絶対URLで、検索には載せない", async () => {
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
  assert.match(html, /href="https:\/\/example\.test\/app\/css\/area\.css"/);
  assert.match(html, /href="https:\/\/example\.test\/app\/index\.html"/);
  assert.match(html, /href="https:\/\/example\.test\/app\/areas\/kanagawa\/index\.html"/);
  // 相対パス（../ や css/ で始まるもの）が残っていないこと。
  assert.ok(!/(href|src)="(?!https:)/.test(html), "相対リンクが残っています");
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
