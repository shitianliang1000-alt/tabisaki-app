// APIの使用量に上限をかける仕組みのテスト。
//
// 「50件を超えたら許可を取る。さらに50件超えたらもう一度取る」を、
// 数え忘れや取りこぼしなく守れているかを見ます。
// 課金に直結するので、実装より先にここで挙動を決めます。

import assert from "node:assert/strict";
import test from "node:test";

import {
  ApiQuota, QuotaBlockedError, describeUsage, meteredFetch,
} from "../packages/core/src/quota.js";

/** 承認を自動で返す門番。何回聞かれたかを数えます。 */
function autoApprove(answer = true) {
  const asked = [];
  return { asked, ask: async (info) => { asked.push(info); return answer; } };
}

test("50件までは、何も聞かずに通す", async () => {
  const gate = autoApprove();
  const q = new ApiQuota({ every: 50, ask: gate.ask });
  for (let i = 0; i < 50; i++) assert.equal(await q.take("routes"), true);
  assert.equal(gate.asked.length, 0);
  assert.equal(q.used, 50);
});

test("51件目で許可を求める", async () => {
  const gate = autoApprove();
  const q = new ApiQuota({ every: 50, ask: gate.ask });
  for (let i = 0; i < 51; i++) await q.take("routes");
  assert.equal(gate.asked.length, 1);
  assert.equal(gate.asked[0].used, 50);
});

test("さらに50件ごとに、もう一度許可を求める", async () => {
  const gate = autoApprove();
  const q = new ApiQuota({ every: 50, ask: gate.ask });
  for (let i = 0; i < 151; i++) await q.take("routes");
  assert.equal(gate.asked.length, 3, "50 / 100 / 150 の3回で聞くはずです");
  assert.deepEqual(gate.asked.map((a) => a.used), [50, 100, 150]);
});

test("断られたら、そこから先は通さない", async () => {
  const gate = autoApprove(false);
  const q = new ApiQuota({ every: 50, ask: gate.ask });
  for (let i = 0; i < 50; i++) await q.take("routes");
  assert.equal(await q.take("routes"), false);
  assert.equal(await q.take("routes"), false, "断ったあとに聞き直しています");
  assert.equal(gate.asked.length, 1);
  assert.equal(q.blocked, true);
});

test("種類ごとの内訳を持つ（何にいくつ使ったか）", async () => {
  const q = new ApiQuota({ every: 50, ask: autoApprove().ask });
  await q.take("routes");
  await q.take("routes");
  await q.take("gemini");
  assert.deepEqual(q.byKind, { routes: 2, gemini: 1 });
});

test("同時に何本も走っても、二重に聞かない", async () => {
  const gate = autoApprove();
  const q = new ApiQuota({ every: 10, ask: async (i) => {
    await new Promise((r) => setTimeout(r, 5));
    return gate.ask(i);
  } });
  for (let i = 0; i < 10; i++) await q.take("routes");
  // 上限に達した状態で、まとめて5本走らせる
  await Promise.all(Array.from({ length: 5 }, () => q.take("routes")));
  assert.equal(gate.asked.length, 1, `${gate.asked.length}回 聞いています`);
});

test("数え直せる（次の旅程で聞かれ直すことはない）", async () => {
  const q = new ApiQuota({ every: 50, ask: autoApprove().ask });
  for (let i = 0; i < 60; i++) await q.take("routes");
  q.reset();
  assert.equal(q.used, 0);
  assert.equal(q.blocked, false);
  assert.deepEqual(q.byKind, {});
});

test("保存と復元ができる（再読み込みで数がゼロに戻らない）", async () => {
  const store = new Map();
  const fake = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  };
  const a = new ApiQuota({ every: 50, ask: autoApprove().ask, storage: fake });
  for (let i = 0; i < 7; i++) await a.take("gemini");
  const b = new ApiQuota({ every: 50, ask: autoApprove().ask, storage: fake });
  assert.equal(b.used, 7);
  assert.deepEqual(b.byKind, { gemini: 7 });
});

test("承認を求めるときは、何に使ったかを渡す", async () => {
  const gate = autoApprove();
  const q = new ApiQuota({ every: 3, ask: gate.ask });
  await q.take("routes"); await q.take("routes"); await q.take("gemini");
  await q.take("routes");
  assert.deepEqual(gate.asked[0].byKind, { routes: 2, gemini: 1 });
  assert.equal(gate.asked[0].next, 3, "次に許す件数を伝えていません");
});

// --- 通信の入口で止める -----------------------------------------------------
// 数えるだけでは意味がありません。断られたときに「本当に呼ばない」ことを
// 確かめます。ここが緩いと、確認画面を出しながら課金だけが続きます。

test("許可の範囲内なら、そのまま通信する", async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push([url, init]); return { ok: true }; };
  const q = new ApiQuota({ every: 50, ask: autoApprove().ask });
  const res = await meteredFetch("routes", "https://example.test/a",
    { method: "POST" }, { quota: q, fetchImpl: fake });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://example.test/a");
  assert.equal(q.used, 1);
});

test("断られたあとは、通信そのものを行わない", async () => {
  let calls = 0;
  const fake = async () => { calls++; return { ok: true }; };
  const q = new ApiQuota({ every: 2, ask: autoApprove(false).ask });
  await meteredFetch("routes", "u", {}, { quota: q, fetchImpl: fake });
  await meteredFetch("routes", "u", {}, { quota: q, fetchImpl: fake });
  await assert.rejects(
    () => meteredFetch("routes", "u", {}, { quota: q, fetchImpl: fake }),
    (e) => e instanceof QuotaBlockedError);
  assert.equal(calls, 2, `断ったあとに ${calls - 2} 回 呼んでいます`);
});

test("止まった理由が、そのまま画面に出せる日本語である", async () => {
  const q = new ApiQuota({ every: 1, ask: autoApprove(false).ask });
  await meteredFetch("gemini", "u", {}, { quota: q, fetchImpl: async () => ({}) });
  await assert.rejects(
    () => meteredFetch("gemini", "u", {}, { quota: q, fetchImpl: async () => ({}) }),
    /使用量/);
});

test("使用状況を、そのまま文にできる", () => {
  const q = new ApiQuota({ every: 50, ask: autoApprove().ask });
  q.used = 50; q.byKind = { routes: 38, gemini: 12 };
  const s = describeUsage(q);
  assert.match(s, /50/);
  assert.match(s, /経路/);
  assert.match(s, /AI/);
});

test("状態が変わったら知らせる（画面の表示がずれない）", async () => {
  // 断られたことは ask の返事より後に確定します。画面側が「返事を
  // もらった直後」に描くと、まだ blocked が立っておらず、止めたのに
  // 「あと50件」と出ます。通知はこちらから出します。
  const seen = [];
  const q = new ApiQuota({ every: 1, ask: autoApprove(false).ask,
                           onChange: (g) => seen.push(g.blocked) });
  await q.take("routes");
  seen.length = 0;
  assert.equal(await q.take("routes"), false);
  assert.ok(seen.length > 0, "断られたことを知らせていません");
  assert.equal(seen.at(-1), true, "止めた状態で知らせていません");
});
