import { ADMIN_ASSET_DIR, isAdminPath, serveAdmin } from "./admin.js";
import { currentSettings, record, Stats, SWITCHABLE } from "./stats.js";
import { cleanExtra } from "../js/metrics.js";
import { servePage } from "./landing.js";
import { providerStatus, transitHandler, TransitError } from "./transit.js";

// 管理画面の件数・設定の置き場（Durable Object）。wrangler.jsonc の STATS。
export { Stats };

// 呼び出しを許すページの出どころ。
//
// 2026-10-22 から、サイトはこの Worker 自身が配っています（同じ出どころ
// なので、下の一覧に無くても通ります）。github.io は、引っ越す前のページを
// 開いたままの人のために残しています。
//
// Worker の変数 ALLOW_ORIGIN で上書きできます（カンマ区切りで複数）。
// ここを直に書き換えると、公開先を増やすたびに Worker を作り直すことに
// なります。手元で開発するときは、次のように足してください。
//
//   npx wrangler secret put ALLOW_ORIGIN
//   https://shitianliang1000-alt.github.io,http://localhost:8000
const DEFAULT_ALLOW_ORIGIN = "https://shitianliang1000-alt.github.io";

// このサイト自身の置き場（InfinityFree の PHP 版）。ALLOW_ORIGIN を Cloudflare
// 側で設定していても、ここは常に通します（足し忘れで、AI・電車・バスが
// 「このサイトからは呼べません」になるのを防ぎます）。
const OWN_ORIGINS = ["https://tabisaki.site.je", "http://tabisaki.site.je",
  // 携帯アプリ（mobile/。Capacitor）の画面の出どころ。mobile/capacitor.config.json
  // の server.hostname と同じ名前です（Android は https://、iOS は capacitor://）。
  "https://app.tabisaki", "capacitor://app.tabisaki"];

function allowList(env) {
  const raw = String(env?.ALLOW_ORIGIN ?? "").trim();
  const list = (raw || DEFAULT_ALLOW_ORIGIN).split(/[,\s]+/).filter(Boolean);
  return [...new Set([...list, ...OWN_ORIGINS])];
}
// 重み付きの回数制限。
//
// 回数だけで数えると、/status を20回叩くのと Gemini を20回叩くのが
// 同じ扱いになります。後ろにあるものの重さが違うので、**点**で数えます。
//
//   /status      0点  こちらで完結します
//   Yahoo!       1点  取りに行きますが、**無料です**
//   Routes API   3点  Googleの従量課金
//   Gemini       5点  1日14,400回の枠を分け合います
//   Workers AI   5点  1日10,000ニューロンの枠
//
// 数える枠は**2つに分けます**。以前は全部を1分20点の1つの枠で数えて
// いました。ところが旅程1本で電車・バスを30区間ほど聞くので、1分20点は
// 最初の1本の途中で尽きます。無料のYahoo!が、お金のかかるGeminiと
// 同じ枠を奪い合っていたわけで、これは数えかたの誤りでした。
//
//   free … Yahoo!路線情報。こちらの費用はゼロなので、大きく取ります。
//          上限は「取り違えて無限に呼んでしまったとき」の歯止めだけです。
//   paid … Gemini・Routes・Workers AI。使い切るとその日は誰も使えない
//          ので、ここは絞ったままにします。
//
// どちらも Worker の環境変数で変えられます（RATE_FREE_PER_MINUTE など）。
// RATE_LIMIT に off を入れると、数えるのをやめます。
const COST = {
  "/status": 0,
  "/yahoo/transit": 1,
  // 乗り換え検索（server/transit.js）。有料の API は、その会社との
  // 契約の回数で止まります。ここは取り違えたときの歯止めだけです。
  "/transit": 1,
  "/transit/providers": 0,
  "/routes": 3,
  "/gemini/generate": 5,
  "/gemini/embed": 1,
  // 使えるモデルの一覧。取りに行くだけで、生成はしません。
  "/gemini/models": 1,
  "/cf/generate": 5,
  // ネット検索（Gemma に渡す下調べ）。Wikipedia なら無料、Tavily でも
  // 月1,000回までは無料なので、軽く数えます。
  //
  // paid 側で数えるのは、検索した質問では Gemma をもう1回呼ぶからです。
  // 検索した質問1つ = 生成5 + 検索1 + 生成5 = 11点、しない質問は5点。
  // 1分60点・1時間400点なら、検索した質問は1分に5つ・1時間に36まで
  // 続けて聞けます（tests/websearch.test.js で数えています）。1人の
  // 相談には足ります。点の大半は Gemma の2回目なので、検索だけを別の
  // 枠に出しても、空く点は1点だけです。
  "/web/search": 1,
  // 使われかたの件数（js/metrics.js）。外へは取りに行きません。
  "/metrics": 1,
};

/** その入口が、どちらの枠か。 */
const POOL = {
  "/yahoo/transit": "free",
  "/transit": "free",
  "/transit/providers": "free",
  "/metrics": "free",
};

export const LIMITS = {
  free: { minute: 600, hour: 6000 },
  paid: { minute: 60, hour: 400 },
};

/**
 * 環境変数があれば、そちらを使います。管理画面で上限を決めてあれば
 * （server/stats.js の settings.limits）、それがいちばん先です。
 */
export function limitsFrom(env, settings = null) {
  const n = (v, fallback) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : fallback;
  };
  const set = settings?.limits ?? {};
  return {
    free: {
      minute: n(set.free?.minute, n(env?.RATE_FREE_PER_MINUTE, LIMITS.free.minute)),
      hour: n(set.free?.hour, n(env?.RATE_FREE_PER_HOUR, LIMITS.free.hour)),
    },
    paid: {
      minute: n(set.paid?.minute, n(env?.RATE_PAID_PER_MINUTE, LIMITS.paid.minute)),
      hour: n(set.paid?.hour, n(env?.RATE_PAID_PER_HOUR, LIMITS.paid.hour)),
    },
  };
}

const MAX_BODY = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
// AI の生成だけは長く待ちます。Gemma 4 は考える時間が長く、混んでいると
// 30秒を超えることがあります（504 になっていた）。Workers は上流の返事を
// 待つあいだの時間（CPU 時間ではない）に上限がないので、2分まで待ちます。
const AI_TIMEOUT_MS = 120_000;
const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
// 検索結果のページを読みます。印刷用（/search/print）は1本しか載って
// いません。Yahoo!は候補を3本出す（早い順・安い順・乗換の少ない順）ので、
// 全部読んで、選べるようにします。
const YAHOO_TRANSIT_URL = "https://transit.yahoo.co.jp/search/result";
// 中継が通すモデル。ここに無いものは 400 で返します（高いモデルを
// 勝手に呼ばれないため）。
// Cloudflare の Workers AI で動かすモデル。**Googleのキーは要りません。**
// 中継（このWorker）の中で走ります。E2B は Workers AI には無いので、
// Gemma 4 のうち配信されているものを使います。
const ALLOWED_CF_MODELS = new Set([
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/zai-org/glm-4.7-flash",
]);

