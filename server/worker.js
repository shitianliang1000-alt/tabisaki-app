import { ADMIN_ASSET_DIR, isAdminPath, serveAdmin } from "./admin.js";
import { ENDPOINTS, record, Stats } from "./stats.js";
import { cleanExtra } from "../js/metrics.js";
import { servePage } from "./landing.js";
import { providerStatus, transitHandler, TransitError } from "./transit.js";
import { privateKbHandler } from "./private-kb.js";
import { askOwnModel, ownModelConfigured, ownModelFallbackAllowed } from "./own-model.js";
import { cacheApiStore, cacheKey, createCache, memoryStore } from "../packages/core/src/cache.js";
import { dailyLimit, jstDay, rateKey, secondsToJstMidnight } from "./relay-guard.js";

// 末尾の「/」をすべて外す。/\/+$/ は「/」が続く長い文字列で遅くなる
// （CodeQL: polynomial regular expression）ので、正規表現を使わない。
function trimSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

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
//   乗り換え検索  1点  取りに行きますが、**無料です**（Transit API）
//   Routes API   3点  Googleの従量課金
//   Gemini       5点  1日14,400回の枠を分け合います
//   Workers AI   5点  1日10,000ニューロンの枠
//
// 数える枠は**2つに分けます**。以前は全部を1分20点の1つの枠で数えて
// いました。ところが旅程1本で電車・バスを30区間ほど聞くので、1分20点は
// 最初の1本の途中で尽きます。無料の乗り換え検索が、お金のかかるGeminiと
// 同じ枠を奪い合っていたわけで、これは数えかたの誤りでした。
//
//   free … 乗り換え検索。こちらの費用はゼロなので、大きく取ります。
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
  // 非商用データの「はい／いいえ」だけの判定（server/private-kb.js）。
  // 外へは取りに行きません。
  "/stops/near": 1,
  "/spots/check": 1,
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
  "/stops/near": "free",
  "/spots/check": "free",
  "/metrics": "free",
};

export const LIMITS = {
  free: { minute: 600, hour: 6000 },
  paid: { minute: 60, hour: 400 },
};

