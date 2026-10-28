// 管理画面の中身: kb/ の点検・件数の集計・設定と変更待ち・変更の当て方。
//
// 書き込みは合言葉の向こうだけ、という約束（server/admin.js）も、
// ここで見ます。

import assert from "node:assert/strict";
import test from "node:test";

import { hiddenQuality, integrity, misclassified, unverified } from "../admin/kbcheck.js";
import { conditions, planOutcome, rounds, timing, usersByDay } from "../admin/statview.js";
import { cleanExtra, conditionsOf, metricBody } from "../js/metrics.js";
import { applyEdits } from "../server/kbedit.js";
import { cleanEdit, FLUSH_MS, Stats } from "../server/stats.js";
import worker, { metricRecord, usageOf, limitsFrom, secsBucket } from "../server/worker.js";

// --- kb/ の点検 -----------------------------------------------------------------
const sp = (o) => ({ id: "a-1", regionId: "r1", name: "名", category: "観光名所", lat: 35, lng: 139, _file: "s.json", ...o });

test("点検: 重複 id・範囲外・欠け・申告との違いを見つける", () => {
  const spots = [sp({ id: "a-1" }), sp({ id: "a-1", name: "別" }), sp({ id: "a-2", lat: 139, lng: 35, name: "逆" }),
                 sp({ id: "a-3", regionId: "zz", name: "迷子" })];
  const issues = integrity({ index: { counts: { spots: 9 }, shards: [{ file: "s.json", count: 2 }] },
    regions: [{ id: "r1" }, { id: "r2" }], spots });
  const titles = issues.map((x) => x.title);
  for (const t of ["index.json の件数が実数と違う", "シャードの件数が申告と違う", "id の重複",
                   "存在しないエリアを指している", "座標が日本の範囲の外", "スポットが1件も無いエリア"]) {
    assert.ok(titles.includes(t), t);
  }
});

test("点検: 正しいデータには何も言わない", () => {
  const issues = integrity({ index: { counts: { spots: 1 }, shards: [{ file: "s.json", count: 1 }] },
    regions: [{ id: "r1" }], spots: [sp({})] });
  assert.deepEqual(issues, []);
});

test("分類の誤り: 名前の終わりと食い違うものだけ", () => {
  const list = misclassified([
    sp({ id: "1", name: "鶴岡八幡宮", category: "寺院" }),     // 誤り
    sp({ id: "2", name: "金閣寺", category: "寺院" }),         // 正しい
    sp({ id: "3", name: "城山公園", category: "公園" }),       // 正しい
    sp({ id: "4", name: "大阪城", category: "史跡" }),         // 許す別名
    sp({ id: "5", name: "県立美術館", category: "山" }),       // 誤り
  ]);
  assert.deepEqual(list.map((x) => [x.id, x.to]), [["1", "神社"], ["5", "美術館"]]);
});

test("未確認: 確認日が無い・古いものを、有名なものから", () => {
  const now = Date.UTC(2026, 9, 10);
  const r = unverified([
    sp({ id: "1", fame_tier: "hidden" }),
    sp({ id: "2", fame_tier: "major" }),
    sp({ id: "3", fame_tier: "major", fetchedAt: now - 5 * 86400000 }),
    sp({ id: "4", fame_tier: "major", fetchedAt: now - 200 * 86400000 }),
  ], { now });
  assert.equal(r.unknown, 2); assert.equal(r.stale, 1); assert.equal(r.total, 3);
  assert.equal(r.top[0].tier, "major");
  assert.ok(!r.top.some((x) => x.id === "3"));
});

test("穴場の説明: 無い・短い・住所だけ・使い回し", () => {
  const rep = "美しい景色が広がります。ぜひ歩いてみてください。";
  const q = hiddenQuality([
    sp({ id: "1", fame_tier: "hidden" }),
    sp({ id: "2", fame_tier: "hidden", description: "短い" }),
    sp({ id: "3", fame_tier: "hidden", description: "大字坂元字山元(久渡寺内)" }),
    ...["4", "5", "6"].map((id) => sp({ id, fame_tier: "hidden", description: rep })),
    sp({ id: "7", fame_tier: "hidden", description: "ブナ林の中に宿が点在する温泉郷。白濁した湯で知られます。" }),
    sp({ id: "8", fame_tier: "major" }),
  ]);
  assert.equal(q.total, 7);
  assert.deepEqual(q.tally, { none: 1, short: 1, address: 1, repeated: 3, ok: 1 });
});

