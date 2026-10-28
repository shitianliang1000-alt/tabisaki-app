// 管理画面を、合言葉を知っている人だけに見せます。
//
// 管理画面（admin/）は GitHub Pages には置きません（誰でも開けるため）。
// 代わりに、この Worker が次の場所で配ります。
//
//   https://<worker>/admin   → 合言葉を聞いてから /private/admin/ へ
//
// /private/ の下は、リポジトリの一番上と同じ並びです。
//   /private/admin/…  … Worker に同梱した admin/ のファイル（ADMIN_FILES）
//   /private/js/… /private/css/… /private/kb/… /private/packages/core/src/…
//                     … 同じ Worker が配っているサイトのファイル（ASSETS）を渡します
//
// 2026-10-22 から、サイトも管理画面も同じ Worker の静的ファイル（ASSETS、
// tools/build_worker.sh が組み立てる .site/）から配ります。管理画面の
// ファイルは .site/__admin/ にあり、Worker が合言葉を確かめてからしか
// 渡しません（wrangler.jsonc の run_worker_first）。
// admin/index.html は ../js/ や ../kb/（旅程を組む部分は ../packages/core/src/）を相対で読むので、手元で
// `python3 -m http.server` から開いたときと同じ書きかたのまま動きます。
//
// 合言葉は Worker の secret ADMIN_PASSWORD です。**入れていなければ、
// 管理画面はどこにも出ません**（404）。入れ忘れて丸見えになる、という
// 向きには倒れません。
//
//   npx wrangler secret put ADMIN_PASSWORD
//
// ブラウザが出す「ユーザー名」は何でもかまいません。見るのは合言葉だけです。

import { forward } from "./stats.js";
import { openKbPullRequest } from "./github.js";

export const ADMIN_PREFIX = "/private/";
const API_PREFIX = `${ADMIN_PREFIX}api/`;
export const SITE_ORIGIN = "https://tabisaki-github-io.shitianliang1000.workers.dev";
export const SITE_ROOT = `${SITE_ORIGIN}/`;
/** 静的ファイルの中で、管理画面のファイルを置いている場所（直には配りません）。 */
export const ADMIN_ASSET_DIR = "/__admin/";

// 公開サイトから取ってきてよい場所。これ以外は取りに行きません
// （どこでも中継する入口にはしません）。
const MIRRORED = /^(js|css|kb|packages\/core\/src)\/[A-Za-z0-9._\/-]+$/;
const ADMIN_FILE = /^admin\/[A-Za-z0-9._-]*$/;

/** この入口が管理画面のものか。 */
export function isAdminPath(pathname) {
  return pathname === "/admin" || pathname === "/admin/"
    || pathname === ADMIN_PREFIX.slice(0, -1) || pathname.startsWith(ADMIN_PREFIX);
}

/**
 * 管理画面への GET/HEAD を受けます。
 * fail(ip) は、合言葉を間違えたときに呼ばれます（回数制限に数えるため）。
 */
export async function serveAdmin(request, env, { onBadPassword, overview } = {}) {
  const password = String(env?.ADMIN_PASSWORD ?? "");
  // 合言葉が無い＝管理画面を出さない。在ることも言いません。
  if (!password) return plain("Not found", 404);
  const isApi = new URL(request.url).pathname.startsWith(API_PREFIX);
  if (!isApi && request.method !== "GET" && request.method !== "HEAD") {
    return plain("Method not allowed", 405, { Allow: "GET, HEAD" });
  }

  const supplied = basicPassword(request.headers.get("Authorization"));
  if (supplied === null || !(await sameSecret(supplied, password))) {
    if (supplied !== null && onBadPassword) {
      const gate = await onBadPassword();
      if (gate && !gate.ok) return plain("Too many attempts", 429,
        { "Retry-After": String(gate.retryAfter ?? 60) });
    }
    return plain("合言葉が必要です", 401, {
      "WWW-Authenticate": 'Basic realm="tabisaki-admin", charset="UTF-8"',
    });
  }

  const url = new URL(request.url);
  // 入口。/private/ で合言葉を聞くので、ブラウザは /private/ の下全部に
  // 同じ合言葉を付けて送ります（/private/js/… でまた聞かれません）。
  if (url.pathname === "/admin" || url.pathname === "/admin/"
      || url.pathname === "/private" || url.pathname === ADMIN_PREFIX) {
    return guarded(Response.redirect(new URL(`${ADMIN_PREFIX}admin/`, url).toString(), 302));
  }

  const rest = decodeURIComponent(url.pathname.slice(ADMIN_PREFIX.length));
  if (rest.includes("..")) return plain("Not found", 404);

  if (rest === "admin") {
    return guarded(Response.redirect(new URL(`${ADMIN_PREFIX}admin/`, url).toString(), 302));
  }
  if (isApi) return guarded(await serveApi(request, env, url, rest.slice("api/".length), overview));
  if (ADMIN_FILE.test(rest)) {
    const name = rest.slice("admin/".length) || "index.html";
    // ADMIN_FILES は、admin/ だけを Worker に入れていたころの名前です。
    const files = env.ADMIN_FILES ?? env.ASSETS;
    if (!files) return plain("管理画面のファイルが Worker に入っていません", 503);
    const path = env.ADMIN_FILES ? `/${name}` : `${ADMIN_ASSET_DIR}${name}`;
    const res = await files.fetch(new Request(`https://assets.local${path}`,
      { method: request.method }));
    return guarded(res);
  }
  if (MIRRORED.test(rest)) {
    if (env.ASSETS) {
      return guarded(await env.ASSETS.fetch(new Request(`https://assets.local/${rest}${url.search}`,
        { method: request.method, headers: { Accept: request.headers.get("Accept") ?? "*/*" } })));
    }
    const res = await fetch(`${SITE_ROOT}${rest}${url.search}`, {
      method: request.method,
      headers: { Accept: request.headers.get("Accept") ?? "*/*" },
    });
    return guarded(res);
  }
  return plain("Not found", 404);
}

