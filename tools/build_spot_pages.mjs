#!/usr/bin/env node
// 旅さき — 観光地のページ（spots/）を、data/spots.mjs から組み立てます。
//
//     node tools/build_spot_pages.mjs            # リポジトリの spots/ に出す
//     node tools/build_spot_pages.mjs dist       # 公開用の dist/spots/ に出す
//
// 1か所につき1ページ。一覧（spots/index.html）と、前後のページへの道も作ります。
// 写真は data/photos.json（tools/fetch_spot_photos.mjs が作ります）にあれば使い、
// 無ければ地名の1字目を置いた下地で出します（**写真が無くてもページは完成します**）。
//
// ページの作りは、この1本にまとめています。増やすときは data/spots.mjs に足すだけ。
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SPOTS, REGIONS, CATS, COURSES } from "../data/spots.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = process.argv[2] ? pathResolve(process.argv[2]) : root;
const spotsDir = join(outDir, "spots");
const ORIGIN = "https://tabisaki-github-io.shitianliang1000.workers.dev";

/** HTML に入れる文字を、そのまま出しても壊れないようにします。 */
const h = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const plain = (s) => String(s ?? "").replace(/[<>]/g, "");
const catOf = (k) => CATS.includes(k) ? k : "街";
const regionOf = (k) => REGIONS.find((r) => r.key === k)?.name ?? "";

/** 写真の一覧（任意）。{ slug: { url, local, author, license, page } } */
let photos = {};
try {
  photos = JSON.parse(await readFile(join(root, "data/photos.json"), "utf8"));
} catch { /* まだ取っていないだけ。下地で出します。 */ }

/** 写真の読み先。落としてあれば自分の場所、無ければ Commons から。 */
function srcOf(spot, prefix) {
  const ph = photos[spot.slug];
  if (!ph) return null;
  if (ph.local) return `${prefix}photos/${h(ph.local)}`;
  if (ph.url) return ph.url;
  return null;
}

/** 写真が無いときの下地（4つの濃い色を、名前から決めます）。 */
const tintOf = (slug) => {
  let n = 0;
  for (const c of slug) n = (n * 31 + c.charCodeAt(0)) % 997;
  return ["g1", "g2", "g3", "g4", "g5"][n % 5];
};

// 写真は2通り。photos/ に落としてあるものは自分の場所から、
// まだ落としていないものは Wikimedia Commons から読みます（どちらでも同じ絵になります）。
// 写真の配信元は2つ（Commons の原本と、縮小版の thumb）。両方を img-src に入れます。
const PHOTO_HOSTS = "https://upload.wikimedia.org https://thumb.wikimedia.org";
const CSP = `default-src 'self'; img-src 'self' data: ${PHOTO_HOSTS}; media-src 'self'; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'`;

/** 帯（ほかのページと同じ形）。current は、いま開いているページの名前。 */
function nav(current) {
  const items = [
    ["観光地", "spots/index.html"],
    ["SSH・端末", "ssh.html"],
    ["アプリ", "mobile.html"],
    ["API", "api.html"],
  ];
  const links = items.map(([label, href]) =>
    `      <a href="../${href}"${current === label ? ' aria-current="page"' : ""}>${h(label)}</a>`).join("\n");
  const chips = [["旅さき", "../tour", "旅さき"], ...items.map(([l, href]) => [l, `../${href}`, l])]
    .map(([label, href]) =>
      `      <li><a href="${href}"${current === label ? ' aria-current="page"' : ""}>${h(label)}</a></li>`).join("\n");
  return `<header class="lnav" id="lnav">
  <div class="lnav-in">
    <a class="lnav-name" href="../tour"><img src="../mark.svg" alt="" width="20" height="20"><span><b>旅さき</b><small>観光地</small></span></a>
    <nav class="lnav-links" aria-label="サイトの中">
${links}
    </nav>
    <a class="btn btn-sm" href="../app">旅さきを使う</a>
  </div>
</header>
<nav class="pagenav" aria-label="サイトの中">
    <ul>
${chips}
    </ul>
</nav>`;
}

function foot() {
  return `<footer class="foot">
  <div class="wrap foot-in">
    <a class="foot-brand" href="../tour"><img src="../mark.svg" alt="" width="22" height="22"><span>旅さき</span></a>
    <nav aria-label="ほかのページ">
      <a href="../app">旅程をつくる</a>
      <a href="index.html">観光地</a>
      <a href="../ssh.html">SSH・端末</a>
      <a href="../mobile.html">アプリ</a>
      <a href="../api.html">API</a>
      <a href="../credits.html">著作権表記</a>
    </nav>
  </div>
</footer>`;
}

