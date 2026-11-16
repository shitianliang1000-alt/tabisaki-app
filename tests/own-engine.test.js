// 自前エンジン（server/own-engine.mjs + own-store.mjs + server/transit.js の
// own プロバイダ）の確認。
//
// 小さな合成 GTFS（tests/fixtures/own-gtfs-mini）を tools/own_convert.py で
// 変換し、できた小さい DB で「変換 → エンジン検索」を確かめます。
// 実データ（熊本 28MB）はテストに入れません。
//
//   st1 駅前 (z1) --r1 バス--> st2 公園前 (z1) --> st3 神社前 (z2) --r2 電車--> st4 山頂 (z2)
//   r1: st1 発 08:00/08:30/09:00/09:30/23:30、st3 着は +12分
//   r2: st3 発 08:20/09:14/23:50、st4 着は +15分
//       （09:14 は、st1 から歩いて st3 へ着く 09:15 過ぎには間に合わない時刻。
//        バスで乗り継ぐ経路だけが拾える）
//   運賃: z1→z1 200円、z1→z2 350円、z2→z2 250円
//
// python3 が無い環境では、変換が要るテストを飛ばします。

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { available, providerStatus, transitHandler, TransitError } from "../server/transit.js";
import { searchDepart, searchLast } from "../server/own-engine.mjs";
import { createD1Store, localStoreFor } from "../server/own-store.mjs";

const FIXTURE = new URL("./fixtures/own-gtfs-mini/", import.meta.url).pathname;
const REPO = new URL("../", import.meta.url).pathname;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "own-engine-"));
  const feeds = join(dir, "feeds");
  execFileSync("python3", ["-c", `
import zipfile, os, sys
os.makedirs(sys.argv[2], exist_ok=True)
z = zipfile.ZipFile(os.path.join(sys.argv[2], "mini.zip"), "w")
for f in sorted(os.listdir(sys.argv[1])):
    z.write(os.path.join(sys.argv[1], f), f)
z.close()
`, FIXTURE, feeds]);
  const db = join(dir, "mini.db");
  const report = join(dir, "report.json");
  const sql = join(dir, "mini.sql");
  const kv = join(dir, "kv.json");
  execFileSync("python3", [join(REPO, "tools/own_convert.py"), feeds, db,
    "--report", report, "--sql", sql, "--kv", kv], { stdio: "pipe" });
  return { dir, db, report: JSON.parse(readFileSync(report, "utf8")),
           sql: readFileSync(sql, "utf8"),
           kvPayload: JSON.parse(readFileSync(kv, "utf8")) };
}

let built = null;
let setupError = null;
try { built = setup(); } catch (e) { setupError = e; }
const skip = setupError ? `変換ツールを回せませんでした: ${setupError.message}` : false;

const ST1 = { lat: 32.8000, lng: 130.7000 };
const ST3 = { lat: 32.8060, lng: 130.7060 };
const ST4 = { lat: 32.8200, lng: 130.7200 };
const BODY = (over = {}) => ({
  from: "駅前", to: "神社前", fromAt: ST1, toAt: ST3,
  departAt: "2026-11-18T09:00:00+09:00", provider: "own", ...over,
});

test("変換: stop_times は欠けなくパックされ、D1 用 SQL と KV 用ペイロードも出る", { skip }, () => {
  assert.equal(built.report.check_stop_times.match, true);
  assert.equal(built.report.totals.stops, 4);
  assert.equal(built.report.totals.trips, 12);
  assert.equal(built.report.totals.patterns, 4);
  assert.match(built.sql, /CREATE TABLE stop_patterns/);
  assert.match(built.sql, /INSERT INTO "stop_patterns"/);
  const cells = built.kvPayload;
  assert.ok(cells.length >= 1 && cells.every((c) => c.key.startsWith("stops:")));
  const n = cells.reduce((s, c) => s + JSON.parse(c.value).length, 0);
  assert.equal(n, 4);
});

test("使えるもの: own は D1 バインディングか OWN_ENGINE_DB があるときだけ", { skip }, () => {
  assert.equal(available("own", {}), false);
  assert.equal(available("own", { OWN_ENGINE_DB: built.db }), true);
  const st = providerStatus({});
  assert.equal(st.providers[0].name, "own");
  assert.equal(st.providers[0].label, "自前エンジン");
  assert.equal(st.providers[0].lastTrain, true);
});