// --- 件数の集計（少ないとき）-----------------------------------------------------
test("集計: 協力者が少なくても壊れない", () => {
  assert.equal(planOutcome({}).rate, null);
  assert.equal(planOutcome({}).lowData, true);
  assert.equal(timing({}).avgSecs, null);
  assert.equal(rounds({}).avg, null);
  assert.deepEqual(conditions({}), {});
  assert.deepEqual(usersByDay({}), []);
});

test("集計: 成功率・平均時間・ラウンド数・条件", () => {
  const counts = { "2026-10-10": {
    event: { "plan_ok|car": 3, "plan_ok|transit": 1, "plan_error|network": 1 },
    sum: { "secs:plan_ok": 80, "n:plan_ok": 4, rounds: 6, rounds_n: 3 },
    secs: { "plan_ok:10-30": 4 },
    rounds: { 1: 1, 2: 2 },
    cond: { "plan_ok:t=car": 3, "plan_error:t=car": 1 },
    user: { aa11bb22: 5, cc33dd44: 1 },
  } };
  const o = planOutcome(counts);
  assert.equal(o.ok, 4); assert.equal(o.err, 1); assert.equal(o.rate, 0.8);
  assert.equal(timing(counts).avgSecs, 20);
  assert.equal(rounds(counts).avg, 2);
  assert.deepEqual(conditions(counts).t, [["car", 4]]);
  assert.deepEqual(usersByDay(counts)[0].users, 2);
});

// --- 送ってよいものだけ -----------------------------------------------------------
test("協力者の送信: 決まった言葉と数だけが残る", () => {
  const extra = cleanExtra({ s: 12.4, r: 3, c: { t: "car", days: "2", note: "京都の穴場で温泉", p: "ほか", g: ["onsen", "<script>"] } });
  assert.deepEqual(extra, { s: 12, r: 3, c: { t: "car", days: "2", g: ["onsen"] } });
  assert.deepEqual(cleanExtra({ s: -1, r: 99, c: "x" }), {});
  assert.deepEqual(JSON.parse(metricBody("plan_ok", "car", { s: 5 })), { e: "plan_ok", d: "car", s: 5 });
  const c = conditionsOf({ transport: "car", departAt: 0, arriveBy: 2 * 86400000 + 1, people: 4, note: "秘密", budgetYen: 1,
    hiddenBias: 0.8, interests: ["food"] }, { pinned: 1 });
  assert.deepEqual(c, { t: "car", days: "3", p: "3-4", b: "yes", h: "high", n: "yes", k: "no", pin: "yes", g: ["food"] });
  assert.ok(!JSON.stringify(c).includes("秘密"));
});

test("Worker の記録: 出来事・時間・条件・誤りを件数にする", () => {
  const r = metricRecord("plan_error", "network", { s: 45, c: { t: "car", g: ["sea"] } });
  const keys = r.items.map(([k, v]) => `${k}/${v}`);
  for (const k of ["event/plan_error|network", "secs/plan_error:30-60", "cond/plan_error:t=car", "cond/plan_error:g=sea"]) {
    assert.ok(keys.includes(k), k);
  }
  assert.equal(r.error.detail, "network");
  assert.equal(secsBucket(5), "0-10"); assert.equal(secsBucket(300), "120+");
});