/** 写真の枠。写真があれば img、無ければ下地＋1字目。 */
function figure(spot, { className = "frame" } = {}) {
  const src = srcOf(spot, "../");
  if (src) {
    return `<div class="${className}"><img src="${h(src)}" alt="${h(spot.name)}の写真" width="1200" height="675" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>`;
  }
  return `<div class="${className} ${tintOf(spot.slug)}"><span class="mono" aria-hidden="true">${h(spot.name.slice(0, 1))}</span></div>`;
}

function creditOf(spot) {
  const ph = photos[spot.slug];
  const w = `https://ja.wikipedia.org/wiki/${encodeURIComponent(spot.title)}`;
  if (ph) {
    const bits = [];
    if (ph.author) bits.push(h(ph.author));
    const attribution = [ph.author ? h(ph.author) : "作者不明",
      ph.license ? (ph.licenseUrl ? `<a href="${h(ph.licenseUrl)}" rel="noopener" target="_blank">${h(ph.license)}</a>` : h(ph.license)) : "許諾を要確認"];
    return `写真: <a href="${h(ph.page ?? w)}" rel="noopener" target="_blank">Wikimedia Commons の画像ページ</a>（${attribution.join(" / ")}）。記事: <a href="${w}" rel="noopener" target="_blank">Wikipedia「${h(spot.title)}」</a>。`;
  }
  return `この場所の写真はまだ入れていません（下地で表示しています）。記事: <a href="${w}" rel="noopener" target="_blank">Wikipedia「${h(spot.title)}」</a>。`;
}

function routeBlock(spot) {
  if (!spot.route?.length) return "";
  const steps = spot.route.map((s) =>
    `        <li><span class="t">${h(s.t)}</span><span><span class="n">${h(s.name)}</span><span class="d">${h(s.d)}</span></span></li>`).join("\n");
  return `      <h2 id="route">おすすめの順路</h2>
      <p>${h(spot.name)}を${spot.route.length}か所で回る、半日から1日の案です。時刻は目安で、移動は公共交通か車を想定しています。</p>
      <div class="route">
        <header><h3>${h(spot.name)}・${spot.route.length}か所</h3><span class="badge blue">所要 ${spot.route.length >= 4 ? "半日〜1日" : "2〜3時間"}</span></header>
        <ol>
${steps}
        </ol>
        <p class="route-note">開館・拝観の時間は変わります。出かける前に、いちばん遠い1か所の公式だけは確かめてください。</p>
      </div>`;
}

