// 中継の「重さ」と「断りかた」。
//
// 無料枠は、使い切ると追加課金ではなく**その種類の処理が失敗**します。
// つまり、止まるときは全員に対して止まります。だから中継の仕事は2つ。
//
//   1. 重いものを叩かれすぎないように、重さに応じて数える
//   2. 断るときは、受け取る側が次の手を決められる形で断る

import assert from "node:assert/strict";
import test from "node:test";

import worker, { RateLimiter, costOf } from "../server/worker.js";
import { readProxyError } from "../packages/core/src/endpoints.js";

const ORIGIN = "https://shitianliang1000-alt.github.io";

// --- 1. 重さ ----------------------------------------------------------------

test("処理の重さに応じて点を数える", () => {
  // /status はこちらで完結します。数える必要がありません。
  assert.equal(costOf("/status"), 0);
  // 無料でも取りに行くもの < 課金されるもの < 枠を分け合うもの
  assert.ok(costOf("/yahoo/transit") < costOf("/routes"));
  assert.ok(costOf("/routes") <= costOf("/gemini/generate"));
  assert.equal(costOf("/cf/generate"), costOf("/gemini/generate"));
  // 知らない入口は、ひとまず1点として数えます（0にはしません）。
  assert.equal(costOf("/なにか"), 1);
});