test("Worker の記録: IP は件数に入れず、国コードと入口だけ", () => {
  const req = new Request("https://w.example/routes", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" } });
  const u = usageOf(req, new URL(req.url), 503);
  assert.deepEqual(u.items.map(([k]) => k), ["req", "country", "status"]);
  assert.ok(!JSON.stringify(u.items).includes("203.0.113.9"));
  assert.equal(u.error.code, "HTTP 503");
});

// --- 設定と変更待ち（Stats）--------------------------------------------------------
class Mem {
  constructor() { this.m = new Map(); }
  async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => this.m.has(x)).map((x) => [x, this.m.get(x)])) : this.m.get(k); }
  async put(k, v) { if (typeof k === "object") for (const [a, b] of Object.entries(k)) this.m.set(a, b); else this.m.set(k, v); }
  async delete(k) { for (const x of [].concat(k)) this.m.delete(x); return true; }
  async list({ prefix = "", start, end, reverse, limit } = {}) {
    let rows = [...this.m].filter(([k]) => k.startsWith(prefix) && (!start || k >= start) && (!end || k < end)).sort((a, b) => a[0] < b[0] ? -1 : 1);
    if (reverse) rows.reverse(); if (limit) rows = rows.slice(0, limit);
    return new Map(rows);
  }
  async getAlarm() { return null; } async setAlarm() {}
}
const stats = () => new Stats({ storage: new Mem() }, {});
const call = (s, method, path, body) => s.fetch(new Request(`https://stats${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })).then((r) => r.json());

test("Stats: 数えて、利用者は日ごとの塩つきハッシュで区別する", async () => {
  const s = stats();
  await call(s, "POST", "/record", { ip: "198.51.100.1", items: [["req", "/routes", 1], ["country", "JP", 1]] });
  await call(s, "POST", "/record", { ip: "198.51.100.1", items: [["req", "/routes", 1]] });
  await call(s, "POST", "/record", { ip: "198.51.100.2", items: [["bad kind!", "x", 1], ["req", "/routes", 1]], error: { code: "HTTP 500", detail: "d", path: "/routes" } });
  const sum = await call(s, "GET", "/summary?days=7");
  const day = Object.values(sum.counts)[0];
  assert.equal(day.req["/routes"], 3);
  assert.equal(day.bad, undefined);
  const users = Object.entries(day.user);
  assert.equal(users.length, 2);
  assert.ok(users.every(([k]) => /^[0-9a-f]{8}$/.test(k)));
  assert.ok(!JSON.stringify(sum).includes("198.51.100"));
  assert.equal(sum.errors.length, 1);
});

test("上限は環境変数だけで決まる（管理画面の「設定」はやめた）", () => {
  assert.equal(limitsFrom({ RATE_PAID_PER_MINUTE: "11" }).paid.minute, 11);
  assert.equal(limitsFrom({}).paid.minute > 0, true);
});

// Durable Object の無料枠は、書き込む行が1日10万行まで。1回ごとに書かない。
test("Stats: 件数はメモリに貯め、まとめて書く（同じ鍵は1行）", async () => {
  const mem = new Mem(); let puts = 0; let rows = 0; let alarms = 0;
  const put = mem.put.bind(mem);
  mem.put = async (k, v) => { puts++; rows += typeof k === "object" ? Object.keys(k).length : 1; return put(k, v); };
  mem.setAlarm = async () => { alarms++; };
  const s = new Stats({ storage: mem }, {});
  for (let i = 0; i < 100; i++) {
    await call(s, "POST", "/record", { ip: "198.51.100.1", items: [["req", "/routes", 1], ["country", "JP", 1]] });
  }
  // 100回呼んでも、書いたのはその日の塩の1行だけ。予約も1回だけ。
  assert.equal(rows, 1, "1回ごとに書いています");
  assert.equal(alarms, 1, "1回ごとに予約しています");
  assert.ok(FLUSH_MS <= 60_000, "まとめる間隔が長すぎると、落ちたときに失うぶんが増えます");
  // 予約の時刻が来たら、まとめて書く。鍵は req・country・user の3つ。
  rows = 0;
  await s.alarm();
  assert.equal(rows, 3 + 1, "まとめて書いていません（3行 + 片付けた日の印）");
  const day = Object.values((await call(s, "GET", "/summary?days=1")).counts)[0];
  assert.equal(day.req["/routes"], 100);
  assert.equal(day.country.JP, 100);
});

test("Stats: 管理画面で見るときは、まだ書いていないぶんも数える", async () => {
  const s = stats();
  await call(s, "POST", "/record", { items: [["req", "/routes", 1]] });
  const day = Object.values((await call(s, "GET", "/summary?days=1")).counts)[0];
  assert.equal(day.req["/routes"], 1);
});

test("Stats: 誤りが続いても、1回に書くのは決まった数まで", async () => {
  const s = stats();
  for (let i = 0; i < 200; i++) {
    await call(s, "POST", "/record", { items: [["req", "/routes", 1]], error: { code: "HTTP 500", path: "/routes" } });
  }
  assert.ok((await call(s, "GET", "/summary?days=1")).errors.length <= 20);
});

test("Stats: 片付けで、やめた「設定」の残りも消す", async () => {
  const mem = new Mem();
  await mem.put("settings", { disabled: ["/routes"], limits: null });
  const s = new Stats({ storage: mem }, {});
  await s.alarm();
  assert.equal(await mem.get("settings"), undefined);
});

test("変更待ち: 形を絞り、同じものは1つにする", async () => {
  assert.equal(cleanEdit({ op: "delete" }), null);
  assert.equal(cleanEdit({ op: "category", id: "a", regionId: "r" }), null);
  assert.equal(cleanEdit({ op: "add", spot: { name: "x", regionId: "r", category: "山", lat: 0, lng: 0, id: "q" } }), null);
  const ok = cleanEdit({ op: "add", spot: { id: "adm-1", name: "新", regionId: "r", category: "山", lat: 35.123456, lng: 139.5, description: "d", extra: "x" } });
  assert.equal(ok.spot.lat, 35.12346); assert.equal(ok.spot.src, "admin"); assert.equal(ok.spot.extra, undefined);
  const s = stats();
  await call(s, "POST", "/edits", { op: "delete", id: "a-1", regionId: "r1", name: "N" });
  await call(s, "POST", "/edits", { op: "delete", id: "a-1", regionId: "r1", name: "N" });
  assert.equal((await call(s, "GET", "/edits")).edits.length, 1);
  assert.equal((await call(s, "POST", "/edits", { op: "bogus" })).ok, false);
  assert.equal((await call(s, "DELETE", "/edits")).removed, 1);
});

// --- 変更を kb/ に当てる ----------------------------------------------------------
test("kb への適用: 追加・削除・分類・説明と、件数の更新", () => {
  const doc = { spots: [sp({ id: "r1-1", name: "A神社", category: "寺院" }), sp({ id: "r1-2", name: "B" })] };
  const index = { counts: { spots: 2 }, shards: [{ file: "s.json", count: 2, regions: ["r1"] }] };
  const names = { names: "A神社\nB" };
  const edits = [
    { op: "category", id: "r1-1", regionId: "r1", category: "神社" },
    { op: "delete", id: "r1-2", regionId: "r1", dropName: true },
    { op: "add", id: "n-1", regionId: "r1", name: "C", spot: { id: "n-1", regionId: "r1", name: "C", category: "山", lat: 35, lng: 139, fame_tier: "hidden", src: "admin" } },
    { op: "description", id: "none", regionId: "r1" },
  ];
  const out = applyEdits({ index: JSON.stringify(index), shards: new Map([["s.json", JSON.stringify(doc)]]), names: JSON.stringify(names), edits });
  assert.equal(out.applied.length, 3); assert.equal(out.skipped.length, 1);
  const shard = JSON.parse(out.files.get("kb/s.json"));
  assert.deepEqual(shard.spots.map((s) => [s.id, s.category]), [["r1-1", "神社"], ["n-1", "山"]]);
  assert.equal(JSON.parse(out.files.get("kb/index.json")).counts.spots, 2);
  assert.equal(JSON.parse(out.files.get("kb/names.json")).names, "A神社\nC");
  assert.ok(!out.files.get("kb/s.json").includes("\n"), "詰めた JSON のまま");
});

// --- Worker の入口 ----------------------------------------------------------------
const auth = { Authorization: `Basic ${Buffer.from("u:pw").toString("base64")}` };
const W = "https://w.example";

test("管理用の書き込みは、合言葉と見出しと同じ出どころがそろったときだけ", async () => {
  const s = stats();
  const env = { ADMIN_PASSWORD: "pw", STATS: { idFromName: () => "g", get: () => ({ fetch: (u, i) => s.fetch(new Request(u, i)) }) } };
  const put = (headers) => worker.fetch(new Request(`${W}/private/api/edits`, { method: "POST", body: JSON.stringify({ op: "delete", id: "a-1", regionId: "r1", name: "N" }), headers }), env);

  assert.equal((await put({})).status, 401);                                        // 合言葉なし
  assert.equal((await put({ ...auth })).status, 403);                               // 見出しなし
  assert.equal((await put({ ...auth, "X-Admin-Request": "1", Origin: "https://evil.example" })).status, 403);
  const good = await put({ ...auth, "X-Admin-Request": "1", Origin: W });
  assert.equal(good.status, 200);
  assert.equal((await call(s, "GET", "/edits")).edits.length, 1);
  // 「設定」の入口はもう無い。
  const gone = await worker.fetch(new Request(`${W}/private/api/settings`, { method: "PUT", body: "{}", headers: { ...auth, "X-Admin-Request": "1", Origin: W } }), env);
  assert.equal(gone.status, 404);
});

test("公開側の入口からは、管理用の書き込みに届かない", async () => {
  const s = stats();
  const env = { ADMIN_PASSWORD: "pw", STATS: { idFromName: () => "g", get: () => ({ fetch: (u, i) => s.fetch(new Request(u, i)) }) } };
  const res = await worker.fetch(new Request(`${W}/edits`, { method: "POST", headers: { Origin: "https://shitianliang1000-alt.github.io" }, body: "{}" }), env);
  assert.equal(res.status, 404);
  assert.deepEqual((await call(s, "GET", "/edits")).edits, []);
});
