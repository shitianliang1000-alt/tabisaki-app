// データの出どころを項目ごとに追えること、出典が出力に自動で付くこと（Issue #426）。
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SOURCES, SPLIT_SCHEMA, SUMMARY_SCHEMA, attributionText, auditSpots, isSplit, itineraryLicenseSummary,
  joinSources, licenseSummary, provenanceOf, sourcesOf, splitBySource, spotsOfItinerary,
} from "../packages/core/src/provenance.js";
import { allSpots, splitShard } from "../tools/kb_provenance.mjs";
import { createCore, toIcs, toJson, toMarkdown, toPlainText } from "../packages/core/index.mjs";
import { formatSpots, parseSpots } from "../packages/core/spotio.mjs";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KB = allSpots();

// --- 決まり ---------------------------------------------------------------------------

test("取り込みの印ごとに、名前・座標・説明の出どころが決まる", () => {
  const base = { id: "x", regionId: "r", category: "寺", fame_tier: "hidden", lat: 35, lng: 135, name: "あ寺", description: "あ寺（あでら）は、寺である。" };
  const of = (extra) => provenanceOf({ ...base, ...extra });

  const own = of({});
  assert.equal(own.name, "tabisaki_original");
  assert.equal(own.description, "tabisaki_original");

  const wd = of({ src: "wikidata", url: "https://example.jp/", tel: "000" });
  assert.deepEqual([wd.name, wd.lat, wd.lng, wd.url, wd.tel, wd.description], ["wikidata", "wikidata", "wikidata", "wikidata", "wikidata", "wikipedia"]);
  assert.equal(wd.category, "tabisaki_original");

  const osm = of({ src: "osm-tourlist", osm: "way/1", osmInfo: { ref: "way/1", phone: "000" }, listedIn: "京都府" });
  assert.deepEqual([osm.name, osm.lat, osm.osm, osm.osmInfo, osm.listedIn], ["tourlist", "osm", "osm", "osm", "tourlist"]);

  const ov = of({ src: "overture-tourlist", overture: "k", license: "Apache-2.0" });
  assert.deepEqual([ov.lat, ov.overture, ov.license], ["overture", "overture", "overture"]);

  assert.equal(of({ src: "tourlist-geocoded", geo: "Yahooローカルサーチ" }).lat, "yahoo");
  assert.equal(of({ src: "tourlist-geocoded", geo: "Yahooコンテンツジオコーダ" }).geo, "yahoo");
  assert.equal(of({ src: "tourlist-geocoded", geo: "国土地理院" }).lng, "gsi");
  assert.equal(of({ src: "tourlist-geocoded", geo: "Photon" }).lat, "osm");
  assert.equal(of({ src: "tourlist-geocoded", geo: "Nominatim" }).lat, "osm");
  assert.equal(of({ src: "tourlist-geocoded", geo: "Wikipedia" }).lat, "wikipedia");

  assert.equal(of({ src: "opendata", category: "ダム" }).name, "mlit_river");
  assert.equal(of({ src: "opendata", category: "灯台" }).name, "wikipedia");
  assert.equal(of({ src: "opendata", category: "灯台" }).description, "tabisaki_original");

  // 自分で足した場所は、ぜんぶ自分のものです。
  assert.deepEqual(new Set(Object.values(provenanceOf({ ...base, id: "u:1", wikipedia: "別の題" }))), new Set(["user"]));
});

test("記事の題は、名前の写しならウィキペディア由来に数えない", () => {
  const s = { id: "gc-1", name: "市場", src: "tourlist-geocoded", geo: "Yahooローカルサーチ", lat: 1, lng: 2 };
  assert.ok(!sourcesOf({ ...s, wikipedia: "市場" }).includes("wikipedia"));
  assert.ok(sourcesOf({ ...s, wikipedia: "中央市場" }).includes("wikipedia"));
});

