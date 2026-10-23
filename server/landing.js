// 旅さき — Cloudflare 版のトップ（/）とチャットの画面（/app）を、開いたときに作ります。
//
// PHP 版（php/index.php・php/app.php）と同じことを、Worker の中でします。
//   ・トップは、ひな形 php/inc/landing.html に今日の中身を入れて返す
//     （ひな形は tools/build_worker.sh が .site/__site/landing.html に置きます）
//   ・/app は index.html の挨拶と書きかたの見本を、いまの時刻と季節に替えて返す
//
// 中身の作りかた（landingView）とひな形の読みかた（renderTpl）は
// php/inc/site.php の landing_view・render_tpl と同じ結果になります。
// tests/landing.test.js が、PHP があれば両方を動かして字まで比べます。

export const SITE_DIR = "/__site/";
/**
 * 検索エンジンに載せる正式なアドレス（canonical・OGP・構造化データ）。
 * Worker（workers.dev）でも PHP 版（tabisaki.site.je）でも、ここを名乗ります。
 * 評価が2つに割れないようにするためです（2026-10-23 に workers.dev へ変更）。
 * php/inc/site.php の SITE_ORIGIN と同じにしてください。
 */
export const SITE_ORIGIN = "https://tabisaki-github-io.shitianliang1000.workers.dev";
export const LANDING_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' https://api.open-meteo.com; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";

const JST = 9 * 3600 * 1000;

/** 日本時間の年・月・日・時・分・曜日。 */
function jst(now) {
  const d = new Date(now.getTime() + JST);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
           h: d.getUTCHours(), min: d.getUTCMinutes(), w: d.getUTCDay() };
}

const pad = (n) => String(n).padStart(2, "0");

