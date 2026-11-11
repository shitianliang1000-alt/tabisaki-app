// 「開いた中継」対策（#448）。
//
// Origin は名乗りにすぎないので、本当の歯止めは回数制限です。その回数
// 制限の穴を2つ塞ぎます。
//
//   1. IPv6 の末尾を変えるだけで、枠が増えていた → /64 ごとに数える
//   2. 全体の上限が無く、IP をたくさん持つ相手が無料枠・課金を使い切れた
//      → お金のかかる側に、全員の合計で1日の上限を置く

import assert from "node:assert/strict";
import test from "node:test";

import worker, { RateLimiter } from "../server/worker.js";
import { dailyCheck } from "../server/node-proxy.mjs";
import { DEFAULT_PAID_PER_DAY, dailyLimit, jstDay, rateKey, secondsToJstMidnight }
  from "../server/relay-guard.js";

const ORIGIN = "https://shitianliang1000-alt.github.io";

test("IPv4 はそのまま数える", () => {
  assert.equal(rateKey("203.0.113.9"), "203.0.113.9");
  assert.equal(rateKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(rateKey(""), "unknown");
});

test("IPv6 は /64 ごとにまとめる（末尾を変えても同じ枠）", () => {
  const a = rateKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
  const b = rateKey("2001:0db8:1234:5678::1");
  const c = rateKey("2001:DB8:1234:5678:0:0:0:ffff");
  assert.equal(a, "2001:db8:1234:5678::/64");
  assert.equal(b, a);
  assert.equal(c, a);
  // 隣の /64 は別の枠です。
  assert.notEqual(rateKey("2001:db8:1234:5679::1"), a);
  // 省略が先頭にあっても読めます。
  assert.equal(rateKey("::1"), "0:0:0:0::/64");
  assert.equal(rateKey("2001:db8::"), "2001:db8:0:0::/64");
  assert.equal(rateKey("[2001:db8:1:2::3]"), "2001:db8:1:2::/64");
});

test("読めない値は、そのまま返す（数えないよりはまし）", () => {
  assert.equal(rateKey("2001:db8::1::2"), "2001:db8::1::2");
  assert.equal(rateKey("zzzz:1:2:3::"), "zzzz:1:2:3::");
});

test("1日は日本時間の0時で切り替わる", () => {
  // 2026-11-10 15:00 UTC = 2026-11-11 0:00 JST
  const midnight = Date.UTC(2026, 10, 10, 15, 0, 0);
  assert.equal(jstDay(midnight - 1000), "2026-11-10");
  assert.equal(jstDay(midnight), "2026-11-11");
  assert.equal(secondsToJstMidnight(midnight - 1000), 1);
  assert.equal(secondsToJstMidnight(midnight), 86_400);
});

test("1日の上限は変数で変えられ、off で外せる", () => {
  assert.equal(dailyLimit({}), DEFAULT_PAID_PER_DAY);
  assert.equal(dailyLimit({ RATE_PAID_PER_DAY: "123" }), 123);
  assert.equal(dailyLimit({ RATE_PAID_PER_DAY: "off" }), null);
  assert.equal(dailyLimit({ RATE_PAID_PER_DAY: "0" }), null);
  assert.equal(dailyLimit({ RATE_PAID_PER_DAY: "abc" }), DEFAULT_PAID_PER_DAY);
});

/** Durable Object の置き場を、名前ごとに分けて持つ代役。 */
function fakeNamespace() {
  const objects = new Map();
  const names = [];
  return {
    names,
    idFromName: (name) => { names.push(name); return name; },
    get: (id) => {
      if (!objects.has(id)) {
        const map = new Map();
        objects.set(id, new RateLimiter({
          storage: {
            get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v),
            deleteAll: async () => map.clear(), setAlarm: async () => {},
          },
          blockConcurrencyWhile: (fn) => fn(),
        }));
      }
      const rl = objects.get(id);
      return { fetch: (u) => rl.fetch(new Request(u)) };
    },
  };
}

const call = (env, path, ip) => worker.fetch(new Request(`https://p${path}`, {
  method: "POST", headers: { origin: ORIGIN, "cf-connecting-ip": ip },
  body: "{}",
}), env);

