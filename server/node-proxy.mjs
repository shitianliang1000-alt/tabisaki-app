/**
 * 旅さき — APIキーを預かるバックエンド（Node、依存なし）
 *
 * Cloudflare を使わない場合の、同じ役割のものです。
 * Node 18 以上でそのまま動きます。
 *
 *   GEMINI_API_KEY=xxx MAPS_API_KEY=yyy \
 *   ALLOW_ORIGIN=https://example.com \
 *   node server/node-proxy.mjs
 *
 * 本番では、この前に必ず TLS を置いてください（Nginx / Caddy など）。
 * packages/core/src/config.js の PROXY_URL は https でなければ受け付けません。
 *
 * ここが守っていること
 * --------------------
 * 「APIキーを隠したから安全」ではありません。キーを隠しても、この入口が
 * 誰でも叩ける状態なら、**このプロキシ自体が無料のAPIとして使われます**。
 * 請求は持ち主に来ます。CORS は止める役に立ちません。ブラウザの中でしか
 * 効かない約束事で、curl や スクリプトには何の関係もないためです。
 *
 * そこで、次の順に落とします。
 *   1. Origin        … 設定していれば、そこ以外は 403
 *   2. レート制限     … IPごとに 1分/1時間の上限
 *   3. 本文の大きさ   … 上限を超えたら読まずに切る
 *   4. 入力の中身     … モデル名・形をここで確かめる
 *   5. タイムアウト   … 上流が返さないときに掴んだままにしない
 * 失敗の理由は外に細かく返しません（探られる材料になります）。
 */

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? "";
const ALLOW_ORIGINS = ALLOW_ORIGIN.split(/[,\s]+/).filter(Boolean);
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? "";
const MAPS_KEY = process.env.MAPS_API_KEY ?? "";

/** 1つのIPからの上限。既定は「ふつうに旅程を作る人」には当たらない値です。 */
const PER_MINUTE = Number(process.env.RATE_PER_MINUTE ?? 20);
const PER_HOUR = Number(process.env.RATE_PER_HOUR ?? 200);
/** 本文の上限（バイト）。旅程1回ぶんの候補一覧でも 200KB には届きません。 */
const MAX_BODY = Number(process.env.MAX_BODY_BYTES ?? 512 * 1024);
/** 上流を待つ時間。ここを空けたままにすると、掴んだ接続が溜まります。 */
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 30_000);

/**
 * 自分で立てたモデル（Gemma など）の入口。OpenAI 互換を想定します。
 * 空なら /local/generate は 404 になります。
 *
 *   LOCAL_BASE_URL=http://127.0.0.1:11434 node server/node-proxy.mjs
 *
 * ここは**自分の機械の中**を指すので https でなくて構いません。
 * ただし、外から届く場所に置かないでください。
 */
const LOCAL_BASE_URL = (process.env.LOCAL_BASE_URL ?? "").replace(/\/+$/, "");
/** 呼ばれてよいローカルモデル。空なら何でも通します（自分の機械なので）。 */
const LOCAL_MODELS = new Set(
  (process.env.LOCAL_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const ALLOWED_MODELS = new Set([
  "gemini-3.7-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite",
  "gemini-embedding-001",
]);

// --- レート制限 -------------------------------------------------------------
// 依存を増やさないため、素の Map で持ちます。1プロセス内でのみ有効です。
// 複数台に並べるなら、ここは Redis などの共有の置き場に替えてください。

const hits = new Map();   // ip -> { minute: number[], hour: number[] }

/**
 * Node は1本のイベントループで動くので、この関数の中に await が
 * 無いかぎり、途中で別の呼び出しに割り込まれることはありません。
 * **await を入れないでください。** 入れた瞬間に、Cloudflare 版で
 * 起きていたのと同じ「読んでから書くまでに割り込まれる」が起きます。
 */

/** 期限切れを落として、いまの件数を数えます。 */
export function rateCheck(store, ip, now = Date.now(),
                          perMinute = PER_MINUTE, perHour = PER_HOUR) {
  const rec = store.get(ip) ?? { minute: [], hour: [] };
  rec.minute = rec.minute.filter((t) => now - t < 60_000);
  rec.hour = rec.hour.filter((t) => now - t < 3_600_000);
  if (rec.minute.length >= perMinute) {
    store.set(ip, rec);
    return { ok: false, retryAfter: 60 };
  }
  if (rec.hour.length >= perHour) {
    store.set(ip, rec);
    return { ok: false, retryAfter: 600 };
  }
  rec.minute.push(now);
  rec.hour.push(now);
  store.set(ip, rec);
  return { ok: true };
}

/** 使われていないIPを捨てます。放っておくと Map が伸び続けます。 */
function startSweeper() {
  return setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of hits) {
      if (rec.hour.every((t) => now - t >= 3_600_000)) hits.delete(ip);
    }
  }, 600_000).unref?.();
}