/** PHP の htmlspecialchars(ENT_QUOTES) と同じ。 */
export function h(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** PHP の rawurlencode と同じ。 */
export function rawurl(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** PHP の number_format と同じ（3桁ごとのカンマ）。 */
const num = (n) => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** PHP の crc32 と同じ（今日のおすすめの日替わりに使います）。 */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
export function crc32(s) {
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(s)) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function greeting(now) {
  const { h: hr } = jst(now);
  if (hr >= 4 && hr < 10) return "おはようございます";
  if (hr >= 10 && hr < 17) return "こんにちは";
  return "こんばんは";
}

export function season(now) {
  const { m } = jst(now);
  if (m >= 3 && m <= 5) return { key: "spring", name: "春", genres: ["nature", "history", "view"],
    line: "桜と新緑の季節です。古い町並みや庭園を、歩いてめぐるのが気持ちいい頃です。",
    examples: [["桜と町歩き", "桜のきれいな古い町並みを歩きたい"], ["新緑の温泉", "新緑の中で、のんびり温泉に入りたい"], ["春の花畑", "春の花畑を見に、日帰りで出かけたい"]] };
  if (m >= 6 && m <= 8) return { key: "summer", name: "夏", genres: ["sea", "nature", "view"],
    line: "海と高原の季節です。朝早く出て、暑い昼は涼しいところで過ごす旅が向いています。",
    examples: [["子どもと海", "子どもと海で遊んで、夕方は花火も見たい"], ["涼しい高原", "涼しい高原で、湖のまわりを歩きたい"], ["暑い日の美術館", "暑い日でも楽しめる、屋内の美術館めぐり"]] };
  if (m >= 9 && m <= 11) return { key: "autumn", name: "秋", genres: ["nature", "view", "onsen", "food"],
    line: "紅葉と味覚の季節です。色づいた山を見て、夜は温泉と土地のごはんで締めくくれます。",
    examples: [["紅葉と温泉", "紅葉を見て、夜は温泉でゆっくりしたい"], ["秋の食べ歩き", "秋の味覚を食べ歩きできる町へ行きたい"], ["穴場の紅葉", "人の少ない紅葉の名所を、穴場多めでまわりたい"]] };
  return { key: "winter", name: "冬", genres: ["onsen", "food", "history"],
    line: "雪見の湯と冬の味覚の季節です。移動を短くして、温かいところで長く過ごす旅が向いています。",
    examples: [["雪見の温泉", "雪を見ながら温泉に入りたい"], ["冬の海鮮", "冬の海鮮を食べに、1泊2日で出かけたい"], ["駅近の町歩き", "寒い日でも楽しめる、駅から近い町歩き"]] };
}

export function jpDate(now) {
  const t = jst(now);
  return `${t.m}月${t.d}日（${"日月火水木金土"[t.w]}）`;
}

/** 今日のおすすめ（php/inc/site.php の todays_picks と同じ並び）。 */
export function todaysPicks(areas, s, n, now) {
  const t = jst(now);
  const seed = `${t.y}${pad(t.m)}${pad(t.d)}`;
  return areas.map((a) => {
    const fit = (a.genres ?? []).filter((g) => s.genres.includes(g)).length;
    const jitter = (crc32(`${seed}:${a.id ?? ""}`) % 1000) / 1000;
    return [fit + jitter * 1.6, a];
  }).sort((x, y) => y[0] - x[0]).slice(0, n).map((p) => p[1]);
}

/** 見出しの文を、句読点ごとに span で包みます。 */
export function words(s) {
  const parts = String(s).match(/[^、。]*[、。]|[^、。]+$/g) ?? [s];
  return parts.map((p, i) => `<span class="w" data-i="${i}">${h(p)}</span>`).join("");
}

/** PHP の (string) と同じ数の書きかた（35.0 は "35"）。 */
const str = (v) => (v === null || v === undefined ? "" : String(v));

export function landingView(now, data, base, madeBy) {
  const s = season(now);
  const areas = data.areas ?? [];
  const news = data.news ?? [];
  const picks = todaysPicks(areas, s, 8, now);
  const spotCount = Math.trunc(Number(data.spotCount ?? 0));
  const prefCount = Math.trunc(Number(data.prefCount ?? 47));
  const ex = s.examples;
  const t = jst(now);

  const demo = [];
  for (const a of picks) {
    if (!a.course?.length) continue;
    const spots = a.course.filter((c) => (c.kind ?? "") === "spot").length;
    demo.push({
      name: a.name, pref: a.prefecture, station: a.station,
      prompt: `${a.name}で、${ex[demo.length % ex.length][1]}`,
      lead: `${a.name}（${a.prefecture}）への日帰りの旅を組みました。立ち寄りは${spots}か所です。`,
      items: a.course.slice(0, 12),
    });
    if (demo.length >= 3) break;
  }
  const typing = ex.map((e) => e[1]);
  const newsItem = (n) => ({ tag: n.tag, date: n.date, title: n.title,
    label: `${Number(n.date.slice(5, 7))}月${Number(n.date.slice(8, 10))}日` });

  return {
    title: "旅さき｜行きたいことを書くだけで、旅程になるAI",
    desc: "「温泉と海をゆっくり」と書くだけで、行き先・まわる順・移動時間まで組んだ旅程が届く無料のAI。"
      + `全国${prefCount}都道府県・${num(spotCount)}か所の観光地から組みます。`,
    base,
    build: str(data.build ?? "0"),
    hour: t.h,
    greeting: greeting(now),
    date: jpDate(now),
    year: String(t.y),
    stamp: `${t.y}-${pad(t.m)}-${pad(t.d)} ${pad(t.h)}:${pad(t.min)}`,
    madeBy,
    seasonName: s.name,
    seasonLine: s.line,
    headB: words("行きたいことを書くだけで、旅程になる。"),
    headS: words(`旅さきは、全国${num(spotCount)}か所の観光地から、営業時間と移動時間を確かめて、無理のない1日を組むAIです。`),
    demoJson: JSON.stringify(demo),
    demo0: demo[0] ?? null,
    typing0: typing[0] ?? "",
    typingJson: JSON.stringify(typing),
    examples: ex.map((e) => ({ label: e[0], q: rawurl(e[1]) })),
    rainQ: rawurl("雨でも楽しめるところをまわりたい"),
    pickCount: picks.length,
    picks: picks.map((a) => ({
      lat: str(a.lat), lng: str(a.lng),
      image: a.image ?? null, page: a.page ?? null,
      prefecture: a.prefecture, station: a.station, name: a.name,
      tagline: a.tagline ?? "",
      q: rawurl(`${a.name}を、${s.name}らしく楽しみたい`),
    })),
    prefCount,
    spotCount,
    spotCountFmt: num(spotCount),
    areaCount: areas.length,
    hasNews: news.length > 0,
    news3: news.slice(0, 3).map(newsItem),
    newsRest: news.length > 3 ? { items: news.slice(3).map(newsItem) } : null,
    footAreas: picks.slice(0, 4).filter((a) => a.page).map((a) => ({ page: a.page, name: a.name })),
  };
}

/** ひな形の「空」。null・false・""・[] だけ（0 や "0" は空ではありません）。 */
const empty = (v) => v === null || v === undefined || v === false || v === ""
  || (Array.isArray(v) && v.length === 0);

/** ひな形に中身を入れます（php/inc/site.php の render_tpl と同じ）。 */
export function renderTpl(tpl, view, stack = [view]) {
  const look = (k) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i];
      if (c && typeof c === "object" && Object.hasOwn(c, k)) return c[k];
    }
    return null;
  };
  const text = (v) => (typeof v === "boolean" ? (v ? "true" : "") : str(v));
  return tpl.replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}|\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g,
    (_, sigil, name, body, raw, plain) => {
      if (sigil) {
        const v = look(name);
        if (sigil === "^") return empty(v) ? renderTpl(body, view, stack) : "";
        if (empty(v)) return "";
        if (Array.isArray(v)) return v.map((item) => renderTpl(body, view, [...stack, item])).join("");
        return renderTpl(body, view, typeof v === "object" ? [...stack, v] : stack);
      }
      if (raw) return text(look(raw));
      return h(text(look(plain)));
    });
}

