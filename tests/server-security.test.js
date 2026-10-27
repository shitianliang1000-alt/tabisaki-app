// API サーバーの安全の決めごと（docs/api.md の「試験の項目」）。
// 偽の core を使うので、旅程は組みません。

import assert from "node:assert/strict";
import test from "node:test";

import { createServer, loadConfig } from "../packages/server/server.mjs";

const TOKEN = "t".repeat(40);
const fake = { kb: { spots: [1, 2] }, plan: async () => ({
  request: { wish: "温泉", origin: { name: "東京駅" }, days: 1, departAt: 0, arriveBy: 0, transport: "any" },
  itinerary: { title: "x", days: [] },
}) };

async function start(opts = {}) {
  const lines = [];
  const server = await createServer({ core: fake, log: (l) => lines.push(l), ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = "POST", headers = {}, body } = {}) => fetch(base + path, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json", ...headers } : headers,
    body: method === "POST" ? JSON.stringify(body ?? { wish: "温泉" }) : undefined,
  });
  return { call, lines, close: () => new Promise((r) => server.close(r)) };
}

test("設定: 127.0.0.1 以外で鍵が無ければ起動しない", () => {
  assert.deepEqual(loadConfig({}).errors, []);
  assert.equal(loadConfig({}).host, "127.0.0.1");
  assert.match(loadConfig({ HOST: "0.0.0.0" }).errors.join(), /TABISAKI_API_TOKEN が要ります/);
  assert.deepEqual(loadConfig({ HOST: "0.0.0.0", TABISAKI_API_TOKEN: TOKEN }).errors, []);
  assert.deepEqual(loadConfig({ HOST: "0.0.0.0", TABISAKI_NO_AUTH: "1" }).errors, []);
});

test("設定: 短い鍵・ * の Origin・読めない鍵ファイルは断る", () => {
  assert.match(loadConfig({ TABISAKI_API_TOKEN: "short" }).errors.join(), /32 文字以上/);
  assert.match(loadConfig({ TABISAKI_ALLOW_ORIGIN: "*" }).errors.join(), /ALLOW_ORIGIN/);
  assert.match(loadConfig({ TABISAKI_API_TOKEN_FILE: "/nope" }, { readFile: () => { throw new Error(); } }).errors.join(), /読めません/);
  const c = loadConfig({ TABISAKI_API_TOKEN_FILE: "/run/secrets/x" }, { readFile: () => `${TOKEN}\n${"u".repeat(40)}\n` });
  assert.equal(c.tokens.length, 2);
});

