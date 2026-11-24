// スクレイピング（非推奨・自己責任の設定のときだけ）。外へは出ません（fetch を差し替えます）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  SCRAPE_USER_AGENT, blockedUrl, createScraper, extractPlaceFacts, jsonLdBlocks, robotsAllows,
  scrapeItinerary, scrapeSummaryLines, spotPageUrl,
} from "../packages/core/src/scrape.js";
import { canScrape, defaultAppSettings, scrapeConsentNow } from "../packages/core/src/app-settings.js";
import { nativeHttpFetch } from "../js/native.js";

const PAGE = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"TouristAttraction","name":"例の寺",
 "telephone":"075-000-0000","address":{"postalCode":"605-0000","addressRegion":"京都府","addressLocality":"京都市","streetAddress":"1-1"},
 "openingHoursSpecification":[{"dayOfWeek":["Monday","Tuesday"],"opens":"09:00:00","closes":"17:00:00"},
   {"dayOfWeek":"https://schema.org/Sunday","opens":"10:00","closes":"16:00"}]}</script>
<script type="application/ld+json">{壊れた}</script></head><body>営業時間は 8:00〜（画面の文は読まない）</body></html>`;

test("読まない宛先: localhost・社内向け・http(s) 以外・ID 入り", () => {
  for (const u of ["http://localhost/", "http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.20.0.1/",
    "http://169.254.169.254/latest", "http://[::1]/", "http://printer.local/", "file:///etc/passwd", "ftp://x.example/", "https://u:p@x.example/", "nope"]) {
    assert.ok(blockedUrl(u), u);
  }
  assert.equal(blockedUrl("https://www.example.jp/info"), null);
  assert.equal(blockedUrl("http://203.0.113.5/"), null);
});

test("robots.txt: 旅さきの組があればそれ、無ければ *、長く当たったほうに従う", () => {
  const txt = "User-agent: *\nDisallow: /private\nAllow: /private/hours\n\nUser-agent: BadBot\nDisallow: /\n";
  assert.equal(robotsAllows(txt, "/info"), true);
  assert.equal(robotsAllows(txt, "/private/x"), false);
  assert.equal(robotsAllows(txt, "/private/hours"), true);
  assert.equal(robotsAllows("User-agent: tabisaki-scraper\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "/a"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow:\n", "/a"), true, "空の Disallow は全部よい");
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*.php$\n", "/a.php"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /*.php$\n", "/a.php?x=1"), true);
  assert.equal(robotsAllows("", "/a"), true);
});

test("拾うのは JSON-LD だけ（営業時間・電話・住所）", () => {
  const facts = extractPlaceFacts(jsonLdBlocks(PAGE));
  assert.equal(facts.name, "例の寺");
  assert.deepEqual(facts.hours, ["月・火 09:00–17:00", "日 10:00–16:00"]);
  assert.equal(facts.phone, "075-000-0000");
  assert.equal(facts.address, "605-0000 京都府 京都市 1-1");
  assert.deepEqual(extractPlaceFacts(jsonLdBlocks("<p>営業時間 9:00</p>")).hours, []);
  const graph = `<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Museum","openingHours":"Tu-Su 09:30-17:00"}]}</script>`;
  assert.deepEqual(extractPlaceFacts(jsonLdBlocks(graph)).hours, ["Tu-Su 09:30-17:00"]);
});

function fakeSite(routes) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), ua: init?.headers?.["User-Agent"] });
    const r = routes[String(url)];
    if (r instanceof Error) throw r;
    if (!r) return new Response("", { status: 404 });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html; charset=utf-8" } });
  };
  return { fetchImpl, seen };
}