test("中継（手元ストア）: 出発検索で直通が引け、運賃も付く", { skip }, async () => {
  const out = await transitHandler(BODY(), { OWN_ENGINE_DB: built.db });
  assert.equal(out.routed, true);
  assert.equal(out.provider, "own");
  assert.equal(out.providerLabel, "自前エンジン");
  assert.equal(out.meta.departure, "09:00");
  assert.equal(out.meta.arrival, "09:12");
  assert.equal(out.meta.transfers, 0);
  assert.equal(out.meta.fareYen, 350);
  const ride = out.meta.legs.find((l) => l.kind === "ride");
  assert.equal(ride.from, "駅前");
  assert.equal(ride.to, "神社前");
});

test("中継（手元ストア）: バスから電車への乗り換えと、運賃の合計", { skip }, async () => {
  const out = await transitHandler(BODY({ to: "山頂", toAt: ST4 }), { OWN_ENGINE_DB: built.db });
  assert.equal(out.routed, true);
  assert.equal(out.meta.arrival, "09:29");
  assert.equal(out.meta.transfers, 1);
  assert.equal(out.meta.fareYen, 600);
  const rides = out.meta.legs.filter((l) => l.kind === "ride");
  assert.equal(rides.length, 2);
  assert.match(rides[0].line, /ミニバス本線/);
  assert.match(rides[1].line, /ミニ電車/);
});

test("中継（手元ストア）: 終電は、その日いちばん遅く出られる便", { skip }, async () => {
  const out = await transitHandler(BODY({ search: "last" }), { OWN_ENGINE_DB: built.db });
  assert.equal(out.routed, true);
  assert.equal(out.meta.departure, "23:30");
  assert.equal(out.meta.arrival, "23:42");
});

test("地域ゲート: 採用地域の外は、名指しでも「経路なし」で次へ回す", { skip }, async () => {
  const out = await transitHandler(BODY({
    fromAt: { lat: 35.6812, lng: 139.7671 }, toAt: { lat: 35.6896, lng: 139.7006 },
  }), { OWN_ENGINE_DB: built.db });
  assert.equal(out.routed, false);
  // auto では own が先頭に試される
  const auto = await transitHandler(BODY({ provider: "auto" }),
    { OWN_ENGINE_DB: built.db, LS8H: "off", TRANSITOUS: "off" });
  assert.equal(auto.provider, "own");
  assert.deepEqual(auto.tried, [{ provider: "own", routed: true }]);
});

test("名指しで設定が無ければ 503", async () => {
  await assert.rejects(transitHandler(BODY(), {}),
    (e) => e instanceof TransitError && e.status === 503 && e.code === "not_configured");
});

// ── D1 ストア（Workers 用の読み方）を、node:sqlite の薄い shim で確かめる ──

function d1Shim(dbPath) {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql);
      const wrap = (args) => ({
        all: async () => ({ results: stmt.all(...args) }),
        first: async () => stmt.get(...args) ?? null,
      });
      return { bind: (...args) => wrap(args), ...wrap([]) };
    },
  };
}

test("D1 ストア: pattern/trip を読み、運賃は区間ごとに引く。最寄りは KV から", { skip }, async () => {
  const kvMap = new Map(built.kvPayload.map((c) => [c.key, c.value]));
  const kv = { get: async (k) => { const v = kvMap.get(k); return v ? JSON.parse(v) : null; } };
  const store = createD1Store(d1Shim(built.db), kv);

  const near = await store.stopsWithin({ ...ST1 }, 1500);
  assert.equal(near[0].uid, 1);
  assert.equal(near[0].walkSecs, 0);

  const q = { from: { ...ST1, name: "駅前" }, to: { ...ST3, name: "神社前" },
              date: "2026-11-18", timeSecs: 9 * 3600 };
  const route = await searchDepart(store, q);
  assert.equal(route.departure, "09:00");
  assert.equal(route.arrival, "09:12");
  assert.equal(route.fareYen, 350);

  const last = await searchLast(store, { ...q, timeSecs: undefined });
  assert.equal(last.departure, "23:30");
  assert.equal(last.arrival, "23:42");
});

test("手元ストア: localStoreFor は同じファイルを1回だけ読む", { skip }, async () => {
  const a = await localStoreFor(built.db);
  const b = await localStoreFor(built.db);
  assert.equal(a, b);
  const route = await searchDepart(a, {
    from: { ...ST1, name: "駅前" }, to: { ...ST4, name: "山頂" },
    date: "2026-11-18", timeSecs: 9 * 3600,
  });
  assert.equal(route.arrival, "09:29");
  assert.equal(route.transfers, 1);
});