test("鍵があると、無い・ちがう鍵は 401", async () => {
  const s = await start({ tokens: [TOKEN] });
  try {
    const no = await s.call("/v1/plan");
    assert.equal(no.status, 401);
    assert.match(no.headers.get("www-authenticate"), /^Bearer/);
    assert.equal((await no.json()).error.code, "unauthorized");
    assert.equal((await s.call("/v1/plan", { headers: { Authorization: `Bearer ${TOKEN}x` } })).status, 401);
    assert.equal((await s.call("/v1/plan", { headers: { Authorization: `Basic ${TOKEN}` } })).status, 401);
    assert.equal((await s.call("/v1/plan", { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    // 鍵は記録に残さない
    assert.ok(s.lines.every((l) => !l.includes(TOKEN)));
  } finally { await s.close(); }
});

test("鍵のまちがいも回数に数え、当てずっぽうを止める", async () => {
  const s = await start({ tokens: [TOKEN], limits: { perMinute: 3 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.call("/v1/plan")).status, 401);
    assert.equal((await s.call("/v1/plan", { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 429);
  } finally { await s.close(); }
});

test("/health は鍵なしで呼べ、版を返す", async () => {
  const s = await start({ tokens: [TOKEN] });
  try {
    const j = await (await s.call("/v1/health", { method: "GET" })).json();
    assert.deepEqual([j.ok, j.api, j.spots], [true, 1, 2]);
    assert.equal((await s.call("/health", { method: "GET" })).status, 200);
  } finally { await s.close(); }
});

test("/v1/plan と前の /plan は同じもの", async () => {
  const s = await start();
  try {
    assert.equal((await s.call("/v1/plan")).status, 200);
    assert.equal((await s.call("/plan")).status, 200);
    assert.equal((await s.call("/v2/plan")).status, 404);
  } finally { await s.close(); }
});

test("失敗はどれも {ok:false, error:{code, message, request_id}} で、X-Request-Id と同じ", async () => {
  const s = await start();
  try {
    const res = await s.call("/v1/plan", { body: { wish: "温泉", x: 1 } });
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.deepEqual(Object.keys(j.error).sort(), ["code", "message", "request_id"]);
    assert.equal(j.error.request_id, res.headers.get("x-request-id"));
    // 相手が付けた番号は、形が正しければそのまま使う
    const r2 = await s.call("/v1/plan", { headers: { "X-Request-Id": "abc-123" } });
    assert.equal(r2.headers.get("x-request-id"), "abc-123");
    const r3 = await s.call("/v1/plan", { headers: { "X-Request-Id": "a b<script>" } });
    assert.notEqual(r3.headers.get("x-request-id"), "a b<script>");
    assert.equal((await s.call("/v1/plan", { body: { wish: "温泉", markdown: "yes" } })).status, 400);
  } finally { await s.close(); }
});

test("CORS: 既定では、どのページからも呼べない", async () => {
  const s = await start();
  try {
    const res = await s.call("/v1/plan", { headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  } finally { await s.close(); }
});

test("CORS: 許したページだけ、下調べ（OPTIONS）と本番が通る", async () => {
  const s = await start({ origins: ["https://app.example"] });
  try {
    const pre = await s.call("/v1/plan", { method: "OPTIONS", headers: { Origin: "https://app.example" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://app.example");
    assert.match(pre.headers.get("access-control-allow-headers"), /Authorization/);
    const ok = await s.call("/v1/plan", { headers: { Origin: "https://app.example" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("vary"), "Origin");
    assert.equal((await s.call("/v1/plan", { headers: { Origin: "https://other.example" } })).status, 403);
  } finally { await s.close(); }
});

test("認証なしのときは、見知らぬ Host を断る（DNS の差し替え対策）", async () => {
  const s = await start();
  try {
    // fetch は Host を変えられないので、node:http で送ります
    const http = await import("node:http");
    const port = Number(new URL((await s.call("/v1/health", { method: "GET" })).url).port);
    const status = (host) => new Promise((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/v1/health", headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode); }).on("error", reject);
    });
    assert.equal(await status("evil.example"), 403);
    assert.equal(await status(`localhost:${port}`), 200);
    assert.equal(await status(`[::1]:${port}`), 200);
  } finally { await s.close(); }
});

test("逆プロキシの後ろでは、最後の X-Forwarded-For で数える", async () => {
  const s = await start({ trustProxy: true, limits: { perMinute: 1 } });
  try {
    const as = (ip) => s.call("/v1/plan", { headers: { "X-Forwarded-For": `1.1.1.1, ${ip}` } });
    assert.equal((await as("10.0.0.1")).status, 200);
    assert.equal((await as("10.0.0.2")).status, 200);
    assert.equal((await as("10.0.0.1")).status, 429);
  } finally { await s.close(); }
});

test("応答には安全のための見出しが付き、中のまちがいは漏らさない", async () => {
  const boom = { kb: { spots: [] }, plan: async () => { throw new Error("SECRET_PATH /home/x"); } };
  const s = await start({ core: boom });
  try {
    const res = await s.call("/v1/plan");
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!(await res.text()).includes("SECRET_PATH"));
    assert.ok(s.lines.some((l) => l.includes("SECRET_PATH")));
  } finally { await s.close(); }
});