/** Durable Object の代わり。storage だけ持てば足ります。 */
function fakeState() {
  const map = new Map();
  return {
    storage: {
      get: async (k) => map.get(k),
      put: async (k, v) => void map.set(k, v),
      deleteAll: async () => map.clear(),
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
}

// 上限そのものは環境変数で変えられるので、テストでは明示して渡します。
// 「20点だから4回」のような数合わせにすると、上限を触るたびに壊れます。
const LIM = (free, paid) =>
  `&limits=${encodeURIComponent(JSON.stringify({
    free: { minute: free, hour: free * 10 },
    paid: { minute: paid, hour: paid * 10 },
  }))}`;

test("重い処理は、軽い処理より早く上限に当たる", async () => {
  const heavy = new RateLimiter(fakeState());
  let ok = 0;
  // 5点の処理は、1分20点なら4回で使い切ります。
  for (let i = 0; i < 6; i++) {
    const r = await (await heavy.fetch(
      new Request(`https://rate/check?cost=5${LIM(600, 20)}`))).json();
    if (r.ok) ok++;
  }
  assert.equal(ok, 4, "5点の処理が4回を超えて通っています");

  const light = new RateLimiter(fakeState());
  let okLight = 0;
  for (let i = 0; i < 6; i++) {
    const r = await (await light.fetch(
      new Request(`https://rate/check?cost=1${LIM(600, 20)}`))).json();
    if (r.ok) okLight++;
  }
  assert.equal(okLight, 6, "1点の処理まで早く止めています");
});

// --- 枠は2つ ---------------------------------------------------------------
//
// 以前は全部を1つの枠で数えていました。旅程1本で電車・バスを30区間ほど
// 聞くので、1分20点は最初の1本の途中で尽きます。**無料のYahoo!が、
// お金のかかるGeminiと同じ枠を奪い合っていた**わけで、数えかたの誤りでした。

test("電車・バスは、AIや経路APIの枠を食べない", async () => {
  const rl = new RateLimiter(fakeState());
  // 電車・バスを、AI枠なら使い切るだけ呼びます。
  for (let i = 0; i < 40; i++) {
    const r = await (await rl.fetch(
      new Request(`https://rate/check?cost=1&pool=free${LIM(600, 20)}`))).json();
    assert.equal(r.ok, true, `${i + 1}回目で断られました`);
  }
  // そのあとでも、AIは満額から使えます。
  const usage = await (await rl.fetch(
    new Request(`https://rate/usage?${LIM(600, 20).slice(1)}`))).json();
  assert.equal(usage.usage.paid.minute, 0,
    "電車・バスがAIの枠を減らしています");
  assert.equal(usage.usage.free.minute, 40);
  const ai = await (await rl.fetch(
    new Request(`https://rate/check?cost=5${LIM(600, 20)}`))).json();
  assert.equal(ai.ok, true, "AIが呼べなくなっています");
});

test("電車・バスの枠にも、歯止めはある", async () => {
  const rl = new RateLimiter(fakeState());
  let ok = 0;
  for (let i = 0; i < 8; i++) {
    const r = await (await rl.fetch(
      new Request(`https://rate/check?cost=1&pool=free${LIM(5, 20)}`))).json();
    if (r.ok) ok++;
  }
  assert.equal(ok, 5, "無料の枠が青天井になっています");
});

test("旅程1本ぶんの区間を、既定の枠で通せる", async () => {
  // 5日の旅程で30区間、名前を何通りか試して60回ほど。届かないはずです。
  const rl = new RateLimiter(fakeState());
  for (let i = 0; i < 90; i++) {
    const r = await (await rl.fetch(
      new Request("https://rate/check?cost=1&pool=free"))).json();
    assert.equal(r.ok, true, `${i + 1}区間目で断られました`);
  }
});

test("0点の処理は、いくら呼んでも枠を減らさない", async () => {
  const rl = new RateLimiter(fakeState());
  for (let i = 0; i < 50; i++) {
    const r = await (await rl.fetch(
      new Request("https://rate/check?cost=0"))).json();
    assert.equal(r.ok, true);
  }
  const usage = await (await rl.fetch(
    new Request("https://rate/usage"))).json();
  assert.equal(usage.usage.minute, 0);
});

test("いま何点使っているかを、減らさずに見られる", async () => {
  const rl = new RateLimiter(fakeState());
  await rl.fetch(new Request("https://rate/check?cost=3"));
  const a = await (await rl.fetch(new Request("https://rate/usage"))).json();
  const b = await (await rl.fetch(new Request("https://rate/usage"))).json();
  assert.equal(a.usage.minute, 3);
  assert.equal(b.usage.minute, 3, "見ただけで減っています");
  assert.equal(a.usage.minuteLimit > 0, true);
});

// --- 2. 断りかた ------------------------------------------------------------

test("断るときは、次の手を決められる形で返す", async () => {
  const res = await worker.fetch(
    new Request("https://x/なにもない入口", { method: "POST", body: "{}" }),
    { ALLOW_ORIGIN: ORIGIN });
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(typeof body.error.code, "string");
  assert.equal(typeof body.error.retryable, "boolean");
  // 前からある形（error.message）は壊しません。
  assert.equal(typeof body.error.message, "string");
});

test("受け取る側は、やり直せるかどうかを番号から推し量らない", () => {
  const limit = readProxyError(
    '{"ok":false,"error":{"code":"UPSTREAM_LIMIT","service":"routes",'
    + '"retryable":true,"message":"いま利用が集中しています。"}}', 429);
  assert.equal(limit.code, "UPSTREAM_LIMIT");
  assert.equal(limit.retryable, true);
  assert.equal(limit.service, "routes");

  // 形の違う返事（古い中継・素の500）でも、読めるところまでは読みます。
  const broken = readProxyError("<html>502 Bad Gateway</html>", 502);
  assert.equal(broken.retryable, true);
  assert.match(broken.message, /時間をおいて/);

  // やり直しても同じもの（キー未設定）は、retryable を立てません。
  const noKey = readProxyError(
    '{"ok":false,"error":{"code":"NOT_CONFIGURED","retryable":false,'
    + '"message":"中継にキーがありません"}}', 503);
  assert.equal(noKey.retryable, false);
});

// --- 3. 余力の出しかた ------------------------------------------------------
//
// 画面には「1分 undefined/undefined点」と出ていました。中の返事が
// { ok, usage } の形なのに、それをそのまま /status の usage へ入れて
// いたので、外から見ると usage.usage になっていたためです。

test("/status の usage は、そのまま読める形で返す", async () => {
  // 数を持つ側（Durable Object）の代わり。
  const store = new Map();
  const state = {
    storage: {
      get: async (k) => store.get(k),
      put: async (k, v) => { store.set(k, v); },
      deleteAll: async () => store.clear(),
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const limiter = new RateLimiter(state);
  const env = {
    ALLOW_ORIGIN: ORIGIN,
    // 本物のスタブは文字列でも受けます。ここでは Request に包みます。
    RATE: {
      idFromName: () => "id",
      get: () => ({ fetch: (u) => limiter.fetch(new Request(u)) }),
    },
  };

  const res = await worker.fetch(new Request("https://p/status", {
    method: "POST", headers: { origin: ORIGIN, "cf-connecting-ip": "1.2.3.4" },
  }), env);
  const body = await res.json();

  assert.ok(body.usage, "usage がありません");
  assert.equal(typeof body.usage.minute, "number",
    "usage.minute が数ではありません（包みが1枚多いままです）");
  assert.equal(typeof body.usage.minuteLimit, "number");
  assert.equal(typeof body.usage.hour, "number");
  assert.equal(typeof body.usage.hourLimit, "number");
  assert.equal(body.usage.usage, undefined, "usage が二重に包まれています");
});

test("RATE_LIMIT を off にすれば、数えるのをやめる", async () => {
  // 自分だけで使う中継なら、数える意味はありません。逃げ道を用意します。
  let asked = 0;
  const env = {
    ALLOW_ORIGIN: ORIGIN,
    RATE_LIMIT: "off",
    RATE: { idFromName: () => "id",
            get: () => ({ fetch: () => { asked++; throw new Error("呼ぶな"); } }) },
  };
  const res = await worker.fetch(new Request("https://p/status", {
    method: "POST", headers: { origin: ORIGIN, "cf-connecting-ip": "1.2.3.4" },
  }), env);
  assert.equal((await res.json()).ok, true);
  assert.equal(asked, 0, "off なのに数えに行っています");
});

test("上限は、中継の環境変数で変えられる", async () => {
  const store = new Map();
  const limiter = new RateLimiter(fakeState());
  const env = {
    ALLOW_ORIGIN: ORIGIN,
    RATE_PAID_PER_MINUTE: "7",
    RATE_FREE_PER_MINUTE: "999",
    RATE: { idFromName: () => "id",
            get: () => ({ fetch: (u) => limiter.fetch(new Request(u)) }) },
  };
  const res = await worker.fetch(new Request("https://p/status", {
    method: "POST", headers: { origin: ORIGIN, "cf-connecting-ip": "1.2.3.4" },
  }), env);
  const u = (await res.json()).usage;
  assert.equal(u.paid.minuteLimit, 7);
  assert.equal(u.free.minuteLimit, 999);
});

// --- 書き込みの数 -----------------------------------------------------------
// Durable Object の無料枠は「書き込む行が1日10万行」まで。超えると、
// その日はレート制限ごと止まります（2026-10-27 に一度当たりました）。

/** 書いた回数を数える代役。 */
function countingState() {
  const map = new Map();
  const n = { puts: 0, alarms: 0 };
  return {
    n,
    storage: {
      get: async (k) => map.get(k),
      put: async (k, v) => { n.puts++; map.set(k, v); },
      deleteAll: async () => map.clear(),
      setAlarm: async () => { n.alarms++; },
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
}

test("続けて呼ばれても、毎回は書かない", async () => {
  const state = countingState();
  const rl = new RateLimiter(state);
  for (let i = 0; i < 30; i++) {
    const r = await (await rl.fetch(
      new Request("https://rate/check?cost=1&pool=free"))).json();
    assert.equal(r.ok, true);
  }
  assert.equal(state.n.puts, 1, "呼ばれるたびに書いています");
  assert.equal(state.n.alarms, 1, "呼ばれるたびに予約しています");
  // 書いていなくても、数えかたは同じ（メモリに持っている）。
  const usage = await (await rl.fetch(new Request("https://rate/usage"))).json();
  assert.equal(usage.usage.free.minute, 30);
});

test("断るときは書かない（叩かれても書き込みが増えない）", async () => {
  const state = countingState();
  const rl = new RateLimiter(state);
  for (let i = 0; i < 50; i++) {
    await rl.fetch(new Request(`https://rate/check?cost=5${LIM(600, 10)}`));
  }
  assert.equal(state.n.puts, 1, "断った回数だけ書いています");
});

test("書いた記録は、落ちて作り直されたあとも読める", async () => {
  const state = countingState();
  await new RateLimiter(state).fetch(new Request("https://rate/check?cost=5"));
  const again = new RateLimiter(state);
  const u = await (await again.fetch(new Request("https://rate/usage"))).json();
  assert.equal(u.usage.paid.minute, 5);
});