/**
 * 呼び出し元のIP。逆プロキシの後ろに置く前提なので X-Forwarded-For を見ます。
 * ただし**信用できるのは自分の逆プロキシが付けた最後の1つだけ**です。
 * 先頭を使うと、送り手が好きな値を書いて制限をすり抜けられます。
 */
export function clientIp(headers, socketAddr = "") {
  const xff = String(headers["x-forwarded-for"] ?? "").split(",")
    .map((s) => s.trim()).filter(Boolean);
  return (process.env.TRUST_PROXY === "1" && xff.length ? xff.at(-1) : "")
    || socketAddr || "unknown";
}

// --- 入口 -------------------------------------------------------------------

export const handler = async (req, res) => {
  const origin = req.headers.origin ?? "";
  const allowed = ALLOW_ORIGINS.includes("*") ? (origin || "*")
    : (ALLOW_ORIGINS.includes(origin) ? origin : (ALLOW_ORIGINS[0] || origin || "*"));
  const head = {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Goog-FieldMask",
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, head); return res.end(); }
  if (req.method !== "POST") return send(res, 405, head, "POST のみです");

  // 1. Origin。
  //
  //    ブラウザは、クロスオリジンの POST に必ず Origin を付けます。
  //    付いていないということは、ブラウザから来ていないということです
  //    （curl・スクリプト・他のサーバー）。空も弾きます。
  //
  //    これは認証ではありません。Origin は名乗りにすぎず、直に叩く側は
  //    好きな値を書けます。次の関門はレート制限です。
  //    ALLOW_ORIGIN が未設定の間だけ素通ししますが、起動時に警告します。
  if (ALLOW_ORIGINS.length && !ALLOW_ORIGINS.includes(origin) && !ALLOW_ORIGINS.includes("*")) {
    return send(res, 403, head, "このサイトからは呼べません");
  }

  // 2. レート制限
  const ip = clientIp(req.headers, req.socket?.remoteAddress ?? "");
  const gate = rateCheck(hits, ip);
  if (!gate.ok) {
    return send(res, 429, { ...head, "Retry-After": String(gate.retryAfter) },
      "呼び出しが多すぎます。しばらく待ってからお試しください。");
  }

  // 3. 本文の大きさ
  let raw;
  try { raw = await read(req, MAX_BODY); }
  catch (e) {
    if (e?.code === "TOO_LARGE") return send(res, 413, head, "本文が大きすぎます");
    return send(res, 400, head, "本文を読めません");
  }
  let body;
  try { body = JSON.parse(raw); }
  catch { return send(res, 400, head, "本文を読めません"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return send(res, 400, head, "本文の形が違います");
  }

  const path = (req.url ?? "").split("?")[0].replace(/\/+$/, "");
  try {
    if (path.endsWith("/gemini/generate") || path.endsWith("/gemini/embed")) {
      const method = path.endsWith("/embed") ? "embedContent" : "generateContent";
      const model = String(body?.model ?? "");
      if (!ALLOWED_MODELS.has(model)) return send(res, 400, head, "そのモデルは使えません");
      const { model: _drop, ...payload } = body;
      const r = await upstream(
        `${GEMINI_ROOT}/models/${encodeURIComponent(model)}:${method}`,
        { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        payload);
      res.writeHead(r.status, head);
      return res.end(r.text);
    }
    if (path.endsWith("/local/generate")) {
      if (!LOCAL_BASE_URL) {
        return send(res, 404, head, "ローカルモデルは設定されていません");
      }
      const model = String(body?.model ?? "");
      if (LOCAL_MODELS.size && !LOCAL_MODELS.has(model)) {
        return send(res, 400, head, "そのモデルは使えません");
      }
      // 自分の機械なので課金はありませんが、レート制限は同じように
      // かけています（この入口だけ開けっぱなしにしない）。
      const r = await upstream(`${LOCAL_BASE_URL}/v1/chat/completions`,
        { "Content-Type": "application/json" }, body);
      res.writeHead(r.status, head);
      return res.end(r.text);
    }
    if (path.endsWith("/routes")) {
      // 4. 入力の中身。経路は起点と終点が要ります。無いものを上流に流すと、
      //    課金される呼び出しを、こちらが肩代わりして失敗させるだけです。
      if (!body.origin || !body.destination) {
        return send(res, 400, head, "経路の起点と終点が必要です");
      }
      const mask = String(req.headers["x-goog-field-mask"] ?? "").slice(0, 500);
      const r = await upstream(ROUTES_URL, {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": MAPS_KEY,
        "X-Goog-FieldMask": mask,
      }, body);
      res.writeHead(r.status, head);
      return res.end(r.text);
    }
  } catch (e) {
    // 中の事情は外に出しません
    console.error(e);
    const timedOut = e?.name === "AbortError" || e?.name === "TimeoutError";
    return send(res, timedOut ? 504 : 502, head,
      timedOut ? "上流の応答がありませんでした" : "処理できませんでした");
  }
  return send(res, 404, head, "その入口はありません");
};

// 直に実行されたときだけ待ち受けます。テストから読み込んだだけで
// ポートを掴まれると、テストが終わりません。
if (import.meta.url === `file://${process.argv[1]}`) {
  startSweeper();
  createServer(handler).listen(PORT, () => {
    console.log(`旅さきのプロキシを http://localhost:${PORT} で待ち受けます`);
    console.log(`レート制限: ${PER_MINUTE}回/分・${PER_HOUR}回/時（IPごと）`);
    if (LOCAL_BASE_URL) {
      console.log(`ローカルモデル: ${LOCAL_BASE_URL}`
        + (LOCAL_MODELS.size ? `（${[...LOCAL_MODELS].join(", ")} のみ）` : ""));
    }
    if (!GEMINI_KEY) console.warn("GEMINI_API_KEY が空です");
    if (!MAPS_KEY) console.warn("MAPS_API_KEY が空です");
    if (ALLOW_ORIGIN.length === 0) {
      console.warn("ALLOW_ORIGIN が空です。公開するなら必ず設定してください"
        + "（例: ALLOW_ORIGIN=https://example.com）");
    }
  });
}

// 5. タイムアウト。上流が返さないときに、掴んだままにしません。
async function upstream(url, headers, payload) {
  const r = await fetch(url, {
    method: "POST", headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return { status: r.status, text: await r.text() };
}

function send(res, status, head, message) {
  res.writeHead(status, head);
  res.end(JSON.stringify({ error: { message } }));
}

/** 上限を超えたら、そこで読むのをやめます（最後まで受けてから測らない）。 */
async function read(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) {
      const err = new Error("too large");
      err.code = "TOO_LARGE";
      req.destroy();
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