/**
 * /app（チャットの画面）。php/app.php と同じ差し替えをします。
 * 挨拶・書きかたの見本の後ろ2つ・紹介のページへのリンク・canonical と OGP の URL。
 */
export function renderApp(html, now, base) {
  const s = season(now);
  let out = html.replace('<span id="hero-greet">こんにちは</span>',
    `<span id="hero-greet">${h(greeting(now))}</span>`);
  const chips = s.examples.slice(0, 2).map(([label, text]) =>
    `<button type="button" class="md-chip md-chip--assist md-state" data-example="${h(text)}">${h(label)}</button>`).join("");
  out = out.replace(/(<div class="chip-set note-examples"[^>]*>)([\s\S]*?)(<\/div>)/, (_, open, inner, close) => {
    const keep = (inner.match(/<button\b[\s\S]*?<\/button>/g) ?? []).slice(0, 2).join("");
    return open + keep + chips + close;
  });
  out = out.replace('href="about.html">旅さきについて（使いかたと組んだ例）', 'href="./">旅さきについて（使いかたと組んだ例）');
  out = out.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${h(base)}app$2`);
  out = out.replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${h(base)}app$2`);
  return out;
}

let cache = null;

/** ひな形とデータを、静的ファイル（ASSETS）から読みます。Worker が生きているあいだは使い回します。 */
async function load(env, origin) {
  if (cache) return cache;
  const get = async (path) => {
    const res = await env.ASSETS.fetch(new Request(`${origin}${path}`));
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res;
  };
  const [tpl, data] = await Promise.all([
    get(`${SITE_DIR}landing.html`).then((r) => r.text()),
    get("/data/areas.json").then((r) => r.json()),
  ]);
  cache = { tpl, data };
  return cache;
}

/** テストから、読んだものを捨てるため。 */
export function resetLandingCache() { cache = null; }

const pageHeaders = (extra = {}) => ({
  "Content-Type": "text/html; charset=utf-8",
  // 挨拶が時刻で変わるので、長くは持たせません。
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  ...extra,
});

/**
 * Worker が受け持つページなら Response を、そうでなければ null を返します。
 *   /           … トップ（前のトップあての /?p=… は /app へ渡す）
 *   /app        … チャットの画面（/index.html も同じ）
 *   /__site/... … ひな形の置き場。直には見せません
 */
export async function servePage(request, env, now = new Date()) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith(SITE_DIR) || path === SITE_DIR.slice(0, -1)) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const base = `${SITE_ORIGIN}/`;
  if (path === "/" || path === "/index.php") {
    if (url.searchParams.has("p")) {
      return Response.redirect(`${url.origin}/app${url.search}`, 302);
    }
    try {
      const { tpl, data } = await load(env, url.origin);
      const html = renderTpl(tpl, landingView(now, data, base, "Cloudflare Worker"));
      return new Response(request.method === "HEAD" ? null : html,
        { headers: pageHeaders({ "Content-Security-Policy": LANDING_CSP }) });
    } catch {
      // ひな形が無い組み立て（古い版など）では、チャットの画面を出します。
      return env.ASSETS.fetch(new Request(`${url.origin}/`));
    }
  }
  // /app/ のままだと、画面の部品（css/・js/ への相対の道）が /app/css/… を
  // 探して見つからず、画面が崩れます。/app へ移ってもらいます。
  if (path === "/app/") {
    return Response.redirect(`${url.origin}/app${url.search}`, 301);
  }
  // /index.html も、チャットの画面です（ホーム画面に置いたアプリが開く場所）。
  // 静的ファイルの側では「/」が index.html なので、それを取ってきます。
  if (path === "/app" || path === "/index.html") {
    const res = await env.ASSETS.fetch(new Request(`${url.origin}/`));
    if (!res.ok) return res;
    const html = renderApp(await res.text(), now, base);
    return new Response(request.method === "HEAD" ? null : html, { headers: pageHeaders() });
  }
  return null;
}