test("知らない印は unknown になり、点検で見つかる", () => {
  const odd = [{ id: "z1", name: "どこか", lat: 1, lng: 2, src: "somewhere-new" },
    { id: "z2", name: "どこか", lat: 1, lng: 2, src: "tourlist-geocoded", geo: "知らない検索" },
    { id: "z3", name: "どこか", lat: 1, lng: 2, src: "overture-tourlist", overture: "k" }];
  assert.equal(provenanceOf(odd[0]).name, "unknown");
  assert.equal(provenanceOf(odd[1]).lat, "unknown");
  const audit = auditSpots(odd);
  assert.equal(audit.problems.length, 3);
  assert.equal(licenseSummary(odd).complete, false);
  assert.equal(licenseSummary([{ id: "a", name: "あ", lat: 1, lng: 2 }]).complete, true);
});

// --- 収録ぜんたい -------------------------------------------------------------------

test("収録の全件で、どの項目も出どころを追える", () => {
  assert.ok(KB.length > 40000, `収録が少なすぎます: ${KB.length}`);
  const audit = auditSpots(KB);
  assert.deepEqual(audit.problems, []);
  for (const id of Object.keys(audit.bySource)) assert.ok(SOURCES[id], `台帳に無い出どころ: ${id}`);
  assert.ok(!("unknown" in audit.bySource));
  // Issue に名前のある3つは、どれも実際に使われています。
  for (const id of ["wikipedia", "osm", "tabisaki_original"]) assert.ok(audit.bySource[id] > 0, id);
});

test("収録の全件を、出どころごとに分けて、元に戻せる", () => {
  for (const spot of KB) {
    const parts = splitBySource(spot, { summary: false });
    assert.equal(parts.schema, SPLIT_SCHEMA);
    // 1つの項目は、1つの出どころにだけ入ります。
    const seen = new Set();
    for (const [src, part] of Object.entries(parts)) {
      if (src === "schema" || src === "id") continue;
      assert.ok(SOURCES[src], `${spot.id}: 知らない出どころ ${src}`);
      for (const k of Object.keys(part)) { assert.ok(!seen.has(k), `${spot.id}: ${k} が2か所にあります`); seen.add(k); }
    }
    assert.deepStrictEqual(joinSources(parts), spot);
  }
});

test("分けた形には、その1件のライセンスのまとめが付く", () => {
  const spot = KB.find((s) => s.src === "osm-tourlist" && s.osmInfo && s.description);
  const parts = splitBySource(spot);
  assert.ok(isSplit(parts));
  assert.equal(parts.osm.osm, spot.osm);
  assert.deepEqual(parts.osm.osmInfo, spot.osmInfo);
  assert.equal(parts.wikipedia.description, spot.description);
  assert.equal(parts.tabisaki_original.category, spot.category);
  const sum = parts.license_summary;
  assert.equal(sum.schema, SUMMARY_SCHEMA);
  assert.deepEqual(sum.shareAlike, ["wikipedia", "osm"]);
  assert.ok(sum.licenses.includes("ODbL 1.0") && sum.licenses.includes("CC BY-SA 4.0"));
  assert.ok(sum.attribution.includes("© OpenStreetMap contributors（ODbL）"));
  assert.deepEqual(joinSources(parts), spot); // まとめが付いていても戻せます
  assert.equal(joinSources(spot), spot);      // 分けていない1件は、そのまま
  assert.throws(() => joinSources({ schema: SPLIT_SCHEMA, id: "a", osm: { lat: 1 }, wikipedia: { lat: 2 } }), /2つの出どころ/);
});

test("Overture は、1件ごとのライセンスをまとめに出す", () => {
  const ov = KB.filter((s) => s.overture);
  const sum = licenseSummary(ov);
  const row = sum.sources.find((s) => s.id === "overture");
  assert.equal(row.spots, ov.length);
  for (const lic of new Set(ov.map((s) => s.license))) assert.ok(row.license.includes(lic), lic);
});