function spotPage(spot, prev, next) {
  const title = `${spot.name}（${spot.pref}）の見どころとモデルコース | 旅さき`;
  const desc = plain(spot.lead).slice(0, 108);
  const url = `${ORIGIN}/spots/${spot.slug}.html`;
  const jsonld = {
    "@context": "https://schema.org",
    "@type": "TouristAttraction",
    name: spot.name,
    description: plain(spot.lead),
    url,
    address: { "@type": "PostalAddress", addressCountry: "JP", addressRegion: spot.pref },
    touristType: spot.cat,
  };
  const points = (spot.points ?? []).map((x) => `        <li>${h(x)}</li>`).join("\n");
  const near = (spot.near ?? []).map((s) => SPOTS.find((x) => x.slug === s)).filter(Boolean)
    .map((s) => `        <a class="card" href="${h(s.slug)}.html"><span class="badge">${h(s.pref)}</span><h3>${h(s.name)}</h3><p>${h(plain(s.lead).slice(0, 62))}…</p><span class="go">読む ›</span></a>`).join("\n");
  const pager = `<div class="pager">
        ${prev ? `<a href="${h(prev.slug)}.html" class="prev"><small>前の観光地</small><b>${h(prev.name)}</b></a>` : "<span></span>"}
        ${next ? `<a href="${h(next.slug)}.html" class="next"><small>次の観光地</small><b>${h(next.name)}</b></a>` : ""}
      </div>`;

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${h(title)}</title>
<meta name="description" content="${h(desc)}">
<link rel="canonical" href="${h(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="旅さき">
<meta property="og:title" content="${h(spot.name)}（${h(spot.pref)}）">
<meta property="og:description" content="${h(desc)}">
<meta property="og:url" content="${h(url)}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta name="theme-color" content="#000000">
<link rel="icon" href="../icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="../icon-180.png">
<link rel="stylesheet" href="../assets/tour.css?v=55e9eebc">
<link rel="stylesheet" href="../assets/tour-polish.css?v=d926a3a9">
<link rel="stylesheet" href="../assets/site.css?v=28cb7765">
<script type="module" src="../assets/site.js?v=48a22569"></script>
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<a class="skip" href="#main">本文へ</a>
${nav("観光地")}
<main id="main">
  <article>
    <header class="spot-hero">
      <div class="in">
        <div class="spot-kicker">
          <span class="badge blue">${h(regionOf(spot.region))}</span>
          <span class="badge">${h(spot.pref)}</span>
          <span class="badge">${h(catOf(spot.cat))}</span>
        </div>
        <h1 class="spot-h1">${h(spot.name)}</h1>
        <p class="spot-lead">${h(plain(spot.lead))}</p>
        <figure class="spot-figure">
          ${figure(spot)}
          <figcaption>${creditOf(spot)}</figcaption>
        </figure>
        <dl class="facts">
          <div><dt>場所</dt><dd>${h(spot.pref)}</dd></div>
          <div><dt>行きかた</dt><dd>${h(spot.access)}</dd></div>
          <div><dt>開いている時間</dt><dd>${h(spot.hours)}</dd></div>
        </dl>
      </div>
    </header>

    <div class="spot-body">
      <div class="doc-wrap">
        <div class="prose">
          <h2 id="points">見どころと、気をつけること</h2>
          <ul>
${points}
          </ul>
${routeBlock(spot)}
          <h2 id="plan">旅さきで、この場所から組む</h2>
          <p>${h(spot.name)}を起点に、日数と好みを書くと、営業時間と移動時間を照らし合わせた旅程を作ります。ほかの観光地と組み合わせたいときは、地名をそのまま文に書いてください。</p>
          <p><a class="btn" href="../app?q=${encodeURIComponent(spot.name + "を中心に、ゆっくり回りたい")}&amp;go=1">${h(spot.name)}で旅を組む</a></p>
          <div class="note"><span class="i" aria-hidden="true">i</span><p>営業時間・拝観料・休館日は変わります。この記事の時刻は目安です。出かける前に、施設の公式の案内で確かめてください。</p></div>
          ${near ? `<h2 id="near">近くの観光地</h2>\n      <div class="cards">\n${near}\n      </div>` : ""}
          ${pager}
        </div>
        <nav class="doc-toc" aria-label="この記事の中">
          <p>この記事</p>
          <ol>
            <li><a href="#points">見どころ</a></li>
            ${spot.route?.length ? `<li><a href="#route">おすすめの順路</a></li>` : ""}
            <li><a href="#plan">旅さきで組む</a></li>
            ${near ? `<li><a href="#near">近くの観光地</a></li>` : ""}
          </ol>
        </nav>
      </div>
    </div>
  </article>
</main>
${foot()}
</body>
</html>
`;
}

function card(spot) {
  const src = srcOf(spot, "../");
  const ph = photos[spot.slug];
  const ph = photos[spot.slug];
  const photoCredit = src && ph ? `<small class="photo-credit">写真: <a href="${h(ph.page ?? "https://commons.wikimedia.org/")}" rel="noopener" target="_blank">${h(ph.author || "作者不明")}</a>${ph.license ? ` / ${ph.licenseUrl ? `<a href="${h(ph.licenseUrl)}" rel="noopener" target="_blank">${h(ph.license)}</a>` : h(ph.license)}` : " / 許諾を要確認"}</small>` : "";
  return `      <article class="spot-card" data-region="${h(spot.region)}" data-cat="${h(catOf(spot.cat))}">
        <a class="spot-link" href="${h(spot.slug)}.html" aria-label="${h(spot.name)}の紹介ページ">
          <div class="ph ${src ? "" : tintOf(spot.slug)}">${
            src
              ? `<img src="${h(src)}" alt="${h(spot.name)}" width="480" height="360" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
              : `<span class="mono" aria-hidden="true">${h(spot.name.slice(0, 1))}</span>`}</div>
          <div class="body">
            <b>${h(spot.name)}</b>
            <span>${h(spot.pref)} ・ ${h(catOf(spot.cat))}</span>
            <p>${h(plain(spot.lead).slice(0, 56))}…</p>
          </div>
        </a>
        ${photoCredit}
      </article>`;
}

function courseBlock(course) {
  const steps = course.steps.map((s) =>
    `        <li><span class="t">${h(s.t)}</span><span><span class="n">${h(s.name)}</span><span class="d">${h(s.d)}</span></span></li>`).join("\n");
  return `      <div class="route">
        <header><h3>${h(course.title)}</h3><span class="badge blue">${h(course.span)}</span><span class="badge">${h(regionOf(course.region))}</span></header>
        <ol>
