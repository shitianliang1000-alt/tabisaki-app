// トップ（/）は、PHP 版（php/index.php）でも Cloudflare 版（server/landing.js）でも、
// 同じひな形（php/inc/landing.html）から、同じ中身で作ります。
//
// 見るのは3つ。
//   ・Cloudflare 版が、トップ・/app・ひな形の置き場を正しく受け持つこと
//   ・PHP があれば、同じ日時・同じデータで、両方の HTML が1字も違わないこと
//   ・日替わりのおすすめに使う crc32 が、PHP と同じ値になること
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import worker from "../server/worker.js";
import { crc32, landingView, renderTpl, resetLandingCache, servePage, words } from "../server/landing.js";

const root = new URL("../", import.meta.url);
const tpl = await readFile(new URL("php/inc/landing.html", root), "utf8");
const W = "https://tabisaki-github-io.example.workers.dev";

const course = [
  { kind: "spot", time: "10:00", title: "金閣寺", min: "60分", text: "池に映る金色" },
  { kind: "move", time: "11:00", title: "バス 20分", min: "", text: "" },
  { kind: "meal", time: "12:00", title: "湯豆腐 \"嵯峨\" & 庭", min: "", text: "" },
  { kind: "spot", time: "13:30", title: "嵐山 <竹林>", min: "45分", text: "" },
];
const data = {
  build: "abc123", prefCount: 47, spotCount: 54115,
  areas: [
    { id: "kyoto", name: "京都", prefecture: "京都府", tagline: "千年の都を'歩いて'めぐる", genres: ["history", "food"],
      station: "京都駅", lat: 35.0, lng: 135.7588, page: "areas/kyoto/kyoto.html", image: "areas/kyoto/kyoto.png", course },
    { id: "hakone", name: "箱根", prefecture: "神奈川県", tagline: "温泉と芦ノ湖", genres: ["onsen", "view", "nature"],
      station: "箱根湯本駅", lat: 35.2324, lng: 139.1069, page: null, image: null, course: [] },
    { id: "atami", name: "熱海", prefecture: "静岡県", tagline: "海の見える温泉街", genres: ["onsen", "sea"],
      station: "熱海駅", lat: 35.1035, lng: 139.0779, page: "areas/shizuoka/atami.html", image: null, course },
  ],
  news: [
    { date: "2026-10-22", title: "PHP 版を足す", tag: "サイト" },
    { date: "2026-10-15", title: "上高地を足す", tag: "行き先" },
    { date: "2026-10-13", title: "考えている間の動き", tag: "チャット" },
    { date: "2026-10-01", title: "旅の目的で並べ替える", tag: "改善" },
  ],
};

// 季節と時刻がちがう日時（朝・昼・夜、春夏秋冬）。
const times = ["2026-10-22T11:14:00Z", "2026-01-05T22:30:00Z", "2026-04-10T01:00:00Z", "2026-07-31T15:59:00Z"]
  .map((s) => new Date(s));

const assets = (files) => ({
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (!(path in files)) return new Response("nope", { status: 404 });
    return new Response(files[path], { headers: { "Content-Type": path.endsWith(".json") ? "application/json" : "text/html" } });
  },
});
const shell = '<html><head><link rel="canonical" href="https://old/"><meta property="og:url" content="https://old/"></head>'
  + '<body><span id="hero-greet">こんにちは</span><div class="chip-set note-examples" role="list">'
  + '<button a>1</button><button b>2</button><button c>3</button><button d>4</button></div>'
  + '<a href="about.html">旅さきについて（使いかたと組んだ例）</a></body></html>';
const env = { ASSETS: assets({ "/__site/landing.html": tpl, "/data/areas.json": JSON.stringify(data), "/": shell }) };