// Gemini は通しません（Gemma だけ）。Gemini は Gemma と同じキーでも
// 1分あたりの枠（TPM）が別で、料金もかかります。画面の側も Gemma しか
// 呼びませんが、中継でも止めておきます。埋め込み（gemini-embedding-001）も
// 使わないので外しました（検索は語句検索で行います）。
const ALLOWED_MODELS = new Set([
  "gemma-4-e2b-it", "gemma-4-26b-a4b-it", "gemma-4-31b-it",
  "gemma-3-27b-it", "gemma-3-12b-it", "gemma-3-4b-it",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 管理画面（合言葉つき）。中継の入口とは別の道です（server/admin.js）。
    if (isAdminPath(url.pathname)) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      return serveAdmin(request, env, {
        onBadPassword: () => rateCheck(env, ip, 5, "paid"),
        overview: () => overviewFor(env, url.origin),
      });
    }
    // 管理画面のファイルの置き場は、直には見せません（合言葉は上で聞きます）。
    if (url.pathname.startsWith(ADMIN_ASSET_DIR) || url.pathname === ADMIN_ASSET_DIR.slice(0, -1)) {
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    // トップ（/）とチャットの画面（/app）は、開いたときに作ります（server/landing.js）。
    if (env?.ASSETS) {
      const page = await servePage(request, env);
      if (page) return page;
    }
    // サイトのページ（GET）。ふつうは Cloudflare がこの Worker を通さずに
    // 静的ファイルを返します。ここに来るのは、無いファイルを開いたときです。
    if ((request.method === "GET" || request.method === "HEAD") && env?.ASSETS) {
      return withNotFoundPage(request, env, await env.ASSETS.fetch(request));
    }
    const res = await relay(request, env, ctx);
    // 使われかたを数えます（server/stats.js）。返事は待たせません。
    if (request.method === "POST") {
      const work = record(env, usageOf(request, url, res.status));
      if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
    }
    return res;
  },
};

/**
 * 無いページを開いた人には、空の 404 ではなく 404.html（エリアの一覧などへの
 * 道があるページ）を見せます。状態は 404 のままです（検索に載らないように）。
 * 画像や JS など、ページでないものは、そのまま返します。
 * wrangler.jsonc の not_found_handling は "none" のままにしています。
 * 変えると、中継の入口（POST）まで静的ファイルの側で止まりかねないからです。
 */
export async function withNotFoundPage(request, env, res) {
  if (res.status !== 404) return res;
  const accept = request.headers.get("Accept") ?? "";
  if (!accept.includes("text/html")) return res;
  // html_handling が auto-trailing-slash なので、/404.html は /404 へ回されます。先に /404 を見ます。
  let page = await env.ASSETS.fetch(new Request(new URL("/404", request.url)));
  if (!page.ok) page = await env.ASSETS.fetch(new Request(new URL("/404.html", request.url)));
  if (!page.ok) return res;
  return new Response(request.method === "HEAD" ? null : page.body, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300",
               "X-Content-Type-Options": "nosniff" },
  });
}

/** その入口の名前（数えるとき・止めるときの鍵）。 */
export function endpointOf(path) {
  return [...SWITCHABLE, "/status"].find((p) => path.endsWith(p)) ?? "other";
}

/**
 * 1回の呼び出しで数えるもの。IP は Stats がその日の塩でハッシュにして
 * 捨てます（保存しません）。国は Cloudflare の国コードだけです。
 */
export function usageOf(request, url, status) {
  const path = endpointOf(url.pathname.replace(/\/+$/, ""));
  const items = [["req", path, 1], ["country", request.cf?.country ?? "??", 1]];
  if (status >= 400) items.push(["status", `${path} ${status}`, 1]);
  return {
    ip: request.headers.get("CF-Connecting-IP") ?? "",
    items,
    ...(status >= 500 ? { error: { code: `HTTP ${status}`, path, detail: "中継の返事" } } : {}),
  };
}

/** 管理画面の「設定」に出すもの。鍵は、入っているかどうかだけです。 */
async function overviewFor(env, selfOrigin) {
  const settings = await currentSettings(env);
  return {
    secrets: {
      GEMINI_API_KEY: hasSecret(env, "GEMINI_API_KEY"),
      MAPS_API_KEY: hasSecret(env, "MAPS_API_KEY"),
      GITHUB_TOKEN: hasSecret(env, "GITHUB_TOKEN"),
      TAVILY_API_KEY: hasSecret(env, "TAVILY_API_KEY"),
    },
    bindings: {
      AI: Boolean(env?.AI), RATE: Boolean(env?.RATE),
      STATS: Boolean(env?.STATS), METRICS: Boolean(env?.METRICS),
    },
    allowOrigin: [...allowList(env), selfOrigin],
    rateLimit: String(env?.RATE_LIMIT ?? "").toLowerCase() === "off" ? "off" : "on",
    limitsDefault: limitsFrom(env),
    limits: limitsFrom(env, settings),
    settings,
    switchable: SWITCHABLE,
  };
}

async function relay(request, env, ctx) {
  {
    const origin = request.headers.get("Origin") ?? "";
    // この Worker 自身が配る管理画面からの「接続を確かめる」も通します。
    const allow = [...allowList(env), new URL(request.url).origin];
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin, allow);
    if (request.method !== "POST") return cors(text("POST のみです", 405), origin, allow);
    if (!allow.includes("*") && !allow.includes(origin)) {
      // 断るときも、返事は読めるようにします。CORSの見出しを付けないと、
      // ブラウザは中身を捨てて「Load failed」とだけ言います。何が起きたか
      // 分からないまま「中継の設定を確認してください」と出ていました。
      // 中身は断り文句だけなので、出どころをそのまま返して差し支えありません。
      return cors(text(`このサイト（${origin || "出どころ不明"}）からは呼べません。`
        + "Worker の ALLOW_ORIGIN に、このアドレスを足してください", 403),
        origin, ["*"]);
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    // 重さに応じて数えます（Geminiの1回と /status の1回は別ものです）。
    // 枠は2つ。無料のYahoo!が、お金のかかるGeminiの枠を食べません。
    // 管理画面で止めた入口は、外へ取りに行く前に断ります。
    const settings = await currentSettings(env);
    if (settings.disabled.includes(endpointOf(path))) {
      return cors(fail(503, "DISABLED",
        "この機能はいま止めています。しばらくしてから、もう一度お試しください。",
        { retryable: false }), origin, allow);
    }
    const gate = await rateCheck(env, ip, costOf(path), poolOf(path), settings);
    if (!gate.ok) {
      return cors(fail(429, "RATE_LIMITED",
        "いま利用が集中しています。1分ほどおいてから、もう一度お試しください。",
        { retryable: true, retryAfter: gate.retryAfter,
          headers: { "Retry-After": String(gate.retryAfter) } }), origin, allow);
    }
    const declared = Number(request.headers.get("Content-Length") ?? 0);
    if (declared > MAX_BODY) return cors(text("本文が大きすぎます", 413), origin, allow);
    try {
      if (path.endsWith("/gemini/generate")) return cors(await gemini(request, env, "generateContent"), origin, allow);
      if (path.endsWith("/gemini/embed")) return cors(await gemini(request, env, "embedContent"), origin, allow);
      if (path.endsWith("/gemini/models")) return cors(await geminiModels(env), origin, allow);
      if (path.endsWith("/routes")) return cors(await routes(request, env), origin, allow);
      if (path.endsWith("/cf/generate")) return cors(await cfGenerate(request, env), origin, allow);
      if (path.endsWith("/yahoo/transit")) return cors(await yahooTransit(request), origin, allow);
      // どの乗り換え検索が使えるか（キーの値は返しません）。
      if (path.endsWith("/transit/providers")) return cors(json(providerStatus(env)), origin, allow);
      if (path.endsWith("/transit")) return cors(await transit(request, env, settings), origin, allow);
      if (path.endsWith("/metrics")) return cors(await metrics(request, env), origin, allow);
      if (path.endsWith("/web/search")) return cors(await webSearch(request, env, ctx), origin, allow);
      // 鍵が入っているかどうかだけを答えます（値は返しません）。
      // 「キーが無効です」と「中継に鍵が置かれていない」は別のことで、
      // 直す場所も違います。画面がそれを言い分けられるようにします。
      if (path.endsWith("/status")) {
        return cors(json({
          ok: true,
          secrets: {
            MAPS_API_KEY: hasSecret(env, "MAPS_API_KEY"),
            GEMINI_API_KEY: hasSecret(env, "GEMINI_API_KEY"),
            EKISPERT_API_KEY: hasSecret(env, "EKISPERT_API_KEY"),
            NAVITIME_RAPIDAPI_KEY: hasSecret(env, "NAVITIME_RAPIDAPI_KEY"),
            HERE_API_KEY: hasSecret(env, "HERE_API_KEY"),
          },
          // 乗り換え検索の順番と、使えるもの（server/transit.js）。
          transit: providerStatus(env),
          // Workers AI が使えるなら、AIのキーは要りません。
          workersAi: Boolean(env.AI),
          allowOrigin: allow,
          // あと何点使えるか。無料枠は使い切ると**その日は誰も使えません**。
          // 止まってから気づくのでは遅いので、先に見えるようにします。
          usage: await rateUsage(env, ip, settings),
          // 管理画面で止めている入口。アプリはこれを見て、先に断れます。
          disabled: settings.disabled,
        }), origin, allow);
      }
    } catch (e) {
      console.error(e);
      if (e?.code === "TOO_LARGE") return cors(text("本文が大きすぎます", 413), origin, allow);
      if (e?.code === "BAD_BODY") return cors(text("本文を読めません", 400), origin, allow);
      const timedOut = e?.name === "AbortError" || e?.name === "TimeoutError";
      return cors(text(timedOut ? "上流の応答がありませんでした" : "処理できませんでした", timedOut ? 504 : 502), origin, allow);
    }
    return cors(text("その入口はありません", 404), origin, allow);
  }
}