/** 環境変数があれば、そちらを使います。 */
export function limitsFrom(env) {
  const n = (v, fallback) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : fallback;
  };
  return {
    free: {
      minute: n(env?.RATE_FREE_PER_MINUTE, LIMITS.free.minute),
      hour: n(env?.RATE_FREE_PER_HOUR, LIMITS.free.hour),
    },
    paid: {
      minute: n(env?.RATE_PAID_PER_MINUTE, LIMITS.paid.minute),
      hour: n(env?.RATE_PAID_PER_HOUR, LIMITS.paid.hour),
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
    // トップ（/）は tour.html（映像で見る旅さき）です。前のトップ（動く見本の紹介）は /landing に残しています。
    if (env?.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
      if (url.pathname === "/" && !url.searchParams.has("p")) {
        const res = await env.ASSETS.fetch(new Request(new URL("/tour", url.origin), request));
        if (res.ok) return res;
      }
      if (url.pathname === "/landing") {
        const page = await servePage(new Request(new URL("/", url.origin), request), env);
        if (page) return page;
      }
    }
    // チャットの画面（/app）と、?p= の旧リンクは、開いたときに作ります（server/landing.js）。
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
    // /metrics は、その中で出来事と一緒に1回で数えます（Durable Object を2回呼ばない）。
    if (request.method === "POST" && endpointOf(trimSlashes(url.pathname)) !== "/metrics") {
      const work = record(env, usageOf(request, url, res.status, res.headers));
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

/** その入口の名前（数えるときの鍵）。 */
export function endpointOf(path) {
  return [...ENDPOINTS, "/status"].find((p) => path.endsWith(p)) ?? "other";
}

/**
 * 1回の呼び出しで数えるもの。IP は Stats がその日の塩でハッシュにして
 * 捨てます（保存しません）。国は Cloudflare の国コードだけです。
 */
export function usageOf(request, url, status, headers = null) {
  const path = endpointOf(trimSlashes(url.pathname));
  const items = [["req", path, 1], ["country", request.cf?.country ?? "??", 1]];
  if (status >= 400) items.push(["status", `${path} ${status}`, 1]);
  // 控えの当たり・外れと、かかった時間の合計（÷件数で平均。#438）。
  const xc = headers?.get?.("X-Cache");
  if (xc === "HIT" || xc === "MISS") {
    const kind = `${path} ${xc === "HIT" ? "hit" : "miss"}`;
    const dur = Number(/dur=([\d.]+)/.exec(headers.get("Server-Timing") ?? "")?.[1]);
    items.push(["cache", kind, 1]);
    if (Number.isFinite(dur)) items.push(["cache_ms", kind, Math.min(60_000, Math.round(dur))]);
  }
  return {
    ip: request.headers.get("CF-Connecting-IP") ?? "",
    items,
    ...(status >= 500 ? { error: { code: `HTTP ${status}`, path, detail: "中継の返事" } } : {}),
  };
}

/** 管理画面の「概要」に出すもの。鍵は、入っているかどうかだけです。 */
async function overviewFor(env, selfOrigin) {
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
    limits: limitsFrom(env),
    dailyLimit: dailyLimit(env),
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
    const path = trimSlashes(new URL(request.url).pathname);
    // 重さに応じて数えます（Geminiの1回と /status の1回は別ものです）。
    // 枠は2つ。無料の乗り換え検索が、お金のかかるGeminiの枠を食べません。
    const gate = await rateCheck(env, ip, costOf(path), poolOf(path));
    if (!gate.ok) {
      return cors(fail(429, "RATE_LIMITED",
        "いま利用が集中しています。1分ほどおいてから、もう一度お試しください。",
        { retryable: true, retryAfter: gate.retryAfter,
          headers: { "Retry-After": String(gate.retryAfter) } }), origin, allow);
    }
    // 全員の合計（1日）。IP をたくさん持つ相手が、1つずつは上限の内側の
    // まま無料枠や課金を使い切るのを止めます（server/relay-guard.js）。
    // IP ごとの枠を先に見るので、断られた呼び出しは合計に入りません。
    if (poolOf(path) === "paid" && costOf(path) > 0) {
      const day = await dailyCheck(env, costOf(path));
      if (!day.ok) {
        return cors(fail(429, "DAILY_LIMIT",
          "今日の AI・経路の利用が上限に達しました。日本時間の0時に戻ります。",
          // 数時間待つことになるので、自動のやり直しはさせません。
          { retryable: false, retryAfter: day.retryAfter,
            headers: { "Retry-After": String(day.retryAfter) } }), origin, allow);
      }
    }
    const declared = Number(request.headers.get("Content-Length") ?? 0);
    if (declared > MAX_BODY) return cors(text("本文が大きすぎます", 413), origin, allow);
    try {
      if (path.endsWith("/gemini/generate")) return cors(await gemini(request, env, "generateContent"), origin, allow);
      if (path.endsWith("/gemini/embed")) return cors(await gemini(request, env, "embedContent"), origin, allow);
      if (path.endsWith("/gemini/models")) return cors(await geminiModels(env), origin, allow);
      if (path.endsWith("/routes")) return cors(await routes(request, env), origin, allow);
      if (path.endsWith("/cf/generate")) return cors(await cfGenerate(request, env), origin, allow);
      if (path.endsWith("/yahoo/transit")) return cors(await transit(request, env), origin, allow);
      // どの乗り換え検索が使えるか（キーの値は返しません）。
      if (path.endsWith("/transit/providers")) return cors(json(providerStatus(env)), origin, allow);
      if (path.endsWith("/transit")) return cors(await transit(request, env), origin, allow);
      if (path.endsWith("/metrics")) return cors(await metrics(request, env), origin, allow);
      // 非商用データ（Workers KV の PRIVATE_KB）で確かめます。返すのは true/false だけで、
      // 名前や座標は返しません（server/private-kb.js・docs/private-kb.md）。
      if (path.endsWith("/stops/near") || path.endsWith("/spots/check")) {
        return cors(json(await privateKbHandler(path, await readJson(request), env)), origin, allow);
      }
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
          // 非商用データの入れ物（Workers KV）がつながっているか（中身は返しません）。
          privateKb: Boolean(env.PRIVATE_KB),
          // 自前のモデルの入口が設定されているか（URL も鍵も返しません）。
          ownModel: ownModelConfigured(env),
          allowOrigin: allow,
          // あと何点使えるか。無料枠は使い切ると**その日は誰も使えません**。
          // 止まってから気づくのでは遅いので、先に見えるようにします。
          usage: await rateUsage(env, ip),
          // 全員の合計（今日の分）。止まる前に、管理画面から見えるように。
          daily: await dailyUsage(env),
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
  // 入口・国・利用者の件数も、ここで一緒に数えます（Durable Object は1回だけ）。
  const usage = usageOf(request, new URL(request.url), 204);
  const r = metricRecord(event, detail, cleanExtra(body));
  await record(env, { ...r, ip: usage.ip, items: [...usage.items, ...r.items] });
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

// 検索の控え（packages/core/src/cache.js。Redis は使いません）。
// 前から順に、この Worker のメモリ（同じ入れ物の中だけ・すぐ）、
// Cloudflare の Cache API（データセンターごと・1日）を見ます。
const WEB_TTL_MS = 24 * 3600 * 1000;
let webCacheLayers = null;
function webSearchCache() {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (!webCacheLayers || webCacheLayers.cache !== cache) {
    const layers = [memoryStore({ maxEntries: 300 })];
    if (cache) layers.push(cacheApiStore(cache, { base: "https://web.search/v2/", ttlMs: WEB_TTL_MS }));
    webCacheLayers = { cache, store: createCache({ ttlMs: WEB_TTL_MS, layers }) };
  }
  return webCacheLayers.store;
}

/** 試験用。検索の控えを空にします。 */
export function resetWebSearchCache() {
  webCacheLayers = null;
}

async function webSearch(request, env, ctx) {
  const body = await readJson(request);
  const q = cleanSnippet(body?.q, WEB_QUERY_MAX).replace(/…$/, "");
  if (!q) return text("検索語がありません", 400);
  const want = hasSecret(env, "TAVILY_API_KEY") ? "tavily" : "wikipedia";
  let failed = null;
  const { value, hit, ms } = await webSearchCache().fetch(`${want}:${cacheKey(q)}`, async () => {
    const out = await askWebSearch(q, env, want);
    if (!out.ok) failed = out.res;
    return out.ok ? out : undefined;
  // 切り替えたときの答えは、覚えておきません（Tavily が戻れば、そちらで聞き直します）。
  }, { keep: (v) => v.engine === want });
  // 検索先の失敗はそのまま返します（同時に頼まれた分は、待っていた側も失敗です）。
  if (failed) return passthrough(failed, "wikipedia");
  if (!value) return fail(502, "UPSTREAM_ERROR", "検索できませんでした。もう一度お試しください。",
    { service: "wikipedia", retryable: true });
  const out = JSON.stringify({ ok: true, engine: value.engine, q, cached: hit, results: value.results });
  return new Response(out, { headers: {
    "Content-Type": "application/json", "Cache-Control": "max-age=86400",
    // 当たり・外れとかかった時間（管理画面の件数と、ブラウザの開発ツールで見られます）。
    "X-Cache": hit ? "HIT" : "MISS",
    "Server-Timing": `cache;desc="${hit ? "hit" : "miss"}";dur=${Math.round(ms)}`,
  } });
}

/** 検索先に聞きます。{ok, engine, results} か、失敗なら {ok: false, res}。 */
async function askWebSearch(q, env, want) {
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
  if (!res.ok) return { ok: false, res };
  const data = await res.json();
  return { ok: true, engine, results: engine === "tavily" ? tavilyResults(data) : wikiResults(data) };
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
  // 自前のモデル（OWN_MODEL_URL）があれば、文の生成はまずそちらへ聞きます
  // （server/own-model.js・docs/own-model.md）。無ければいままでどおりです。
  const own = method === "generateContent" && ownModelConfigured(env);
  if (!own) {
    const missing = missingSecret(env, "GEMINI_API_KEY");
    if (missing) return missing;
  }
  const body = await readJson(request);
  const model = String(body?.model ?? "");
  if (!ALLOWED_MODELS.has(model)) return text("そのモデルは使えません", 400);
  // guidedSchema は自前のモデルにだけ使う形のしばり（#435）。Google へは渡しません（400 になります）。
  const { model: _drop, guidedSchema, ...payload } = body;
  const started = Date.now();
  let ownError = null;
  if (own) {
    const got = await askOwnModel(payload, env, { guidedSchema });
    if (got.data) return withSource(json(got.data), "own");
    ownError = got.error;
    if (!ownModelFallbackAllowed(env)) {
      return text(`自前のモデルが答えませんでした（${ownError}）`, 502);
    }
    const missing = missingSecret(env, "GEMINI_API_KEY");
    if (missing) return missing;
  }
  // 自前のモデルを待ったぶん、AI Studio を待つ時間を縮めます（画面は 135 秒で諦めます）。
  const budget = method === "generateContent"
    ? Math.max(UPSTREAM_TIMEOUT_MS, AI_TIMEOUT_MS - (Date.now() - started))
    : UPSTREAM_TIMEOUT_MS;
  const res = await fetch(`${GEMINI_ROOT}/models/${encodeURIComponent(model)}:${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(budget),
  });
  const out = await passthrough(res, "gemini");
  if (!own) return out;
  return withSource(out, `aistudio-fallback;own=${ownError}`);
}

/** どのモデルが答えたかを見出しに書きます（中身は変えません）。 */
function withSource(res, source) {
  const headers = new Headers(res.headers);
  headers.set("X-Tabisaki-Model-Source", source);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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
 * 決めます。JR は Transit API（api.transit.ls8h.com）、答えが出なければ
 * Google マップの URL を添えます。Transit APIのページを読む取得は
 * やめました（2026-11-12）。古い画面が呼ぶ /yahoo/transit も、ここに来ます。
 */
async function transit(request, env) {
  const body = await readJson(request);
  try {
    return json(await transitHandler(body, env));
  } catch (e) {
    if (!(e instanceof TransitError)) throw e;
    return fail(e.status, e.code.toUpperCase(), e.message,
      { service: "transit", retryable: e.retryable,
        ...(e.status === 429 ? { retryAfter: 60, headers: { "Retry-After": "60" } } : {}) });
  }
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

async function rateCheck(env, ip, cost, pool = "paid") {
  if (!env.RATE || String(env.RATE_LIMIT ?? "").toLowerCase() === "off") {
    return { ok: true };
  }
  // IPv6 は /64 ごとにまとめます（末尾を変えて枠を増やせないように）。
  const id = env.RATE.idFromName(rateKey(ip)); const stub = env.RATE.get(id);
  const q = new URLSearchParams({ cost: String(cost), pool,
                                  limits: JSON.stringify(limitsFrom(env)) });
  return (await stub.fetch(`https://rate/check?${q}`)).json();
}

/**
 * いま何点使っているか（画面に出すため）。減らしません。
 *
 * 中の返事は { ok, usage } の形です。それをそのまま /status の usage に
 * 入れていたので、外から見ると usage.usage になり、画面には
 * 「1分 undefined/undefined点」と出ていました。ここで開いて渡します。
 */
async function rateUsage(env, ip) {
  if (!env.RATE || String(env.RATE_LIMIT ?? "").toLowerCase() === "off") {
    return null;
  }
  const id = env.RATE.idFromName(rateKey(ip)); const stub = env.RATE.get(id);
  const q = new URLSearchParams({ limits: JSON.stringify(limitsFrom(env)) });
  const body = await (await stub.fetch(`https://rate/usage?${q}`)).json();
  return body?.usage ?? body ?? null;
}

// 全員の合計を数える置き場の名前。IP の名前（rateKey）とは重なりません。
const DAILY_ID = "__daily__";

function dailyOff(env) {
  return !env.RATE || String(env.RATE_LIMIT ?? "").toLowerCase() === "off"
    || dailyLimit(env) === null;
}

/** 全員の合計（1日）に cost を足せるか。足せるなら足します。 */
async function dailyCheck(env, cost) {
  if (dailyOff(env)) return { ok: true };
  const stub = env.RATE.get(env.RATE.idFromName(DAILY_ID));
  const q = new URLSearchParams({ cost: String(cost), limit: String(dailyLimit(env)) });
  return (await stub.fetch(`https://rate/daily?${q}`)).json();
}

/** 今日の合計（減らしません）。 */
async function dailyUsage(env) {
  if (dailyOff(env)) return null;
  const stub = env.RATE.get(env.RATE.idFromName(DAILY_ID));
  const q = new URLSearchParams({ limit: String(dailyLimit(env)) });
  const body = await (await stub.fetch(`https://rate/daily-usage?${q}`)).json();
  return body?.daily ?? null;
}

// 回数の記録を書く間隔。Durable Object の無料枠は「書き込む行が1日10万行」
// までで、以前は呼び出しのたびに記録と予約（alarm）を書いていました。
// 断ったときにまで書いていたので、叩かれるほど書き込みが増えていました。
//
// いまは記録をメモリに持ち、書くのは RATE_SAVE_MS に1回だけです（断ったときは
// 書きません）。Durable Object は使われているあいだメモリを保つので、数え
// かたは変わりません。しばらく使われずに落ちたときだけ、最後の数十秒ぶんを
// 数えそこねます（1時間の枠が少し甘くなるだけで、1分の枠は元から過ぎています）。
export const RATE_SAVE_MS = 30_000;
const HOUR_MS = 3_600_000;

export class RateLimiter {
  constructor(state) {
    this.state = state;
    this.hits = null;       // [時刻, 点数, 枠] の並び。null はまだ読んでいない
    this.savedAt = 0;       // 最後に書いた時刻
    this.alarmAt = 0;       // 予約してある片付けの時刻
    this.day = null;        // 全員の合計 { d: 日付, pts: 点 }（__daily__ だけ）
    this.daySavedAt = 0;
  }

  /**
   * 全員の合計（1日）。日本時間の日付が変わったら0から数え直します。
   * 書くのは RATE_SAVE_MS に1回だけです（断ったときは書きません）。
   * 片付けの予約（alarm）は使いません。日付が変われば自然に数え直すので。
   */
  async daily(url) {
    const cost = Math.max(0, Number(url.searchParams.get("cost") ?? 0) || 0);
    const limit = Number(url.searchParams.get("limit")) || Infinity;
    const peek = url.pathname === "/daily-usage";
    return this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const today = jstDay(now);
      if (!this.day) this.day = (await this.state.storage.get("day")) ?? null;
      if (!this.day || this.day.d !== today) this.day = { d: today, pts: 0 };
      const shape = (pts) => ({ day: today, points: pts,
                                limit: Number.isFinite(limit) ? limit : null });
      if (peek) return json({ ok: true, daily: shape(this.day.pts) });
      if (this.day.pts + cost > limit) {
        return json({ ok: false, retryAfter: secondsToJstMidnight(now),
                      daily: shape(this.day.pts) });
      }
      this.day.pts += cost;
      if (cost > 0 && now - this.daySavedAt >= RATE_SAVE_MS) {
        this.daySavedAt = now;
        await this.state.storage.put("day", this.day);
      }
      return json({ ok: true, daily: shape(this.day.pts) });
    });
  }

  /** 記録を（まだなら）読みます。古い形の記録も読めるようにしておきます。 */
  async load() {
    if (this.hits) return this.hits;
    // 記録は [時刻, 点数, 枠] の組です。形を変えてきたので、古い記録も
    // 読めるようにしておきます（配備の切り替わりで落ちないように）。
    //   時刻だけ          → 1点・paid
    //   [時刻, 点数]      → paid
    //   [時刻, 点数, 枠]  → そのまま
    const raw = (await this.state.storage.get("hits")) ?? [];
    this.hits = raw.map((h) => (Array.isArray(h)
      ? [h[0], h[1] ?? 1, h[2] === "free" ? "free" : "paid"]
      : [h, 1, "paid"]));
    return this.hits;
  }

  /** 間隔が空いていれば、記録を書きます。片付けの予約は30分に1回まで。 */
  async save(now, force = false) {
    if (!force && now - this.savedAt < RATE_SAVE_MS) return;
    this.savedAt = now;
    await this.state.storage.put("hits", this.hits);
    if (this.alarmAt < now + HOUR_MS / 2) {
      this.alarmAt = now + HOUR_MS;
      await this.state.storage.setAlarm(this.alarmAt);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/daily" || url.pathname === "/daily-usage") return this.daily(url);
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
      const hits = await this.load();
      const recent = hits.filter(([t]) => now - t < HOUR_MS);
      this.hits = recent;

      const sum = (list, kind) => list
        .filter(([, , k]) => k === kind)
        .reduce((a, [, c]) => a + c, 0);
      const lastMinute = recent.filter(([t]) => now - t < 60_000);
      const shape = (kind) => ({
        minute: sum(lastMinute, kind), minuteLimit: limits[kind].minute,
        hour: sum(recent, kind), hourLimit: limits[kind].hour,
      });
      // 画面に出す見出しは、お金のかかる側です。無料の乗り換え検索は
      // 「ぶつかることのない枠」なので、内訳として添えるだけにします。
      const usage = { ...shape("paid"), free: shape("free"),
                      paid: shape("paid") };
      if (peek) return json({ ok: true, usage });

      // 断るときは書きません（叩かれても書き込みが増えないように）。
      const lim = limits[pool];
      if (sum(lastMinute, pool) + cost > lim.minute) {
        return json({ ok: false, retryAfter: 60, usage });
      }
      if (sum(recent, pool) + cost > lim.hour) {
        return json({ ok: false, retryAfter: 600, usage });
      }
      if (cost > 0) {
        recent.push([now, cost, pool]);
        await this.save(now);
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

  /** 1時間より前の記録を捨てます。残りがあれば、もう一度予約します。 */
  async alarm() {
    const now = Date.now();
    this.alarmAt = 0;
    const recent = (await this.load()).filter(([t]) => now - t < HOUR_MS);
    // 全員の合計の置き場は、ここで消しません（今日の分を失います）。
    if (!recent.length && (this.day ?? (await this.state.storage.get("day")))) {
      this.hits = [];
      return;
    }
    if (!recent.length) {
      this.hits = []; this.savedAt = 0;
      await this.state.storage.deleteAll();
      return;
    }
    this.hits = recent;
    await this.save(now, true);
  }
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
 * 乗り換え検索は429、Workers AIは503）。受け取る側は、どれがやり直せば通る
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