test("トップは、ひな形に今日の中身を入れて返す", async () => {
  resetLandingCache();
  const res = await worker.fetch(new Request(`${W}/`), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Security-Policy") ?? "", /connect-src 'self' https:\/\/api\.open-meteo\.com/);
  const html = await res.text();
  for (const id of ['id="stage"', 'id="rail"', 'id="scrub"', 'id="ask-q"', 'class="how"']) assert.ok(html.includes(id), id);
  assert.ok(!/\{\{\{?[#^/]?\w+\}\}/.test(html), "入れ忘れた {{…}} があります");
  assert.match(html, /Cloudflare Worker/);
  assert.match(html, /54,115か所/);
  // 字は HTML として安全に入ります。
  assert.ok(html.includes("&#039;歩いて&#039;"));
  assert.ok(!html.includes("<竹林>"));
});

test("前のトップあての旅程のリンク（/?p=…）は、/app へ渡す", async () => {
  const res = await worker.fetch(new Request(`${W}/?p=abc`), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), `${W}/app?p=abc`);
});

test("/app と /index.html は、挨拶と見本を替えたチャットの画面", async () => {
  for (const path of ["/app", "/index.html"]) {
    const res = await servePage(new Request(`${W}${path}`), env, new Date("2026-10-22T00:00:00Z"));
    const html = await res.text();
    assert.match(html, /<span id="hero-greet">おはようございます<\/span>/, path);
    assert.match(html, /<button a>1<\/button><button b>2<\/button><button type="button"[^>]*data-example="紅葉を見て/);
    assert.ok(!html.includes("<button c>"));
    assert.match(html, /href="\.\/">旅さきについて/);
    // どちらのホストで開いても、正式なアドレス（tabisaki.site.je）を名乗る。
    assert.match(html, /<link rel="canonical" href="https:\/\/tabisaki\.site\.je\/app"/);
  }
});

test("ひな形の置き場は、直には見せない", async () => {
  const res = await worker.fetch(new Request(`${W}/__site/landing.html`), env);
  assert.equal(res.status, 404);
});

test("見出しは句読点ごとに区切る", () => {
  assert.equal(words("あ、い。う"),
    '<span class="w" data-i="0">あ、</span><span class="w" data-i="1">い。</span><span class="w" data-i="2">う</span>');
});

test("crc32 は PHP と同じ値", () => {
  assert.equal(crc32("The quick brown fox jumps over the lazy dog"), 0x414fa339);
  // PHP の crc32('20261022:京都') と crc32('20261022:kyoto') が返す値です。
  assert.equal(crc32("20261022:京都"), 493669429);
  assert.equal(crc32("20261022:kyoto"), 2101491005);
});

const hasPhp = spawnSync("php", ["-v"]).status === 0;

test("PHP 版と Cloudflare 版のトップが、1字も違わない", { skip: !hasPhp && "php がありません" }, () => {
  const site = new URL("php/inc/site.php", root).pathname;
  const tplPath = new URL("php/inc/landing.html", root).pathname;
  const code = `require ${JSON.stringify(site)};
    $in = json_decode(stream_get_contents(STDIN), true);
    $tpl = file_get_contents(${JSON.stringify(tplPath)});
    $out = [];
    foreach ($in['times'] as $t) $out[] = render_tpl($tpl, landing_view(new DateTimeImmutable('@' . $t), $in['data'], $in['base'], 'X'));
    echo json_encode($out, JSON_UNESCAPED_UNICODE);`;
  const php = JSON.parse(execFileSync("php", ["-r", code], {
    input: JSON.stringify({ times: times.map((t) => t.getTime() / 1000), data, base: "https://x.example/" }),
    encoding: "utf8",
  }));
  times.forEach((t, i) => {
    const js = renderTpl(tpl, landingView(t, data, "https://x.example/", "X"));
    if (js !== php[i]) {
      const a = js.split("\n"), b = php[i].split("\n");
      const at = a.findIndex((l, k) => l !== b[k]);
      assert.fail(`${t.toISOString()} の ${at + 1} 行目が違います\nJS : ${a[at]}\nPHP: ${b[at]}`);
    }
  });
});

test("モデルコースの読み取りは、字だけを取り出し、文字参照は1回だけ戻す", async () => {
  const { parseCourse } = await import("../tools/course.mjs");
  const html = '<ol class="course"><li class="c-spot"><b class="c-time">10:00</b>'
    + '<span class="c-title">A &amp;lt;b&amp;gt; &amp; <scr<script>ipt>x<small>30分</small></span>'
    + '<span class="c-text">t</span></li></ol>';
  const [c] = parseCourse(html);
  assert.equal(c.title, "A &lt;b&gt; & iptx");
  assert.ok(!/[<>]/.test(c.title));
  assert.equal(c.min, "30分");
});