/**
 * 管理画面の読み書き（/private/api/…）。合言葉を通ったあとにだけ来ます。
 *
 * 合言葉はブラウザが覚えて自動で付けるので、ほかのサイトのページから
 * こっそり書き込ませる（CSRF）ことができてしまいます。決まった見出し
 * （X-Admin-Request）を付けた呼び出しだけを受けます。この見出しは、
 * ほかの出どころからは事前確認（preflight）なしには付けられず、
 * その事前確認にはここが答えないので、ほかのサイトからは届きません。
 */
async function serveApi(request, env, url, path, overview) {
  if (request.headers.get("X-Admin-Request") !== "1") return apiJson({ ok: false, error: "見出しが足りません" }, 403);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return apiJson({ ok: false, error: "別のサイトからは使えません" }, 403);
  const m = request.method;
  const body = async () => { try { return await request.json(); } catch { return null; } };

  if (m === "GET" && path === "overview") return apiJson({ ok: true, ...(overview ? await overview() : {}) });
  if (m === "GET" && path === "stats") {
    return forward(env, "GET", `/summary?days=${encodeURIComponent(url.searchParams.get("days") ?? "30")}`);
  }
  if (path === "edits" && m === "GET") return forward(env, "GET", "/edits");
  if (path === "edits" && m === "POST") return forward(env, "POST", "/edits", await body());
  if (path === "edits" && m === "DELETE") {
    const keys = url.searchParams.getAll("key");
    const q = keys.map((k) => `key=${encodeURIComponent(k)}`).join("&");
    if (!keys.length && url.searchParams.get("all") !== "1") {
      return apiJson({ ok: false, error: "消すものを指定してください" }, 400);
    }
    return forward(env, "DELETE", `/edits${q ? `?${q}` : ""}`);
  }
  if (path === "edits/publish" && m === "POST") {
    const listed = await (await forward(env, "GET", "/edits")).json();
    const edits = listed?.edits ?? [];
    try {
      const out = await openKbPullRequest(env, edits);
      // PR に入ったものだけを、変更待ちから外します。
      const done = new Set(out.applied.map((e) => e.key));
      const keys = edits.filter((e) => done.has(e.key)).map((e) => e.key);
      if (keys.length) {
        await forward(env, "DELETE", `/edits?${keys.map((k) => `key=${encodeURIComponent(k)}`).join("&")}`);
      }
      return apiJson({ ok: true, ...out });
    } catch (e) {
      console.error("Failed to publish edits:", e?.stack ?? e);
      return apiJson({ ok: false, error: "公開処理に失敗しました" }, 502);
    }
  }
  return apiJson({ ok: false, error: "その入口はありません" }, 404);
}

function apiJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Authorization: Basic … から合言葉だけを取り出します。無ければ null。 */
export function basicPassword(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header ?? ""));
  if (!m) return null;
  let decoded;
  try {
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  return i < 0 ? null : decoded.slice(i + 1);
}

/** 長さや先頭の一致で時間が変わらないよう、ハッシュどうしを全部比べます。 */
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(async (s) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))));
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** 管理画面の返事に付ける見出し。検索に載せず、ほかのページに埋め込ませず、残させません。 */
function guarded(res) {
  const h = new Headers(res.headers);
  h.set("Cache-Control", "no-store");
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://generativelanguage.googleapis.com https://routes.googleapis.com https://api.open-meteo.com https://tabisaki-github-io.shitianliang1000.workers.dev; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function plain(message, status, extra = {}) {
  return guarded(new Response(message, {
    status, headers: { "Content-Type": "text/plain; charset=utf-8", ...extra },
  }));
}