test("収録が使う出どころは、どれも著作権表記のページに書いてある", () => {
  const html = readFileSync(path.join(ROOT, "credits.html"), "utf8");
  // 表記の義務があるものだけです（credits.html は、求められているものだけを書いています）。
  const need = {
    wikipedia: /Wikipedia/, osm: /OpenStreetMap contributors/, yahoo: /Web Services by Yahoo! JAPAN/,
    overture: /Overture Maps Foundation/, gsi: /国土地理院/, mlit_river: /川の防災情報/,
  };
  const used = licenseSummary(KB).sources.filter((s) => s.attributionRequired).map((s) => s.id);
  assert.ok(used.length >= 5);
  for (const id of used) {
    assert.ok(need[id], `${id} の確かめかたが、この試験にありません`);
    assert.match(html, need[id], `credits.html に ${id} の表記がありません`);
  }
});

// --- 出力 -----------------------------------------------------------------------------

const core = await createCore();
const result = await core.plan({ wish: "温泉と城", from: "熊本", days: 1, date: "2026-12-05" });

test("旅程の JSON に license_summary と、行ごとの出どころが入る", () => {
  const json = JSON.parse(toJson(result));
  const want = itineraryLicenseSummary(result.itinerary);
  assert.deepEqual(json.license_summary, JSON.parse(JSON.stringify(want)));
  assert.ok(json.license_summary.sources.length > 1);
  assert.equal(json.license_summary.complete, true);
  const spots = json.days.flatMap((d) => d.items).filter((it) => it.kind === "spot");
  assert.ok(spots.length > 0);
  for (const it of spots) assert.ok(Array.isArray(it.sources) && it.sources.length > 0, it.title);
  // 移動の行には付きません。
  assert.ok(json.days.flatMap((d) => d.items).filter((it) => it.kind === "transit").every((it) => !("sources" in it)));
});

test("Markdown・ふつうの文・.ics に、使ったデータの出典が自動で付く", async () => {
  const line = attributionText(itineraryLicenseSummary(result.itinerary));
  assert.match(line, /^出典: /);
  assert.ok(toMarkdown(result).trimEnd().endsWith(line));
  assert.ok(toPlainText(result).trimEnd().endsWith(line));
  assert.match(toMarkdown(result, { lang: "en" }), /\nData sources: .+\n$/);

  const ics = (await toIcs(result)).replace(/\r\n /g, "");
  const first = spotsOfItinerary(result.itinerary).find((s) => attributionText([s]));
  assert.ok(first, "出典の要る場所が旅程にありません");
  // .ics の中では「,」「;」に \ が付きます（RFC 5545）。
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
  assert.ok(ics.includes(esc(attributionText([first]))), "予定の説明に出典がありません");
});

test("外から来たデータが無ければ、出典の行は出ない", () => {
  const mine = [{ id: "a-1", name: "手書きの場所", lat: 35, lng: 135, description: "自分で書いた文。", category: "公園" }];
  assert.equal(attributionText(mine), "");
  assert.deepEqual(licenseSummary(mine).attribution, []);
  const itin = { days: [{ items: [{ kind: "spot", start: "2026-12-05T01:00:00Z", end: "2026-12-05T02:00:00Z", title: "手書きの場所", place: mine[0] }] }] };
  const req = { wish: "散歩", origin: { name: "家" }, days: 1, departAt: "2026-12-05T00:00:00Z", arriveBy: "2026-12-05T09:00:00Z", transport: "transit" };
  assert.doesNotMatch(toMarkdown({ request: req, itinerary: itin }), /出典/);
  assert.equal(JSON.parse(toJson({ request: req, itinerary: itin })).license_summary.sources[0].id, "tabisaki_original");
});