// 使われかたの件数（js/metrics.js から sendBeacon で届きます）。
//
// 受け取るのは、決まった出来事の名前と、決まった言葉の補足だけです。
// それ以外の文字列は、ここでも捨てます（ブラウザ側の絞り込みを
// 信じません。誰でもこの入口を叩けるためです）。
//
// **IP も、届いた時刻以外の何も、残しません。** Workers Analytics Engine
// に「出来事・補足・1件」を書くだけです。件数は Cloudflare の管理画面か
// SQL API で見ます（server/README.md）。
//
// METRICS のバインディングが無い中継（wrangler.jsonc に書いていない、
// 手元の node-proxy など）では、受け取って何もしません。
export const METRIC_EVENTS = new Set([
  "plan_ok", "plan_error", "offline_seen", "spot_replace", "spot_remove",
]);
export const METRIC_DETAILS = new Set([
  "transit", "car", "transit+car", "walk",
  "plan", "offline", "network", "kb", "quota",
]);

export async function metrics(request, env) {
  let body;
  try { body = await readJson(request); } catch { return text("数えられない形です", 400); }
  const event = String(body?.e ?? "");
  if (!METRIC_EVENTS.has(event)) return text("その出来事は数えません", 400);
  const detail = METRIC_DETAILS.has(String(body?.d ?? "")) ? String(body.d) : "";
  try {
    env?.METRICS?.writeDataPoint?.({
      indexes: [event],
      blobs: [event, detail],
      doubles: [1],
    });
  } catch (e) {
    // 数えそこねても、使う人には関係ありません。
    console.error(e);
  }
  // 管理画面のための件数（server/stats.js）。決まった言葉と数だけです。
  await record(env, metricRecord(event, detail, cleanExtra(body)));
  return new Response(null, { status: 204 });
}

/** かかった秒を、見比べやすい幅に分けます。 */
export function secsBucket(s) {
  return s < 10 ? "0-10" : s < 30 ? "10-30" : s < 60 ? "30-60" : s < 120 ? "60-120" : "120+";
}

/** 1件の出来事から、Stats に足す件数を作ります。 */
export function metricRecord(event, detail, extra = {}) {
  const items = [["event", `${event}|${detail}`, 1]];
  if (Number.isFinite(extra.s)) {
    items.push(["secs", `${event}:${secsBucket(extra.s)}`, 1],
               ["sum", `secs:${event}`, extra.s], ["sum", `n:${event}`, 1]);
  }
  if (Number.isFinite(extra.r)) {
    items.push(["rounds", String(extra.r), 1],
               ["sum", "rounds", extra.r], ["sum", "rounds_n", 1]);
  }
  for (const [k, v] of Object.entries(extra.c ?? {})) {
    for (const one of Array.isArray(v) ? v : [v]) items.push(["cond", `${event}:${k}=${one}`, 1]);
  }
  return {
    items,
    ...(event === "plan_error"
      ? { error: { code: "旅程を組めなかった", detail: detail || "理由不明", path: "app" } }
      : {}),
  };
}

// --- ネット検索 -------------------------------------------------------
//
// Gemma は Google 検索の道具（google_search）を受け取りません。そこで、
// 検索はこの中継が代わりにして、短い抜き書きだけを Gemma に渡します。
//
//   TAVILY_API_KEY があれば … Tavily（ふつうのウェブ検索。月1,000回まで無料、
//                              カード登録なし。https://app.tavily.com）
//   無ければ               … 日本語版 Wikipedia の検索（キー不要・無料）
//
// 枠（TPM）が少ないので、返すのは3件・1件あたり200字までです。
// 同じ語は1日のあいだ覚えておき、取りに行きません。
const WEB_RESULTS = 3;
const WEB_SNIPPET = 200;
const WEB_QUERY_MAX = 80;
const WIKI_API = "https://ja.wikipedia.org/w/api.php";
const TAVILY_URL = "https://api.tavily.com/search";