test("中継は IPv6 を /64 の名前で数える", async () => {
  const RATE = fakeNamespace();
  await call({ ALLOW_ORIGIN: ORIGIN, RATE }, "/status", "2001:db8:1:2:3:4:5:6");
  assert.ok(RATE.names.includes("2001:db8:1:2::/64"), RATE.names.join(", "));
  assert.ok(!RATE.names.includes("2001:db8:1:2:3:4:5:6"));
});

test("IP を変えても、全員の合計が1日の上限を超えたら断る", async () => {
  const RATE = fakeNamespace();
  // 経路（3点）を、毎回ちがう IP から。1つずつは上限のずっと内側です。
  const env = { ALLOW_ORIGIN: ORIGIN, RATE, RATE_PAID_PER_DAY: "9" };
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const res = await call(env, "/routes", `198.51.100.${i + 1}`);
    codes.push(res.status === 429 ? (await res.json()).error.code : "passed");
  }
  // 3点 × 3回 = 9点まで通り、4回目からは断ります。
  assert.deepEqual(codes.slice(0, 3).every((c) => c === "passed"), true, codes.join(","));
  assert.equal(codes[3], "DAILY_LIMIT");
  assert.equal(codes[4], "DAILY_LIMIT");
});

test("1日の上限に当たった返事は、待つ秒数を持ち、自動のやり直しはさせない", async () => {
  const RATE = fakeNamespace();
  const env = { ALLOW_ORIGIN: ORIGIN, RATE, RATE_PAID_PER_DAY: "1" };
  const res = await call(env, "/gemini/generate", "198.51.100.7");
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.code, "DAILY_LIMIT");
  assert.equal(body.error.retryable, false);
  assert.ok(Number(res.headers.get("Retry-After")) > 0);
  assert.ok(res.headers.get("Access-Control-Allow-Origin"), "CORS が付いていません");
});

test("無料の電車・バスは、全員の合計に入らない", async () => {
  const RATE = fakeNamespace();
  const env = { ALLOW_ORIGIN: ORIGIN, RATE, RATE_PAID_PER_DAY: "1" };
  await call(env, "/transit/providers", "198.51.100.8");
  await call(env, "/status", "198.51.100.8");
  const status = await (await call(env, "/status", "198.51.100.8")).json();
  assert.equal(status.daily.points, 0);
  assert.equal(status.daily.limit, 1);
});

test("RATE_PAID_PER_DAY=off なら、合計は数えない", async () => {
  const RATE = fakeNamespace();
  const env = { ALLOW_ORIGIN: ORIGIN, RATE, RATE_PAID_PER_DAY: "off" };
  await call(env, "/status", "198.51.100.9");
  assert.ok(!RATE.names.includes("__daily__"));
});

test("合計の置き場は、片付け（alarm）で消えない", async () => {
  const map = new Map();
  const rl = new RateLimiter({
    storage: {
      get: async (k) => map.get(k), put: async (k, v) => void map.set(k, v),
      deleteAll: async () => map.clear(), setAlarm: async () => {},
    },
    blockConcurrencyWhile: (fn) => fn(),
  });
  await rl.fetch(new Request("https://rate/daily?cost=5&limit=100"));
  await rl.alarm();
  const after = await (await rl.fetch(new Request("https://rate/daily-usage?limit=100"))).json();
  assert.equal(after.daily.points, 5);
});

test("自前の Node 中継にも、全員の合計の上限がある", () => {
  const store = { d: "", n: 0 };
  const now = Date.UTC(2026, 10, 11, 3, 0, 0);
  assert.equal(dailyCheck(store, now, 2).ok, true);
  assert.equal(dailyCheck(store, now, 2).ok, true);
  const over = dailyCheck(store, now, 2);
  assert.equal(over.ok, false);
  assert.ok(over.retryAfter > 0);
  // 次の日は数え直します。
  assert.equal(dailyCheck(store, now + 86_400_000, 2).ok, true);
  // 0 なら上限なし。
  assert.equal(dailyCheck({ d: "", n: 0 }, now, 0).ok, true);
});