test("スポットの書き出し（JSON・GeoJSON・KML・CSV）に出どころが入り、取り込みは今までどおり", () => {
  const spots = [
    { id: "u:1", name: "自分の場所", lat: 35.1, lng: 135.1, category: "公園" },
    KB.find((s) => s.src === "wikidata" && s.description && s.url && !s.osmInfo),
  ];
  const json = JSON.parse(formatSpots(spots, "json"));
  assert.deepEqual(json.license_summary.sources.map((s) => s.id), ["wikipedia", "wikidata", "tabisaki_original", "user"]);
  assert.equal(json.spots.length, 2);
  assert.equal(JSON.parse(formatSpots(spots, "geojson")).tabisaki.license_summary.schema, SUMMARY_SCHEMA);
  assert.match(formatSpots(spots, "kml"), /<Data name="license_summary"><value>\{&quot;schema&quot;/);

  const csv = formatSpots(spots, "csv");
  const [head, first, second] = csv.split("\r\n");
  assert.ok(head.endsWith(",sources"));
  assert.ok(first.endsWith(",user"));
  assert.ok(second.endsWith(",wikipedia;wikidata;tabisaki_original"));

  for (const fmt of ["json", "geojson", "kml", "csv"]) {
    const back = parseSpots(formatSpots(spots, fmt), { format: fmt });
    assert.deepEqual(back.errors, [], fmt);
    assert.equal(back.ok.length, 2, fmt);
    assert.deepEqual(back.ignored ?? [], [], `${fmt}: sources の列は黙って読み飛ばします`);
  }
});

// --- 移行 -----------------------------------------------------------------------------

test("分けた形で置いた収録を、読み込みがそのまま読める", async () => {
  // 県ごとの段だけを、分けた形にして返します（ほかは今までどおり）。
  const real = globalThis.fetch;
  let served = 0;
  globalThis.fetch = async (url, init) => {
    const res = await real(url, init);
    if (!/\/kb\/spots-[^/]+\.json/.test(String(url?.url ?? url))) return res;
    const doc = splitShard(await res.json());
    assert.ok(doc.spots.every(isSplit));
    served++;
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const kb = await loadKnowledgeBase();
    assert.ok(served >= 47, `県の段を通っていません: ${served}`);
    assert.equal(kb.loadError ?? null, null);
    assert.equal(kb.spots.length, core.kb.spots.length);
    const plain = (list) => JSON.parse(JSON.stringify(list.map(({ vector, ...rest }) => rest)));
    assert.deepEqual(plain(kb.spots), plain(core.kb.spots));
  } finally {
    globalThis.fetch = real;
  }
});

test("移行の道具: 分けて書き、元に戻すと kb/ と同じ", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tabisaki-prov-"));
  try {
    const tool = path.join(ROOT, "tools", "kb_provenance.mjs");
    execFileSync(process.execPath, [tool, "--split", tmp], { encoding: "utf8" });
    const shard = JSON.parse(readFileSync(path.join(tmp, readdirSync(tmp).find((n) => /^spots-/.test(n))), "utf8"));
    assert.ok(isSplit(shard.spots[0]), "分けた形で書かれていません");
    assert.equal(shard.license_summary.schema, SUMMARY_SCHEMA);
    assert.match(execFileSync(process.execPath, [tool, "--verify", tmp], { encoding: "utf8" }), /元に戻すと kb\/ と同じです/);
    // kb/ そのものには書きません。
    assert.throws(() => execFileSync(process.execPath, [tool, "--split", path.join(ROOT, "kb")], { encoding: "utf8", stdio: "pipe" }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("点検の道具は、いまの収録で 0 で終わる", () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "kb_provenance.mjs"), "--stats"], { encoding: "utf8" });
  assert.match(out, /どの項目も出どころを追えます/);
  assert.match(out, /Web Services by Yahoo! JAPAN/);
  const doc = splitShard({ dataSource: "x", spots: KB.slice(0, 3) });
  assert.equal(doc.dataSource, "x");
  assert.equal(doc.spots.length, 3);
});