/** 検索の抜き書きを、渡せる形に整えます（タグ・空白を落とし、字数を切る）。 */
export function cleanSnippet(s, max = WEB_SNIPPET) {
  // < と > で切り、その内側（タグ）を捨てます。< と > は1つも残りません
  // （&lt;script のようなものも、戻さずに消します）。&amp; は最後に戻します。
  const t = String(s ?? "").split(/[<>]/).filter((_, i) => i % 2 === 0).join("")
    .replace(/&lt;|&gt;/g, " ")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Wikipedia の返事を {title, url, snippet} に。 */
export function wikiResults(data) {
  return (data?.query?.search ?? []).slice(0, WEB_RESULTS).map((r) => ({
    title: cleanSnippet(r.title, 80),
    url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
    snippet: cleanSnippet(r.snippet),
  }));
}

/** Tavily の返事を {title, url, snippet} に。https のものだけ。 */
export function tavilyResults(data) {
  return (data?.results ?? [])
    .filter((r) => /^https:\/\//i.test(String(r?.url ?? "")))
    .slice(0, WEB_RESULTS)
    // Tavily の本文はタグの無い文なので、< と > は字として消すだけにします
    // （タグとして切ると、「A > B」の後ろが消えます）。
    .map((r) => ({ title: cleanSnippet(plain(r.title || r.url), 80), url: String(r.url),
                   snippet: cleanSnippet(plain(r.content)) }));
}

function plain(s) {
  return String(s ?? "").replace(/[<>]/g, " ");
}

async function webSearch(request, env, ctx) {
  const body = await readJson(request);
  const q = cleanSnippet(body?.q, WEB_QUERY_MAX).replace(/…$/, "");
  if (!q) return text("検索語がありません", 400);
  const want = hasSecret(env, "TAVILY_API_KEY") ? "tavily" : "wikipedia";
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const keyOf = (engine) => new Request(`https://web.search/${engine}?q=${encodeURIComponent(q)}`);
  const hit = cache ? await cache.match(keyOf(want)) : null;
  if (hit) return new Response(hit.body, { headers: { "Content-Type": "application/json" } });

  // Tavily の無料枠（月1,000回）は、使う人全員で1つです。人ごとの枠
  // （/web/search は paid 側で1点）では守れないので、使い切った・断られた・
  // 落ちているときは、Wikipedia に切り替えて答えます。
  let engine = want;
  let res = null;
  if (want === "tavily") {
    res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query: q, max_results: WEB_RESULTS, search_depth: "basic",
                             include_answer: false, include_images: false }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }).catch(() => null);
    if (!res?.ok) { engine = "wikipedia"; res = null; }
  }
  if (!res) {
    const u = new URL(WIKI_API);
    for (const [k, v] of Object.entries({ action: "query", list: "search", srsearch: q,
      srlimit: String(WEB_RESULTS), format: "json", utf8: "1", origin: "*" })) u.searchParams.set(k, v);
    res = await fetch(u, {
      // Wikimedia は、名乗らない呼び出しを断ることがあります。
      headers: { "User-Agent": "tabisaki/1.0 (https://tabisaki-github-io.shitianliang1000.workers.dev/)" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  }
  if (!res.ok) return passthrough(res, engine);
  const data = await res.json();
  const out = JSON.stringify({ ok: true, engine, q,
    results: engine === "tavily" ? tavilyResults(data) : wikiResults(data) });
  const resp = new Response(out, { headers: { "Content-Type": "application/json",
                                               "Cache-Control": "max-age=86400" } });
  // 切り替えたときの答えは、覚えておきません（Tavily が戻れば、そちらで聞き直します）。
  if (cache && engine === want) {
    const put = cache.put(keyOf(engine), resp.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put); else await put;
  }
  return resp;
}

/** 鍵が入っているか（値は見せません）。 */
function hasSecret(env, name) {
  return typeof env?.[name] === "string" && env[name].trim().length > 0;
}

/** 鍵が無いときの返事。無ければ null。 */
function missingSecret(env, name) {
  if (hasSecret(env, name)) return null;
  return text(`中継に ${name} が設定されていません。`
    + "Cloudflare のダッシュボードで、Workers & Pages → この Worker → "
    + `上の「Bindings」タブ → Add → Secret として ${name} を足してください`
    + "（Settings → Builds の欄ではありません。あちらはビルド中だけの値で、"
    + "動いている Worker からは見えません）。"
    + `コマンドなら \`npx wrangler secret put ${name}\` です`, 503);
}

/**
 * Cloudflare の Workers AI で答えさせます。
 *
 * Googleのキーは要りません。Cloudflare のアカウントの中で走るので、
 * 鍵を置き忘れて「API key not valid」になることもありません。
 * かわりに、wrangler.jsonc の ai バインディングが要ります。
 */
async function cfGenerate(request, env) {
  if (!env.AI) {
    return text("この中継では Workers AI が有効になっていません。"
      + "wrangler.jsonc の \"ai\" バインディングを入れて配備し直してください", 503);
  }
  const body = await readJson(request);
  const model = String(body?.model ?? "");
  if (!ALLOWED_CF_MODELS.has(model)) return text("そのモデルは使えません", 400);
  const messages = Array.isArray(body?.messages) ? body.messages.slice(0, 8) : null;
  if (!messages?.length) return text("messages が要ります", 400);
  const temperature = Number.isFinite(body?.temperature) ? body.temperature : 0.4;
  const maxTokens = Math.min(4096, Number(body?.max_tokens) || 2048);

  // モデルによって受け取る形が違います。messages で駄目なら prompt で。
  let out;
  let firstError = null;
  try {
    out = await env.AI.run(model, { messages, temperature, max_tokens: maxTokens });
  } catch (e) {
    firstError = e;
    try {
      out = await env.AI.run(model, {
        prompt: messages.map((m) => String(m?.content ?? "")).join("\n\n"),
        temperature, max_tokens: maxTokens,
      });
    } catch (e2) {
      // 「処理できませんでした」では、直しようがありません。上流の言い分を
      // そのまま渡します。
      return text(`Workers AI（${model}）: `
        + String(e2?.message ?? firstError?.message ?? e2).slice(0, 300), 502);
    }
  }

  const answer = cfText(out);
  if (!answer) {
    // 返事の入れ物はモデルによって違います。空だったときは、どの鍵が
    // 来ているかだけ返します（中身は返しません）。次の一手が決まります。
    return json({ text: "", shape: Object.keys(out ?? {}).slice(0, 12) });
  }
  return json({ text: answer });
}

/**
 * Workers AI の返事から本文を取り出します。
 *
 * 入れ物がモデルによって違います（response / result.response /
 * choices[].message.content / output[].content[].text）。1つだけを見ていて、
 * Gemma 4 が空で返ってきました。順に当たり、どれも無ければ木をたどります。
 */
export function cfText(out) {
  if (typeof out === "string") return out.trim();
  const direct = [
    out?.response,
    out?.result?.response,
    out?.output_text,
    out?.choices?.[0]?.message?.content,
    out?.choices?.[0]?.text,
  ];
  for (const c of direct) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  const parts = [];
  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (typeof node === "string") { parts.push(node); return; }
    if (Array.isArray(node)) { for (const x of node) walk(x, depth + 1); return; }
    if (typeof node === "object") {
      if (typeof node.text === "string") { parts.push(node.text); return; }
      for (const key of ["content", "output", "message", "delta"]) {
        if (node[key]) walk(node[key], depth + 1);
      }
    }
  };
  walk(out?.output ?? out?.result ?? out?.content ?? null);
  return parts.join("").trim();
}

async function gemini(request, env, method) {
  const missing = missingSecret(env, "GEMINI_API_KEY");
  if (missing) return missing;
  const body = await readJson(request);
  const model = String(body?.model ?? "");
  if (!ALLOWED_MODELS.has(model)) return text("そのモデルは使えません", 400);
  const { model: _drop, ...payload } = body;
  const res = await fetch(`${GEMINI_ROOT}/models/${encodeURIComponent(model)}:${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(method === "generateContent" ? AI_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS),
  });
  return passthrough(res, "gemini");
}

/**
 * このキーで使えるモデルの一覧。
 *
 * なぜ要るか
 * ----------
 * 設定したモデルが404で返ると、画面にはこう出ていました。
 *
 *   models/gemma-3-12b-it is not found for API version v1beta, or is
 *   not supported for generateContent.
 *
 * 英語のうえ、**では何なら使えるのか**が書いてありません。Google 自身が
 * 「ListModels を呼べ」と言っているので、呼びます。返すのは名前だけです
 * （鍵も、説明も、割り当ても返しません）。
 *
 * 生成しないので、数えかたは1点です。
 */
async function geminiModels(env) {
  const missing = missingSecret(env, "GEMINI_API_KEY");
  if (missing) return missing;
  const res = await fetch(`${GEMINI_ROOT}/models?pageSize=200`, {
    headers: { "x-goog-api-key": env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) return passthrough(res, "gemini");
  const doc = await res.json().catch(() => null);
  const list = Array.isArray(doc?.models) ? doc.models : [];
  // 文を作れるものだけ。埋め込み専用のモデルを候補に出すと、
  // 選んだ先でまた失敗します。
  const names = list
    .filter((m) => Array.isArray(m?.supportedGenerationMethods)
      && m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => String(m?.name ?? "").replace(/^models\//, ""))
    // 通すのは Gemma だけなので、一覧も Gemma だけにします。
    .filter((n) => /gemma/i.test(n));
  return json({ models: names });
}

/**
 * 乗り換え検索（POST /transit）。どの API で引くかは server/transit.js が
 * 決めます。Yahoo!路線情報だけはこのファイルにあるので、ここから渡します。
 */
async function transit(request, env, settings = null) {
  const body = await readJson(request);
  // 管理画面で /yahoo/transit を止めていたら、自動の順番からも外します。
  if (settings?.disabled?.includes("/yahoo/transit")) env = { ...env, YAHOO_TRANSIT: "off" };
  const yahoo = async (q) => {
    const res = await yahooTransit(new Request("https://transit.invalid/yahoo/transit", {
      method: "POST",
      body: JSON.stringify({
        from: q.from, to: q.to, fromAt: q.fromAt, toAt: q.toAt,
        departAt: q.at.toISOString(), search: q.search, modes: q.modes, prefer: q.prefer,
      }),
    }));
    if (res.status === 429) throw new TransitError("rate_limited", "Yahoo!路線情報から断られています", { status: 429, retryable: true });
    if (!res.ok) throw new TransitError("upstream", `Yahoo!路線情報が ${res.status} でした`, { retryable: res.status >= 500 });
    return res.json();
  };
  try {
    return json(await transitHandler(body, env, { yahoo }));
  } catch (e) {
    if (!(e instanceof TransitError)) throw e;
    return fail(e.status, e.code.toUpperCase(), e.message,
      { service: "transit", retryable: e.retryable,
        ...(e.status === 429 ? { retryAfter: 60, headers: { "Retry-After": "60" } } : {}) });
  }
}

async function yahooTransit(request) {
  const body = await readJson(request);
  const from = String(body?.from ?? "").trim();
  const to = String(body?.to ?? "").trim();
  if (!from || !to || from.length > 100 || to.length > 100) return text("出発地と到着地が必要です", 400);

  const requested = body?.departAt ? new Date(body.departAt) : new Date();
  if (Number.isNaN(requested.getTime())) return text("出発時刻が不正です", 400);

  const p = tokyoParts(requested);
  const u = new URL(YAHOO_TRANSIT_URL);
  u.searchParams.set("from", from);
  u.searchParams.set("to", to);
  // **場所は、名前ではなく位置で渡せます。**
  //
  // 名前だけで聞くと、Yahoo!が別の場所に読み替えます。実際に起きて
  // いたのは
  //
  //   「県庁前駅」（那覇・ゆいレール）→ 県庁前(兵庫県)。沖縄の旅の行きが
  //     東京→神戸の新幹線になり、飛行機の便が一度も出ませんでした。
  //   「京都駅前」（市バスの乗り場）→ 駅前の飲食店。バスに乗る経路が
  //     返りませんでした。
  //
  // 位置（flatlon / tlatlon）を渡すと、Yahoo!がその近くの駅・バス停を
  // 選び、そこまでの徒歩も含めて答えます（名前は表示用に使われます）。
  const at = (v) => {
    const lat = Number(v?.lat);
    const lng = Number(v?.lng);
    // 日本の範囲だけ受け付けます。おかしな値で上流を叩きません。
    if (!(lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154)) return "";
    return `${lat.toFixed(6)},${lng.toFixed(6)}`;
  };
  u.searchParams.set("flatlon", at(body?.fromAt));
  u.searchParams.set("tlatlon", at(body?.toAt));
  u.searchParams.set("y", p.year);
  u.searchParams.set("m", p.month);
  u.searchParams.set("d", p.day);
  u.searchParams.set("hh", p.hour);
  u.searchParams.set("m1", p.minute.slice(0, 1));
  u.searchParams.set("m2", p.minute.slice(1));
  // 何を調べるか。
  //
  //   depart（既定）… その時刻に出たら、次に乗れるのは何時か（type=1）
  //   last          … **その日の終電**（type=2）
  //
  // type の番号は、Yahoo!路線情報の検索欄そのものから読みました
  // （<input type="radio" name="type" value="2"><label>終電</label>）。
  // 実際に小田原→東京を type=2 で引くと、見出しが「終電」になり、
  // 22:58発・22:56発の候補が返ります。推測ではありません。
  //
  // 終電が要るのは、**帰れなくなる旅程を黙って出さない**ためです。
  // 「18:40発の電車で帰ります」と書いてあっても、その駅の終電が
  // 22:58だと分かってはじめて、立ち寄りを1つ増やせるかが決められます。
  // 逆に、組んだ帰りが終電より後なら、その旅程では帰れません。
  const search = body?.search === "last" ? "last" : "depart";
  u.searchParams.set("type", search === "last" ? "2" : "1");
  u.searchParams.set("ticket", "ic");
  u.searchParams.set("expkind", "1");
  u.searchParams.set("userpass", "1");
  u.searchParams.set("ws", "3");
  u.searchParams.set("s", "0");
  // どの乗り物を使ってよいか。
  //
  // ここは「全部1（使う）」の決め打ちでした。旗の意味は実測で
  // 確かめてあります（東京→那覇を al=1 で引くと4時間46分の空路、
  // al=0 で引くと33時間39分の陸と船）。つまり**切り替えは効くのに、
  // 切り替えていなかった**だけでした。
  //
  //   al=飛行機 / shin=新幹線 / ex=有料特急 / hb=高速バス /
  //   lb=路線バス / sr=船
  //
  // 画面で選ばれた乗り物に合わせて、呼ぶ側（packages/core/src/modes.js）が決めます。
  // 渡されなければ、これまでどおり全部使います。
  const flags = { al: 1, shin: 1, ex: 1, hb: 1, lb: 1, sr: 1 };
  const asked = body?.modes;
  if (asked && typeof asked === "object") {
    for (const k of Object.keys(flags)) {
      if (asked[k] === 0 || asked[k] === "0" || asked[k] === false) flags[k] = 0;
    }
  }
  for (const [k, v] of Object.entries(flags)) u.searchParams.set(k, String(v));

  // 同じ検索は、取りに行きません。
  //
  // 旅程1つで区間の数だけ聞きますし、条件を少し変えて何度も作り直します。
  // 同じ日・同じ区間なら答えも同じなので、そのたびにYahoo!へ行くのは
  // 相手にも失礼で、断られる（429）もとになります。1時間置きます。
  const cacheKey = new Request(u.toString(), { method: "GET" });
  const cache = globalThis.caches?.default;
  const cached = await cache?.match(cacheKey);
  const res = cached ?? await fetch(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TabisakiTransit/1.0)",
      "Accept-Language": "ja-JP,ja;q=0.9",
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    // 断られたのがYahoo!なのか、こちらの回数制限なのかが分かるように
    // 書きます。同じ「429」でも、待つ先が違います。
    if (res.status === 429) {
      return text("Yahoo!路線情報から一時的に断られています（429）。"
        + "少し時間をおくと戻ります。それまでは、駅の位置からの目安で"
        + "組み立てます。", 429, { "Retry-After": "60" });
    }
    return text(`Yahoo Transit ${res.status}`, 502);
  }

  const html = await res.text();
  if (!cached && cache) {
    // 本文はもう読んでしまったので、控えは作り直して入れます。
    await cache.put(cacheKey, new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8",
                 "Cache-Control": "max-age=3600" },
    }));
  }
  const requestedMinutes = tokyoClockMinutes(requested);

  // 候補は全部読みます。1本目だけを見ていたときは、Yahoo!が「早い順」で
  // 並べた1本しか使えませんでした。
  const routes = [];
  for (const block of routeBlocks(html)) {
    const summary = parseSummary(block);
    const detail = parseRouteDetail(block);
    const departure = summary.departure ?? detail.departure;
    const arrival = summary.arrival ?? detail.arrival;
    if (!departure || !arrival) continue;
    const rideMinutes = departure !== arrival
      ? clockDiff(departure, arrival)
      : (summary.minutes ?? 0);
    // 0分の経路は捨てます。旅程では「移動時間0分」が「隣にある」と
    // 同じ意味になり、行けない予定が組めてしまいます。
    if (!(rideMinutes > 0)) continue;
    const waitMinutes = (clockMinutes(departure) - requestedMinutes + 1440) % 1440;
    routes.push({
      minutes: waitMinutes + rideMinutes,
      rideMinutes, waitMinutes, departure, arrival,
      summary: summary.text,
      transfers: summary.transfers,
      fareYen: summary.fareYen,
      distanceKm: summary.distanceKm,
      legs: detail.legs,
      intermediateStops: detail.intermediateStops,
    });
  }

  if (!routes.length) {
    return json({ routed: false, url: u.toString(),
      reason: "Yahoo!路線情報から経路を取り出せませんでした" });
  }

  // 終電を聞いたときは、選びかたが違います。
  //
  // ふつうは「いちばん早く着くもの」ですが、終電で知りたいのは
  // **いちばん遅く出られるもの**です。小田原→東京では
  // 22:58→00:39（各駅）と 22:56→23:29（新幹線）が返り、早く着くのは
  // 新幹線ですが、最後まで粘れるのは 22:58 のほうです。
  //
  // 日付をまたぐ便があるので、午前4時より前の発車は「翌日」として
  // 数えます（終電は1時ごろまで、始発は4時半ごろから。あいだに
  // 発車はありません）。
  if (search === "last") {
    const late = (hm) => {
      const m = clockMinutes(hm);
      return m < 4 * 60 ? m + 1440 : m;
    };
    const best = routes.reduce((a, b) =>
      (late(a.departure) >= late(b.departure) ? a : b));
    return json({
      routed: true, search: "last",
      minutes: best.rideMinutes,
      rideMinutes: best.rideMinutes,
      waitMinutes: 0,
      summary: best.summary,
      kinds: routeKinds(best),
      preferMet: true,
      meta: {
        url: u.toString(),
        departure: best.departure,
        arrival: best.arrival,
        requestedDeparture: requested.toISOString(),
        transfers: best.transfers,
        fareYen: best.fareYen,
        distanceKm: best.distanceKm,
        legs: best.legs,
        intermediateStops: best.intermediateStops,
        alternatives: routes.filter((r) => r !== best).map((r) => ({
          departure: r.departure, arrival: r.arrival, minutes: r.minutes,
          rideMinutes: r.rideMinutes, transfers: r.transfers,
          fareYen: r.fareYen, distanceKm: r.distanceKm, summary: r.summary,
        })),
      },
    });
  }

  // 採るのは「その時刻に出て、いちばん早く着く」もの。乗車時間ではなく
  // **待ち時間を含めた着時刻**で選びます。始発待ちの長い速達より、
  // すぐ乗れる各駅のほうが早く着くことがあります。
  //
  // ただし**乗り物が指定されているときは、速さより指定が先**です。
  //
  //   「フェリーで佐渡へ」と書いた人に、いちばん早い経路を返しても
  //   意味がありません。船を使う候補が返っているのに、到着が遅いから
  //   採られない——それでは「フェリーで」と書けないのと同じです。
  //
  // 指定に合う候補があれば、そのなかでいちばん早いものを採ります。
  // 1つも無ければ、これまでどおり速い順です（無いものは作れません）。
  const prefer = Array.isArray(body?.prefer) ? body.prefer : [];
  const fits = prefer.length
    ? routes.filter((r) => routeKinds(r).some((k) => prefer.includes(k)))
    : [];
  const pool = fits.length ? fits : routes;
  const best = pool.reduce((a, b) => (a.minutes <= b.minutes ? a : b));

  return json({
    routed: true,
    search: "depart",
    // 位置で聞いたか（古い中継は名前だけで聞きます。呼ぶ側の見分け用）
    byLocation: Boolean(u.searchParams.get("flatlon") || u.searchParams.get("tlatlon")),
    minutes: best.minutes,
    rideMinutes: best.rideMinutes,
    waitMinutes: best.waitMinutes,
    summary: best.summary,
    // 採った経路に含まれる乗り物と、指定に合っていたか。
    // 画面は「フェリーで組みました」「船の便は見つかりませんでした」を
    // ここで言い分けます（黙って陸の経路を出すと、指定を無視した
    // ことに気づけません）。
    kinds: routeKinds(best),
    preferMet: prefer.length ? fits.length > 0 : true,
    meta: {
      url: u.toString(),
      departure: best.departure,
      arrival: best.arrival,
      requestedDeparture: requested.toISOString(),
      transfers: best.transfers,
      fareYen: best.fareYen,
      distanceKm: best.distanceKm,
      legs: best.legs,
      intermediateStops: best.intermediateStops,
      // 残りの候補。画面で「ほかの行き方」として出せます。
      alternatives: routes.filter((r) => r !== best).map((r) => ({
        departure: r.departure, arrival: r.arrival, minutes: r.minutes,
        rideMinutes: r.rideMinutes, transfers: r.transfers,
        fareYen: r.fareYen, distanceKm: r.distanceKm, summary: r.summary,
      })),
    },
  });
}

/** class に「その名前がそのまま入っている」li の中身。 */
function liWithClass(html, name) {
  // `class=[^"]*time` のような書き方は、`icnPriTime`（早・楽の印）にも
  // 当たります。実際そうなっていて、所要時間の行ではなく「早」の字を
  // 読んでいました。名前は区切って突き合わせます。
  const re = /<li[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1].split(/\s+/).includes(name)) return cleanText(m[2]);
  }
  return "";
}

/**
 * 経路に含まれる乗り物の種類。
 *
 * ここで見分けるのは、**指定できる乗り物だけ**です（飛行機と船）。
 * 呼び名を全部付け直すのは画面の仕事で、packages/core/src/modes.js が持っています。
 * 中継は Cloudflare Worker として単体で動くので js/ を読み込めず、
 * 同じ見分けかたを2か所に置くことになります。そこで**ここは必要最小限**に
 * 絞り、2つの表がずれたら試験（tests/modes.test.js）で落ちるように
 * してあります。
 *
 * 全角の英字で返ってくるので（ＡＮＡ・ＪＡＬ）、半角に直してから見ます。
 */
export function routeKinds(route) {
  const out = [];
  const lines = (route?.legs ?? []).map((l) => String(l?.line ?? ""));
  if (route?.summary) lines.push(String(route.summary));
  for (const raw of lines) {
    const s = raw.replace(/[Ａ-Ｚａ-ｚ０-９]/g,
      (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    if (/航空|エアライン|ANA|JAL|ADO|SKY|SFJ|APJ|JJP|IBX|FDA|ORC|AMX|RAC|SNA|JTA|AIRDO|ソラシド|スカイマーク|スターフライヤー|ジェットスター|ピーチ|春秋航空|\d+便/
      .test(s) && !out.includes("air")) out.push("air");
    if (/フェリー|汽船|海運|ジェットフォイル|高速船|水上バス|遊覧船|渡船|連絡船/
      .test(s) && !out.includes("ferry")) out.push("ferry");
  }
  return out;
}

export function parseSummary(html) {
  const box = html.match(/class=["'][^"']*routeSummary[^"']*["'][\s\S]{0,20000}/i)?.[0] ?? "";
  const time = liWithClass(box, "time");
  const transferText = liWithClass(box, "transfer");
  const fareText = liWithClass(box, "fare");
  const distanceText = liWithClass(box, "distance");
  const transfers = Number(transferText.match(/(\d+)/)?.[1] ?? 0);
  const fareYen = Number((fareText.match(/([\d,]+)\s*円/)?.[1] ?? "0").replace(/,/g, "")) || null;
  const distanceKm = Number((distanceText.match(/([\d.]+)km/)?.[1] ?? "0")) || null;
  // 「10:00発→11:27着 1時間27分(乗車1時間27分)」から時刻と所要時間を取ります。
  // ここが**いちばん確かな出どころ**です。下の明細はHTMLの作りが変わると
  // 空になりますが、この行は要約として必ず出ます。
  const clock = [...time.matchAll(/(\d{1,2}:\d{2})/g)].map((m) => m[1]);
  const dur = time.match(/(?:(\d+)\s*時間)?\s*(\d+)\s*分/);
  const minutes = dur ? Number(dur[1] ?? 0) * 60 + Number(dur[2]) : null;
  return {
    text: [time, transferText, fareText, distanceText].filter(Boolean).join(" / "),
    transfers, fareYen, distanceKm,
    departure: clock[0] ?? null, arrival: clock[1] ?? null, minutes,
  };
}

/** 候補ごとのHTML。route01, route02, … を切り出します。 */
export function routeBlocks(html) {
  const marks = [];
  const re = /id=["']route(\d{2})["']/gi;
  let m;
  while ((m = re.exec(html))) marks.push(m.index);
  if (!marks.length) return [html];
  return marks.map((start, i) => html.slice(start, marks[i + 1] ?? html.length));
}

/** いちばん上の候補だけ。 */
export function firstYahooRoute(html) {
  return routeBlocks(html)[0];
}

/**
 * class に「その名前がそのまま入っている」div の位置。
 *
 * `class=[^"]*routeDetail` のような書き方だと、外側の
 * `class="elmRouteDetail"` にも当たります。実際そうなっていて、
 * 明細ではなく要約の部分だけを見ていたため、駅が1件も取れず
 * 所要時間が0分になっていました。名前は区切って突き合わせます。
 */
export function divsWithClass(html, name) {
  const re = /<div[^>]*class=["']([^"']*)["'][^>]*>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    if (m[1].split(/\s+/).includes(name)) out.push({ start: m.index, end: re.lastIndex });
  }
  return out;
}

export function parseRouteDetail(html) {
  const blocks = divsWithClass(html, "routeDetail");
  const detail = blocks.length
    ? html.slice(blocks[0].end, blocks[1]?.start ?? html.length)
    : html;

  // 駅の区切りは「次の駅ブロックが始まるまで」です。あいだには
  // 運賃や路線の欄が挟まります（駅 → fareSection → 駅）。
  const marks = divsWithClass(detail, "station");
  const stations = [];
  for (let i = 0; i < marks.length; i++) {
    const chunk = detail.slice(marks[i].end, marks[i + 1]?.start ?? detail.length);
    const name = cleanText(firstMatch(chunk, /<dt[^>]*>([\s\S]*?)<\/dt>/i));
    const head = chunk.slice(0, chunk.search(/<dl[^>]*>/i) + 1 || chunk.length);
    // 乗換駅は「10:39着 / 10:48発」のように、時刻のうしろに文字が付きます。
    // 時刻だけの行にしか当てていなかったので、乗換駅の時刻が
    // 取れていませんでした。中身から時刻を拾います。
    const times = [...head.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((m) => cleanText(m[1]).match(/(\d{1,2}:\d{2})/)?.[1])
      .filter(Boolean);
    if (name) stations.push({ name, times });
  }

  const transports = [];
  const transportRe = /<li[^>]*class=["'][^"']*transport[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let tm;
  while ((tm = transportRe.exec(detail))) {
    const text = cleanText(tm[1]);
    // 徒歩の区間には「地図でルートを表示」というリンクの文字が付きます。
    if (text) transports.push(text.replace(/^\[?(?:train|line)\]?\s*/i, "")
      .replace(/\s*地図でルートを表示\s*$/, ""));
  }

  const legs = [];
  for (let i = 0; i < transports.length && i + 1 < stations.length; i++) {
    const from = stations[i];
    const to = stations[i + 1];
    const dep = from.times[from.times.length - 1] ?? null;
    const arr = to.times[0] ?? null;
    legs.push({
      kind: "ride",
      from: from.name,
      to: to.name,
      departure: dep,
      arrival: arr,
      minutes: dep && arr ? clockDiff(dep, arr) : null,
      line: transports[i],
    });
  }

  const departure = stations[0]?.times[0] ?? null;
  const arrival = stations.at(-1)?.times.at(-1) ?? null;
  const intermediateStops = stations.slice(1, -1).map((s) => ({
    station: s.name,
    arrival: s.times[0] ?? null,
    departure: s.times[1] ?? null,
  }));
  return { departure, arrival, legs, intermediateStops };
}

function firstMatch(s, re) { return s.match(re)?.[1] ?? ""; }
function cleanText(s) {
  return String(s ?? "")
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;|&#x27;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}
function tokyoParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (name) => parts.find((x) => x.type === name)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") === "24" ? "00" : get("hour"), minute: get("minute") };
}
function clockMinutes(hm) { const [h, m] = hm.split(":").map(Number); return h * 60 + m; }
function clockDiff(from, to) { return (clockMinutes(to) - clockMinutes(from) + 1440) % 1440; }
function tokyoClockMinutes(date) { const p = tokyoParts(date); return Number(p.hour) * 60 + Number(p.minute); }

/**
 * 同じ問い合わせは、覚えておいて返します。
 *
 * 経路は**同じ地点・同じ条件なら同じ答え**です（少なくとも1時間は）。
 * それでも毎回Googleへ投げると、そのぶん課金され、そのぶん遅くなります。
 * 旅程を作り直すたび、同じ「駅までの徒歩」を何度も聞いていました。
 *
 * 覚える鍵は、本文を並べ替えて作ります。項目の順が違うだけの同じ問い
 * 合わせを、別ものと数えないためです。
 */
const ROUTES_TTL_SEC = 3600;

async function routesCacheKey(body, mask) {
  const stable = JSON.stringify(sortDeep(body)) + "|" + mask;
  const digest = await crypto.subtle.digest("SHA-256",
                                            new TextEncoder().encode(stable));
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request(`https://routes.cache/${hex}`, { method: "GET" });
}

/** 鍵と配列の順を揃えます（同じ中身なら同じ文字列になるように）。 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .map((k) => [k, sortDeep(value[k])]));
  }
  return value;
}

async function routes(request, env) {
  // 鍵が無いまま投げると、Googleから「API key not valid」が返ります。
  // 読んだ人は、自分の入力を疑います。**ここに鍵が無いだけ**なので、
  // 上流へ行く前に、そう言います。
  const missing = missingSecret(env, "MAPS_API_KEY");
  if (missing) return missing;
  const body = await readJson(request);
  if (!body?.origin || !body?.destination) return text("経路の起点と終点が必要です", 400);
  const mask = (request.headers.get("X-Goog-FieldMask") ?? "").slice(0, 500);

  const cache = globalThis.caches?.default;
  const key = cache ? await routesCacheKey(body, mask) : null;
  const hit = key ? await cache.match(key) : null;
  if (hit) {
    const out = new Response(await hit.text(), { status: 200,
      headers: { "Content-Type": "application/json" } });
    out.headers.set("X-Tabisaki-Cache", "hit");
    return out;
  }

  const res = await fetch(ROUTES_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": env.MAPS_API_KEY, "X-Goog-FieldMask": mask },
    body: JSON.stringify(body), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const out = await passthrough(res, "routes");
  // 覚えるのは、ちゃんと答えが返ったときだけです。断られた返事を
  // 1時間持っていても、誰の役にも立ちません。
  if (key && out.status === 200) {
    const copy = out.clone();
    await cache.put(key, new Response(await copy.text(), {
      headers: { "Content-Type": "application/json",
                 "Cache-Control": `max-age=${ROUTES_TTL_SEC}` },
    }));
  }
  return out;
}
async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) { const e = new Error("too large"); e.code = "TOO_LARGE"; throw e; }
  let body; try { body = JSON.parse(raw); } catch { const e = new Error("bad body"); e.code = "BAD_BODY"; throw e; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { const e = new Error("bad body"); e.code = "BAD_BODY"; throw e; }
  return body;
}
/** その入口の重さ。表に無いものは1点として数えます。 */
export function costOf(path) {
  for (const [suffix, cost] of Object.entries(COST)) {
    if (path.endsWith(suffix)) return cost;
  }
  return 1;
}

/** その入口の枠。表に無いものは、お金のかかる側として数えます。 */
export function poolOf(path) {
  for (const [suffix, pool] of Object.entries(POOL)) {
    if (path.endsWith(suffix)) return pool;
  }
  return "paid";
}

async function rateCheck(env, ip, cost, pool = "paid", settings = null) {
  if (!env.RATE || String(env.RATE_LIMIT ?? "").toLowerCase() === "off") {
    return { ok: true };
  }
  const id = env.RATE.idFromName(ip); const stub = env.RATE.get(id);
  const q = new URLSearchParams({ cost: String(cost), pool,
                                  limits: JSON.stringify(limitsFrom(env, settings)) });
  return (await stub.fetch(`https://rate/check?${q}`)).json();
}

/**
 * いま何点使っているか（画面に出すため）。減らしません。
 *
 * 中の返事は { ok, usage } の形です。それをそのまま /status の usage に
 * 入れていたので、外から見ると usage.usage になり、画面には
 * 「1分 undefined/undefined点」と出ていました。ここで開いて渡します。
 */
async function rateUsage(env, ip, settings = null) {
  if (!env.RATE || String(env.RATE_LIMIT ?? "").toLowerCase() === "off") {
    return null;
  }
  const id = env.RATE.idFromName(ip); const stub = env.RATE.get(id);
  const q = new URLSearchParams({ limits: JSON.stringify(limitsFrom(env, settings)) });
  const body = await (await stub.fetch(`https://rate/usage?${q}`)).json();
  return body?.usage ?? body ?? null;
}

export class RateLimiter {
  constructor(state) { this.state = state; }

  async fetch(request) {
    const url = new URL(request.url);
    const cost = Math.max(0, Number(url.searchParams.get("cost") ?? 1) || 0);
    const pool = url.searchParams.get("pool") === "free" ? "free" : "paid";
    const peek = url.pathname === "/usage";
    let limits = LIMITS;
    try {
      const given = JSON.parse(url.searchParams.get("limits") ?? "null");
      if (given?.free?.minute && given?.paid?.minute) limits = given;
    } catch { /* 読めなければ既定のままです */ }

    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      // 記録は [時刻, 点数, 枠] の組です。形を変えてきたので、古い記録も
      // 読めるようにしておきます（配備の切り替わりで落ちないように）。
      //   時刻だけ          → 1点・paid
      //   [時刻, 点数]      → paid
      //   [時刻, 点数, 枠]  → そのまま
      const raw = (await this.state.storage.get("hits")) ?? [];
      const hits = raw.map((h) => (Array.isArray(h)
        ? [h[0], h[1] ?? 1, h[2] === "free" ? "free" : "paid"]
        : [h, 1, "paid"]));
      const recent = hits.filter(([t]) => now - t < 3_600_000);

      const sum = (list, kind) => list
        .filter(([, , k]) => k === kind)
        .reduce((a, [, c]) => a + c, 0);
      const lastMinute = recent.filter(([t]) => now - t < 60_000);
      const shape = (kind) => ({
        minute: sum(lastMinute, kind), minuteLimit: limits[kind].minute,
        hour: sum(recent, kind), hourLimit: limits[kind].hour,
      });
      // 画面に出す見出しは、お金のかかる側です。無料のYahoo!は
      // 「ぶつかることのない枠」なので、内訳として添えるだけにします。
      const usage = { ...shape("paid"), free: shape("free"),
                      paid: shape("paid") };
      if (peek) return json({ ok: true, usage });

      const lim = limits[pool];
      if (sum(lastMinute, pool) + cost > lim.minute) {
        await this.state.storage.put("hits", recent);
        return json({ ok: false, retryAfter: 60, usage });
      }
      if (sum(recent, pool) + cost > lim.hour) {
        await this.state.storage.put("hits", recent);
        return json({ ok: false, retryAfter: 600, usage });
      }
      if (cost > 0) {
        recent.push([now, cost, pool]);
        await this.state.storage.put("hits", recent);
        await this.state.storage.setAlarm(now + 3_600_000);
      }
      const after = pool === "paid"
        ? { ...usage, minute: usage.minute + cost, hour: usage.hour + cost,
            paid: { ...usage.paid, minute: usage.paid.minute + cost,
                    hour: usage.paid.hour + cost } }
        : { ...usage, free: { ...usage.free, minute: usage.free.minute + cost,
                              hour: usage.free.hour + cost } };
      return json({ ok: true, usage: after });
    });
  }

  async alarm() { await this.state.storage.deleteAll(); }
}
function json(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }); }
/**
 * 上流の返事を、そのまま渡します。
 *
 * ただし「混んでいる・枠を使い切った」だけは読み替えます。番号
 * （429・quota付きの403）で分かるので、受け取る側が推し量らなくて
 * 済むように、共通の形にして返します。
 */
async function passthrough(res, service = "upstream") {
  const body = await res.text();
  if (res.status === 429 || (res.status === 403 && /quota|rate/i.test(body))) {
    const retryAfter = Number(res.headers.get("Retry-After")) || 60;
    return fail(429, "UPSTREAM_LIMIT",
      "いま利用が集中しています。時間をおいてから、もう一度お試しください。",
      { service, retryable: true, retryAfter,
        headers: { "Retry-After": String(retryAfter) } });
  }
  return new Response(body, { status: res.status,
                              headers: { "Content-Type": "application/json" } });
}
/**
 * 断るときの返事は、いつも同じ形にします。
 *
 * これまでは入口ごとにばらばらでした（Googleは500、Geminiは502、
 * Yahoo!は429、Workers AIは503）。受け取る側は、どれがやり直せば通る
 * ものなのかを、番号から推し量るしかありません。
 *
 *   code      … 何が起きたか（機械が見る）
 *   service   … どこで起きたか
 *   retryable … 時間をおけば通る見込みがあるか
 *   message   … そのまま画面に出せる日本語
 *
 * message は前からある形（error.message）のままです。読む側を壊さずに、
 * 手がかりだけを足します。
 */
function fail(status, code, message, opts = {}) {
  const body = {
    ok: false,
    error: {
      code,
      service: opts.service ?? "proxy",
      retryable: opts.retryable ?? false,
      message,
      ...(opts.retryAfter ? { retryAfter: opts.retryAfter } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
}

function text(message, status, extra = {}) {
  // 古い呼び出し（コードを渡さないもの）。番号から見当をつけます。
  const code = status === 429 ? "RATE_LIMITED"
    : status === 403 ? "FORBIDDEN"
    : status === 404 ? "NOT_FOUND"
    : status === 405 ? "METHOD_NOT_ALLOWED"
    : status === 413 ? "BODY_TOO_LARGE"
    : status === 400 ? "BAD_REQUEST"
    : status === 503 ? "NOT_CONFIGURED"
    : status === 504 ? "UPSTREAM_TIMEOUT"
    : "UPSTREAM_ERROR";
  return fail(status, code, message,
              { retryable: status === 429 || status >= 500, headers: extra });
}
export function cors(res, origin, allow = [DEFAULT_ALLOW_ORIGIN]) {
  const h = new Headers(res.headers);
  // 許した出どころには、その出どころをそのまま返します。固定の1つを
  // 返していたので、公開先が2つあると片方が必ず「Load failed」でした。
  const ok = allow.includes("*") ? (origin || "*")
    : (allow.includes(origin) ? origin : allow[0]);
  h.set("Access-Control-Allow-Origin", ok);
  h.set("Access-Control-Allow-Methods", "POST, OPTIONS"); h.set("Access-Control-Allow-Headers", "Content-Type, X-Goog-FieldMask");
  h.set("X-Content-Type-Options", "nosniff"); h.set("X-Frame-Options", "DENY"); h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
