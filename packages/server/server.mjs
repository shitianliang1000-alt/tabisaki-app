// 旅さきの API サーバー（packages/server）。
//
//     node packages/server/server.mjs           # http://127.0.0.1:8787
//     docker compose up                          # 同じものを Docker で（compose.yaml）
//
//     curl -X POST http://127.0.0.1:8787/v1/plan \
//       -H 'Content-Type: application/json' \
//       -d '{"wish":"温泉と海","days":2}'
//
// 仕様と安全の決めごとは docs/api.md にあります（Issue #376）。
// - 既定は 127.0.0.1 だけで待ち受け、認証なし（その端末の中だけで使う）
// - 127.0.0.1 以外で待ち受けるときは、TABISAKI_API_TOKEN が無いと起動しません
// - 外へは通信しません（packages/core と同じ）
//
// 応答:
//   POST /v1/plan   200 {ok:true, plan:{…packages/core の JSON…}, markdown?}
//                   400 {ok:false, error:{code, message, request_id}}（入力のまちがい）
//                   401 / 403 / 413 / 415 / 422 / 429 / 503 / 504 / 500
//   GET  /v1/health 200 {ok:true, version, api, spots}
//   /plan と /health は前の名前で、同じものを返します。

import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
/** API の版。形を壊す変更をしたら 2 に上げ、/v2/ を足します（docs/api.md）。 */
export const API_VERSION = 1;

export const LIMITS = {
  bodyBytes: 4096,       // 希望の文は500字まで。JSON の枠を足しても足ります
  timeoutMs: 30000,      // 1本の旅程にかける時間の上限
  concurrent: 2,         // 同時に組む本数（CPU を食い尽くさないように）
  perMinute: 30,         // 1つの相手から1分に受ける回数（認証のまちがいも数えます）
};

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
const MIN_TOKEN = 32;
const BODY_KEYS = ["wish", "from", "days", "date", "start", "back", "transport", "markdown"];

/**
 * 環境変数から設定を読みます。まちがいがあれば errors に入れます（起動しません）。
 * @param {Record<string, string|undefined>} env
 * @param {{readFile?: (path: string) => string}} [io]
 */
export function loadConfig(env = process.env, { readFile = (f) => readFileSync(f, "utf8") } = {}) {
  const errors = [];
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push(`PORT が数ではありません: ${env.PORT}`);

  let raw = env.TABISAKI_API_TOKEN || "";
  if (env.TABISAKI_API_TOKEN_FILE) {
    try { raw = readFile(env.TABISAKI_API_TOKEN_FILE); } catch { errors.push("TABISAKI_API_TOKEN_FILE を読めません"); }
  }
  // カンマで区切ると複数持てます（鍵を入れ替える間、古い鍵と新しい鍵の両方を通すため）。
  const tokens = raw.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
  for (const t of tokens) {
    if (t.length < MIN_TOKEN) errors.push(`TABISAKI_API_TOKEN は ${MIN_TOKEN} 文字以上にしてください（openssl rand -hex 32 など）`);
  }
  const noAuth = env.TABISAKI_NO_AUTH === "1";
  if (!LOOPBACK.includes(host) && !tokens.length && !noAuth) {
    errors.push(`HOST=${host} で待ち受けるには TABISAKI_API_TOKEN が要ります。` +
      "認証なしでほかの端末から呼べる状態にはしません（どうしても要るときだけ TABISAKI_NO_AUTH=1）");
  }
  const list = (v) => (v || "").split(",").map((x) => x.trim()).filter(Boolean);
  const origins = list(env.TABISAKI_ALLOW_ORIGIN);
  for (const o of origins) if (o === "*" || !/^https?:\/\/[^/]+$/.test(o)) errors.push(`TABISAKI_ALLOW_ORIGIN は https://example.com の形で1つずつ書いてください: ${o}`);
  return {
    host, port, tokens, origins, errors,
    hosts: list(env.TABISAKI_ALLOW_HOST).map((h) => h.toLowerCase()),
    trustProxy: env.TABISAKI_TRUST_PROXY === "1",
  };
}

