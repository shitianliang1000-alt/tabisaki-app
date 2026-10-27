// 旅さきの手元用 API サーバー（packages/server）。
//
//     node packages/server/server.mjs           # http://127.0.0.1:8787
//     docker compose up                          # 同じものを Docker で（compose.yaml）
//
//     curl -X POST http://127.0.0.1:8787/plan \
//       -H 'Content-Type: application/json' \
//       -d '{"wish":"温泉と海","days":2}'
//
// 手元で使う前提です（認証はありません）。だから既定では 127.0.0.1 にしか
// 待ち受けません。インターネットに出すときの要件は Issue #376 で決めます。
// 外へは通信しません（packages/core と同じ）。
//
// 応答:
//   POST /plan   200 {ok:true, plan:{…packages/core の JSON…}, markdown?}
//                400 {ok:false, error:{code, message}}（入力のまちがい）
//                413 / 415 / 429 / 503 / 504 / 500
//   GET  /health 200 {ok:true, version, spots}

import http from "node:http";
import { readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

export const LIMITS = {
  bodyBytes: 4096,       // 希望の文は500字まで。JSON の枠を足しても足ります
  timeoutMs: 30000,      // 1本の旅程にかける時間の上限
  concurrent: 2,         // 同時に組む本数（CPU を食い尽くさないように）
  perMinute: 30,         // 1つの相手から1分に受ける回数
};

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(text);
};
const fail = (res, status, code, message, headers) => send(res, status, { ok: false, error: { code, message } }, headers);

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
 * @param {{core?: object, limits?: object, log?: (line: string) => void}} [opts]
 */
export async function createServer({ core, limits = {}, log = (l) => process.stderr.write(l + "\n") } = {}) {
  const L = { ...LIMITS, ...limits };
  const lib = await import("../core/index.mjs");
  core ??= await lib.createCore();
  let running = 0;
  const hits = new Map(); // 相手 → [分, 回数]

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    // 記録には入力の文を残しません（何を探したかは、その人のものです）。
    res.on("finish", () => log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, version: VERSION, spots: core.kb?.spots?.length ?? null });
      }
      if (url.pathname !== "/plan") return fail(res, 404, "not_found", "あるのは POST /plan と GET /health だけです");
      if (req.method !== "POST") return fail(res, 405, "method_not_allowed", "POST で送ってください", { Allow: "POST" });
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        return fail(res, 415, "unsupported_media_type", "Content-Type: application/json で送ってください");
      }
      const who = req.socket.remoteAddress ?? "?";
      const minute = Math.floor(Date.now() / 60000);
      const h = hits.get(who);
      const count = h && h[0] === minute ? h[1] + 1 : 1;
      hits.set(who, [minute, count]);
      if (hits.size > 1000) for (const [k, v] of hits) if (v[0] !== minute) hits.delete(k);
      if (count > L.perMinute) return fail(res, 429, "rate_limited", "回数が多すぎます。1分おいてください", { "Retry-After": "60" });
      if (running >= L.concurrent) return fail(res, 503, "busy", "ほかの旅程を組んでいます。少しおいてください", { "Retry-After": "5" });

      if (Number(req.headers["content-length"] ?? 0) > L.bodyBytes) {
        return fail(res, 413, "too_large", `本文は ${L.bodyBytes} バイトまでです`, { Connection: "close" });
      }
      let body;
      try {
        body = JSON.parse(await readBody(req, L.bodyBytes));
      } catch (e) {
        if (e.status === 413) return fail(res, 413, "too_large", `本文は ${L.bodyBytes} バイトまでです`);
        return fail(res, 400, "invalid_json", "本文が JSON として読めません");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "invalid_input", "本文は JSON のオブジェクトにしてください");
      const known = ["wish", "from", "days", "date", "start", "back", "transport", "markdown", "lang"];
      if (body.lang !== undefined && !lib.pickLang(body.lang)) return fail(res, 400, "invalid_input", `lang は ${lib.LANGS.join(" / ")} のどれかです`);
      const extra = Object.keys(body).filter((k) => !known.includes(k));
      if (extra.length) return fail(res, 400, "invalid_input", `知らない項目です: ${extra.join(", ")}`);

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
        return send(res, 200, out);
      } finally {
        clearTimeout(timer);
        running--;
      }
    } catch (e) {
      if (e?.status === 504) return fail(res, 504, "timeout", `${L.timeoutMs / 1000}秒で組み終わりませんでした`);
      if (e?.code === "invalid_input" || e?.code === "unknown_place") return fail(res, 400, e.code, e.message);
      if (e?.code === "plan_failed") return fail(res, 422, "plan_failed", e.message);
      log(`error: ${e?.stack ?? e}`);
      return fail(res, 500, "internal", "サーバーの中でまちがいが起きました");
    }
  });
  server.requestTimeout = L.timeoutMs + 5000;
  server.headersTimeout = 10000;
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);
  const server = await createServer();
  server.listen(port, host, () => {
    process.stderr.write(`旅さき API: http://${host}:${port}/plan （止めるときは Ctrl+C）\n`);
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      process.stderr.write("注意: 127.0.0.1 以外で待ち受けています。認証が無いので、インターネットに直接出さないでください。\n");
    }
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