${steps}
        </ol>
        <p class="route-note">${h(course.note)}</p>
      </div>`;
}

function indexPage() {
  const count = SPOTS.length;
  const regionChips = [{ key: "all", name: "すべて" }, ...REGIONS]
    .map((r, i) => `      <button type="button" class="chip" data-group="region" data-value="${h(r.key)}" aria-pressed="${i === 0}">${h(r.name)}</button>`).join("\n");
  const catChips = [{ key: "all", name: "すべて" }, ...CATS.map((c) => ({ key: c, name: c }))]
    .map((c, i) => `      <button type="button" class="chip" data-group="cat" data-value="${h(c.key)}" aria-pressed="${i === 0}">${h(c.name)}</button>`).join("\n");
  const cards = SPOTS.map(card).join("\n");
  const courses = COURSES.map(courseBlock).join("\n");
  const url = `${ORIGIN}/spots/`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>観光地の紹介（${count}か所）とモデルコース | 旅さき</title>
<meta name="description" content="全国の有名どころを、見どころ・行きかた・開いている時間・すすめの順路で紹介します。地方と分類から絞り込めます。">
<link rel="canonical" href="${h(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="旅さき">
<meta property="og:title" content="観光地の紹介とモデルコース">
<meta property="og:description" content="全国の有名どころ ${count} か所を、順路つきで。">
<meta property="og:url" content="${h(url)}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta name="theme-color" content="#000000">
<link rel="icon" href="../icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="../icon-180.png">
<link rel="stylesheet" href="../assets/tour.css?v=55e9eebc">
<link rel="stylesheet" href="../assets/tour-polish.css?v=d926a3a9">
<link rel="stylesheet" href="../assets/site.css?v=28cb7765">
<script type="module" src="../assets/site.js?v=48a22569"></script>
</head>
<body>
<a class="skip" href="#main">本文へ</a>
${nav("観光地")}
<main id="main">
  <section class="sub-hero">
    <p class="eyebrow">観光地</p>
    <h1 class="sub-title">行き先を、読んでから決める。</h1>
    <p class="sub-lead">全国の有名どころ ${count} か所を、見どころ・行きかた・開いている時間・おすすめの順路でまとめました。気になった場所から、そのまま旅程を組めます。</p>
    <p class="sub-actions"><a class="btn" href="../app">旅さきをひらく</a><a class="btn-ghost" href="#courses">モデルコースを見る</a></p>
  </section>

  <section class="sec" id="list">
    <div class="wrap">
      <div class="sec-head">
        <h2>観光地から探す</h2>
        <p>地方と分類で絞り込めます。<span id="spots-count">${count}</span> か所を表示中。</p>
      </div>
      <div class="filters" role="group" aria-label="地方で絞る">
${regionChips}
      </div>
      <div class="filters" role="group" aria-label="分類で絞る">
${catChips}
      </div>
      <div class="spot-grid">
${cards}
      </div>
      <p id="spots-empty" class="lead" hidden>この組み合わせに合う観光地は、まだ入っていません。地方か分類を「すべて」に戻してください。</p>
    </div>
  </section>

  <section class="sec tint" id="courses">
    <div class="wrap">
      <div class="sec-head">
        <h2>おすすめのモデルコース</h2>
        <p>地方ごとに、つなげて回れる順路を用意しました。時刻は目安です。旅さきに地名をいくつか書けば、同じ順路をその日の条件で組み直します。</p>
      </div>
${courses}
    </div>
  </section>

  <section class="end-cta">
    <h2>読んでから、組む。</h2>
    <p><a class="btn btn-lg" href="../app">旅さきをひらく</a></p>
  </section>
</main>
${foot()}
</body>
</html>
`;
}

// ---- 書き出し ----
await mkdir(spotsDir, { recursive: true });
let n = 0;
for (let i = 0; i < SPOTS.length; i++) {
  const spot = SPOTS[i];
  const html = spotPage(spot, SPOTS[i - 1], SPOTS[i + 1]);
  await writeFile(join(spotsDir, `${spot.slug}.html`), html, "utf8");
  n++;
}
await writeFile(join(spotsDir, "index.html"), indexPage(), "utf8");

// 公開用（dist など）に出すときは、sitemap.xml にも足します。
const sitemap = join(outDir, "sitemap.xml");
if (existsSync(sitemap)) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [`${ORIGIN}/spots/`, ...SPOTS.map((s) => `${ORIGIN}/spots/${s.slug}.html`)]
    .map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`)
    .join("\n");
  let xml = await readFile(sitemap, "utf8");
  if (!xml.includes("spots/")) {
    xml = xml.replace("</urlset>", `${urls}\n</urlset>`);
    await writeFile(sitemap, xml, "utf8");
    console.log(`sitemap.xml に観光地の ${SPOTS.length + 1} 件を足しました`);
  }
}

console.log(`観光地のページを ${n} 枚と、一覧1枚を ${spotsDir} に出しました`);