const digest = (t) => createHash("sha256").update(t).digest();
/** 時間の差で鍵を当てられないように、長さをそろえてから比べます。 */
function tokenOk(given, wanted) {
  const g = digest(given);
  let ok = false;
  for (const w of wanted) if (timingSafeEqual(g, w)) ok = true;
  return ok;
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("too_large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * サーバーを作ります（listen はしません）。
 * @param {{core?: object, limits?: object, log?: (line: string) => void,
 *   tokens?: string[], origins?: string[], hosts?: string[], trustProxy?: boolean}} [opts]
 */
export async function createServer({
  core, limits = {}, log = (l) => process.stderr.write(l + "\n"),
  tokens = [], origins = [], hosts = [], trustProxy = false,
} = {}) {
  const L = { ...LIMITS, ...limits };
  const lib = await import("../core/index.mjs");
  core ??= await lib.createCore();
  const wanted = tokens.map(digest);
  const auth = wanted.length > 0;
  const okHosts = new Set([...LOOPBACK, ...hosts]);
  let running = 0;
  const hits = new Map(); // 相手 → [分, 回数]

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const given = String(req.headers["x-request-id"] ?? "");
    const rid = /^[A-Za-z0-9._-]{1,64}$/.test(given) ? given : randomUUID();
    const origin = req.headers.origin;
    const cors = origin && origins.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Expose-Headers": "X-Request-Id, Retry-After" }
      : {};
    const send = (status, body, headers = {}) => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        ...BASE_HEADERS, ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "X-Request-Id": rid,
        ...headers,
      });
      res.end(text);
    };
    const fail = (status, code, message, headers) => send(status, { ok: false, error: { code, message, request_id: rid } }, headers);

    // 記録には入力の文も、相手の住所（IP）も、鍵も残しません（何を探したかは、その人のものです）。
    res.on("finish", () => log(`${new Date().toISOString()} ${rid} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      // 1. 見知らぬ Host（DNS を差し替えて手元のサーバーを呼ばせる手口）と、許していないページからの呼び出しを断ります。
      const hostName = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
      if (!auth && !okHosts.has(hostName)) return fail(403, "bad_host", "この名前では受けません（TABISAKI_ALLOW_HOST）");
      if (origin && !cors["Access-Control-Allow-Origin"]) return fail(403, "origin_not_allowed", "このページからは呼べません（TABISAKI_ALLOW_ORIGIN）");

      const path = url.pathname.replace(/^\/v1(?=\/)/, "");
      if (req.method === "OPTIONS" && (path === "/plan" || path === "/health")) {
        res.writeHead(204, {
          ...BASE_HEADERS, ...cors, "X-Request-Id": rid,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
          "Access-Control-Max-Age": "600",
        });
        return res.end();
      }
      if (path === "/health") {
        if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "method_not_allowed", "GET で呼んでください", { Allow: "GET" });
        return send(200, { ok: true, version: VERSION, api: API_VERSION, spots: core.kb?.spots?.length ?? null });
      }
      if (path !== "/plan") return fail(404, "not_found", "あるのは POST /v1/plan と GET /v1/health だけです");
      if (req.method !== "POST") return fail(405, "method_not_allowed", "POST で送ってください", { Allow: "POST" });

      // 2. 回数の上限。鍵を当てようとする試しも、ここで数えて止めます。
      let who = req.socket.remoteAddress ?? "?";
      if (trustProxy) {
        // 手前の逆プロキシが足した最後の1つだけを信じます（左側は相手が書き換えられる）。
        const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
        if (xff.length) who = xff[xff.length - 1];
      }
      const minute = Math.floor(Date.now() / 60000);
      const h = hits.get(who);
      const count = h && h[0] === minute ? h[1] + 1 : 1;
      hits.set(who, [minute, count]);
      if (hits.size > 1000) for (const [k, v] of hits) if (v[0] !== minute) hits.delete(k);
      if (count > L.perMinute) return fail(429, "rate_limited", "回数が多すぎます。1分おいてください", { "Retry-After": "60" });

      // 3. 認証（鍵を設定したときだけ）。
      if (auth) {
        const m = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""));
        if (!m || !tokenOk(m[1], wanted)) {
          return fail(401, "unauthorized", "Authorization: Bearer <鍵> を付けてください", { "WWW-Authenticate": 'Bearer realm="tabisaki"' });
        }
      }

      if (running >= L.concurrent) return fail(503, "busy", "ほかの旅程を組んでいます。少しおいてください", { "Retry-After": "5" });
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        return fail(415, "unsupported_media_type", "Content-Type: application/json で送ってください");
      }
      if (Number(req.headers["content-length"] ?? 0) > L.bodyBytes) {
        return fail(413, "too_large", `本文は ${L.bodyBytes} バイトまでです`, { Connection: "close" });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req, L.bodyBytes));
      } catch (e) {
        if (e.status === 413) return fail(413, "too_large", `本文は ${L.bodyBytes} バイトまでです`);
        return fail(400, "invalid_json", "本文が JSON として読めません");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "invalid_input", "本文は JSON のオブジェクトにしてください");
      const known = ["wish", "from", "days", "date", "start", "back", "transport", "markdown", "lang"];
      if (body.markdown !== undefined && typeof body.markdown !== "boolean") return fail(400, "invalid_input", "markdown は true か false にしてください");
      if (body.lang !== undefined && !lib.pickLang(body.lang)) return fail(400, "invalid_input", `lang は ${lib.LANGS.join(" / ")} のどれかです`);
      const extra = Object.keys(body).filter((k) => !known.includes(k));
      if (extra.length) return fail(400, "invalid_input", `知らない項目です: ${extra.join(", ")}`);

      running++;
      let timer;
      try {
        const result = await Promise.race([
          core.plan({ wish: body.wish, from: body.from, days: body.days, date: body.date,
            start: body.start, back: body.back, transport: body.transport }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { status: 504 })), L.timeoutMs); }),
        ]);
        const out = { ok: true, plan: JSON.parse(lib.toJson(result)) };
        if (body.markdown === true) out.markdown = lib.toMarkdown(result, { lang: body.lang });
        return send(200, out);
      } finally {
        clearTimeout(timer);
        running--;
      }
    } catch (e) {
      if (e?.status === 504) return fail(504, "timeout", `${L.timeoutMs / 1000}秒で組み終わりませんでした`);
      if (e?.code === "invalid_input" || e?.code === "unknown_place") return fail(400, e.code, e.message);
      if (e?.code === "plan_failed") return fail(422, "plan_failed", e.message);
      // 中のまちがいの詳しいことは記録にだけ出し、応答には出しません。
      log(`${rid} error: ${e?.stack ?? e}`);
      return fail(500, "internal", "サーバーの中でまちがいが起きました");
    }
  });
  server.requestTimeout = L.timeoutMs + 5000;
  server.headersTimeout = 10000;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  if (cfg.errors.length) {
    for (const e of cfg.errors) process.stderr.write(`起動しません: ${e}\n`);
    process.exit(2);
  }
  const server = await createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    process.stderr.write(`旅さき API: http://${cfg.host}:${cfg.port}/v1/plan （止めるときは Ctrl+C）\n`);
    process.stderr.write(cfg.tokens.length ? "認証: あり（Authorization: Bearer）\n" : "認証: なし（この端末の中だけで使ってください）\n");
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