test("読む: robots.txt を先に見て、名乗り、同じホストは間を空ける", async () => {
  const { fetchImpl, seen } = fakeSite({
    "https://a.example/robots.txt": { body: "User-agent: *\nDisallow: /no\n", type: "text/plain" },
    "https://a.example/spot": { body: PAGE },
    "https://a.example/spot2": { body: PAGE },
  });
  let clock = 0;
  const waits = [];
  const s = createScraper({ fetchImpl, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  const r = await s.read("https://a.example/spot");
  assert.equal(r.ok, true);
  assert.deepEqual(r.facts.hours, ["月・火 09:00–17:00", "日 10:00–16:00"]);
  assert.equal((await s.read("https://a.example/no/x")).code, "robots");
  assert.equal((await s.read("https://a.example/spot2")).ok, true);
  assert.ok(seen.every((x) => x.ua === SCRAPE_USER_AGENT));
  assert.equal(seen.filter((x) => x.url.endsWith("/robots.txt")).length, 1, "robots.txt は控える");
  assert.ok(waits.length >= 1 && waits.every((w) => w > 0 && w <= 3000));
});

test("読む: 断られた・大きすぎる・HTML でない・つながらないは、投げずに理由を返す", async () => {
  const big = "x".repeat(2_000);
  const { fetchImpl } = fakeSite({
    "https://b.example/robots.txt": { status: 403 },
    "https://c.example/big": { body: big },
    "https://c.example/pdf": { body: "%PDF", type: "application/pdf" },
    "https://d.example/robots.txt": new TypeError("fetch failed"),
    "https://d.example/x": new TypeError("fetch failed"),
  });
  const s = createScraper({ fetchImpl, maxBytes: 1_000, hostIntervalMs: 0 });
  assert.equal((await s.read("https://b.example/x")).code, "robots");
  assert.equal((await s.read("https://c.example/big")).code, "too_large");
  assert.equal((await s.read("https://c.example/pdf")).code, "type");
  assert.equal((await s.read("https://d.example/x")).code, "network");
  assert.equal((await s.read("http://127.0.0.1/")).code, "blocked");
});

test("1回に読むページ数には上限がある", async () => {
  const { fetchImpl } = fakeSite({ "https://e.example/1": { body: PAGE }, "https://e.example/2": { body: PAGE } });
  const s = createScraper({ fetchImpl, maxPages: 1, hostIntervalMs: 0 });
  assert.equal((await s.read("https://e.example/1")).ok, true);
  assert.equal((await s.read("https://e.example/2")).code, "limit");
});

test("旅程: 同意が無ければ読まない。読んだことは収録と混ぜず、未確認として分けて出す", async () => {
  const itinerary = { days: [{ items: [
    { kind: "spot", title: "例の寺", place: { id: "s1", url: "https://f.example/temple" } },
    { kind: "transit", title: "電車" },
    { kind: "spot", title: "同じ寺", place: { id: "s2", url: "https://f.example/temple" } },
    { kind: "spot", title: "OSM の店", place: { id: "s3", osmInfo: { website: "https://f.example/shop" } } },
    { kind: "spot", title: "サイト無し", place: { id: "s4" } },
  ] }] };
  const { fetchImpl, seen } = fakeSite({ "https://f.example/temple": { body: PAGE } });
  const scraper = createScraper({ fetchImpl, hostIntervalMs: 0 });
  const off = await scrapeItinerary(itinerary, { settings: defaultAppSettings(), scraper, canScrape });
  assert.deepEqual(off, { enabled: false, results: [] });
  assert.equal(seen.length, 0);
  const settings = { ...defaultAppSettings(), dataSource: "scrape", scrapeConsent: scrapeConsentNow() };
  const on = await scrapeItinerary(itinerary, { settings, scraper, canScrape });
  assert.equal(on.results.length, 2, "同じページは1度だけ、サイトの無い場所は読まない");
  assert.equal(itinerary.days[0].items[0].place.hours, undefined, "収録のデータは書き換えない");
  const text = scrapeSummaryLines(on).join("\n");
  assert.match(text, /未確認・自己責任/);
  assert.match(text, /例の寺: 営業時間 月・火 09:00–17:00/);
  assert.match(text, /読めなかったページ 1件/);
  assert.equal(spotPageUrl({ url: "http://localhost/" }), "");
});

test("アプリ: CapacitorHttp で読む fetch（アプリでなければ使わない）", async () => {
  assert.equal(nativeHttpFetch(undefined), null);
  assert.equal(nativeHttpFetch({ isNativePlatform: () => false, Plugins: { CapacitorHttp: { request() {} } } }), null);
  const calls = [];
  const cap = { isNativePlatform: () => true, Plugins: { CapacitorHttp: { request: async (o) => {
    calls.push(o);
    return { status: 200, url: o.url, headers: { "Content-Type": "text/html" }, data: PAGE };
  } } } };
  const f = nativeHttpFetch(cap);
  const res = await f("https://g.example/x", { headers: { "User-Agent": SCRAPE_USER_AGENT } });
  assert.equal(res.ok, true);
  assert.equal(res.headers.get("content-type"), "text/html");
  assert.match(await res.text(), /例の寺/);
  assert.equal(calls[0].headers["User-Agent"], SCRAPE_USER_AGENT);
});
