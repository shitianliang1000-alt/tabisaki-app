// ユーザーKB（packages/core/userkb.mjs）と、公式 kb/ への重ね合わせの試験。
// 置き場は試験ごとに作る一時フォルダです。~/.tabisaki には触りません。

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  SCHEMA, UserKbError, addSpot, applyOverlay, baseStamp, checkOverlay, emptyOverlay, isUserSpotId,
  migrateOverlay, newUserSpotId, openStore, patchSpot, removeSpot, undoEntry, userKbHome, validateKbName,
  validateSpot,
} from "../packages/core/userkb.mjs";
import { createCore } from "../packages/core/index.mjs";

const tmpHome = () => mkdtemp(path.join(os.tmpdir(), "tabisaki-home-"));
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return "ok"; };
const codeAsync = async (p) => { try { await p; } catch (e) { return e.code; } return "ok"; };

// 小さな公式の知識ベース（loadKnowledgeBase の返すものと同じ形）。
function fakeKb() {
  const regions = [
    { id: "takao", name: "高尾山", prefecture: "東京都", lat: 35.625, lng: 139.243 },
    { id: "hakone", name: "箱根", prefecture: "神奈川県", lat: 35.2324, lng: 139.1069 },
  ];
  const spots = [
    { id: "takao-1", regionId: "takao", name: "高尾山薬王院", category: "寺院", lat: 35.6256, lng: 139.2472, fee: 0, description: "山腹の寺" },
    { id: "takao-2", regionId: "takao", name: "高尾山山頂", category: "展望台", lat: 35.6252, lng: 139.2434 },
    { id: "hakone-1", regionId: "hakone", name: "箱根神社", category: "神社", lat: 35.2048, lng: 139.0254 },
  ];
  return {
    manifest: { counts: { regions: 2, spots: 3 } }, regions, spots,
    regionsById: new Map(regions.map((r) => [r.id, r])),
    spotsById: new Map(spots.map((s) => [s.id, s])),
    spotsByRegion: new Map([["takao", spots.slice(0, 2)], ["hakone", [spots[2]]]]),
  };
}

test("名前と id の決まり", () => {
  assert.equal(validateKbName("my-trips_2"), "my-trips_2");
  for (const bad of ["", "../x", "a/b", "A", "-x", ".x", "x".repeat(41), "名前", "a b"]) {
    assert.equal(code(() => validateKbName(bad)), "invalid_name", bad);
  }
  const id = newUserSpotId(0);
  assert.ok(isUserSpotId(id), id);
  assert.ok(!isUserSpotId("takao-1"));
  assert.notEqual(newUserSpotId(), newUserSpotId());
});

test("スポットの項目を確かめる（知らない項目・範囲外・URL・制御文字）", () => {
  const ok = validateSpot({ name: " 秘密の滝\u0007 ", lat: "35.1", lng: 139.2, genres: ["nature", "nature"], url: "https://example.jp/a" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.name, "秘密の滝");
  assert.equal(ok.value.lat, 35.1);
  assert.deepEqual(ok.value.genres, ["nature"]);

  const bad = validateSpot({ name: "", lat: 91, lng: "x", src: "osm", url: "javascript:alert(1)", genres: ["ufo"], fee: 1.5, open: 18, close: 9 });
  const all = bad.errors.join("\n");
  for (const want of [/name が空/, /lat は -90〜90/, /lng は数/, /知らない項目です: src/, /http\(s\)/, /genres に知らない値/, /fee は整数/, /close は open より後/]) {
    assert.match(all, want);
  }
  assert.match(validateSpot({ lat: 1, lng: 1 }).errors.join(), /name は必須/);
  assert.deepEqual(validateSpot({ description: "直す" }, { partial: true }).errors, []);
  assert.match(validateSpot({ name: "x", lat: 1, lng: 1, url: "https://u:p@example.jp/" }).errors.join(), /パスワード/);
});

test("足す・直す・消す・取り消す（差分の形）", () => {
  const kb = fakeKb();
  const doc = emptyOverlay("mine");
  const id = addSpot(doc, { name: "裏高尾の湧き水", lat: 35.64, lng: 139.25 });
  assert.equal(doc.spots[id].op, "add");

  const official = kb.spotsById.get("takao-1");
  patchSpot(doc, official, "takao-1", { set: { description: "朝いちばんが静か", fee: 300 } });
  patchSpot(doc, official, "takao-1", { set: { fee: 500 } });
  const p = doc.spots["takao-1"];
  assert.deepEqual(p.set, { description: "朝いちばんが静か", fee: 500 });
  // 直す前の公式の値は、最初に直したときのまま
  assert.deepEqual(p.was, { description: "山腹の寺", fee: 0 });
  assert.equal(p.anchor.name, "高尾山薬王院");
  assert.equal(code(() => patchSpot(doc, official, "takao-1", { unset: ["name"] })), "invalid_input");
  assert.equal(code(() => patchSpot(doc, undefined, "nope-1", { set: { fee: 1 } })), "not_found");

  removeSpot(doc, kb.spotsById.get("takao-2"), "takao-2", { reason: "混みすぎる" });
  assert.equal(doc.spots["takao-2"].op, "remove");
  removeSpot(doc, undefined, id);
  assert.equal(doc.spots[id].op, "remove");
  assert.equal(doc.spots[id].spot.name, "裏高尾の湧き水");

  // 取り消すと、消す前に戻る
  undoEntry(doc, id);
  assert.equal(doc.spots[id].op, "add");
  undoEntry(doc, "takao-2");
  assert.equal(doc.spots["takao-2"], undefined);
  assert.deepEqual(checkOverlay(doc), []);
});

test("重ねると利用者の差分が勝ち、公式の知識ベースは書き換わらない", () => {
  const kb = fakeKb();
  const before = JSON.stringify(kb.spots);
  const doc = emptyOverlay("mine");
  const id = addSpot(doc, { name: "裏高尾の湧き水", lat: 35.64, lng: 139.25 });
  patchSpot(doc, kb.spotsById.get("takao-1"), "takao-1", { set: { fee: 300 }, unset: ["description"] });
  removeSpot(doc, kb.spotsById.get("hakone-1"), "hakone-1");

  const { kb: merged, report } = applyOverlay(kb, doc);
  assert.equal(JSON.stringify(kb.spots), before, "公式のスポットを書き換えた");
  assert.equal(kb.spotsById.size, 3);
  assert.deepEqual([report.added, report.patched, report.removed], [1, 1, 1]);
  assert.equal(merged.spots.length, 3);
  assert.equal(merged.spotsById.get("takao-1").fee, 300);
  assert.equal(merged.spotsById.get("takao-1").description, undefined);
  assert.equal(merged.spotsById.get("takao-1").edited, true);
  assert.equal(merged.spotsById.has("hakone-1"), false);
  // 地域を書かずに足したスポットは、いちばん近いエリアに入る
  const u = merged.spotsById.get(id);
  assert.equal(u.regionId, "takao");
  assert.equal(u.source, "user");
  assert.ok(merged.spotsByRegion.get("takao").some((s) => s.id === id));
  assert.equal(merged.spotsByRegion.get("hakone"), undefined);
  assert.equal(merged.userKb.name, "mine");
});

test("公式の側が変わったとき: 食い違い・同じ値になった・id が変わった・消えた", () => {
  const kb0 = fakeKb();
  const doc = emptyOverlay("mine");
  patchSpot(doc, kb0.spotsById.get("takao-1"), "takao-1", { set: { fee: 300, description: "朝が静か" } });
  patchSpot(doc, kb0.spotsById.get("takao-2"), "takao-2", { set: { dwell: 60 } });
  patchSpot(doc, kb0.spotsById.get("hakone-1"), "hakone-1", { set: { dwell: 30 } });

  // 公式が新しくなった: takao-1 の料金が変わり説明が利用者と同じに、takao-2 は id が変わり、hakone-1 は消えた
  const kb1 = fakeKb();
  kb1.spots[0].fee = 100;
  kb1.spots[0].description = "朝が静か";
  kb1.spots[1].id = "takao-99";
  kb1.spots.splice(2, 1);
  kb1.spotsById = new Map(kb1.spots.map((s) => [s.id, s]));

  const { kb: merged, report } = applyOverlay(kb1, doc);
  assert.deepEqual(report.conflicts, [{ id: "takao-1", field: "fee", was: 0, official: 100, user: 300 }]);
  assert.deepEqual(report.redundant, [{ id: "takao-1", field: "description" }]);
  assert.equal(merged.spotsById.get("takao-1").fee, 300, "利用者の値が勝つ");
  assert.deepEqual(report.moved, [{ id: "takao-2", to: "takao-99" }]);
  assert.equal(merged.spotsById.get("takao-99").dwell, 60);
  assert.equal(report.orphans.length, 1);
  assert.equal(report.orphans[0].id, "hakone-1");
  // 見失った差分も、ファイルからは消さない
  assert.ok(doc.spots["hakone-1"]);
});

test("手で壊された overlay は、おかしい差分だけ使わない", () => {
  const kb = fakeKb();
  const doc = emptyOverlay("mine");
  doc.spots["takao-1"] = { op: "patch", set: { fee: -5 } };
  doc.spots["takao-2"] = { op: "explode" };
  doc.spots["evil"] = { op: "add", spot: { name: "x", lat: 1, lng: 1 } };
  doc.spots["hakone-1"] = { op: "patch", set: { dwell: 20 }, was: {} };
  const problems = checkOverlay(doc);
  assert.deepEqual(problems.map((p) => p.id).sort(), ["evil", "takao-1", "takao-2"]);
  const { kb: merged, report } = applyOverlay(kb, doc);
  assert.equal(report.invalid.length, 3);
  assert.equal(merged.spotsById.get("takao-1").fee, 0);
  assert.equal(merged.spotsById.get("hakone-1").dwell, 20);
});

test("形の版: 新しい版は読むだけにして断る、知らない形は壊れたファイル", () => {
  assert.equal(migrateOverlay(emptyOverlay("a")).schema, SCHEMA);
  assert.equal(code(() => migrateOverlay({ schema: "tabisaki.user-kb/99", spots: {} })), "newer_schema");
  assert.equal(code(() => migrateOverlay({ schema: "something", spots: {} })), "broken_file");
});

test("置き場: 作る・書く（控えを取る）・控えから戻す・消すときは trash へ", async () => {
  const home = await tmpHome();
  try {
    let t = Date.parse("2026-10-27T00:00:00.000Z");
    const store = openStore({ home, now: () => new Date(t++) });
    assert.deepEqual(await store.list(), []);
    await store.create("mine", { title: "自分の旅" });
    assert.equal(await codeAsync(store.create("mine")), "exists");
    assert.deepEqual(await store.list(), ["mine"]);

    const kb = fakeKb();
    const doc = await store.load("mine");
    const id = addSpot(doc, { name: "裏高尾の湧き水", lat: 35.64, lng: 139.25 });
    const r1 = await store.save("mine", doc, { kb });
    assert.ok(r1.backup, "書く前の中身を控える");
    const saved = await store.load("mine");
    assert.equal(saved.spots[id].spot.name, "裏高尾の湧き水");
    assert.equal(saved.base.stamp, baseStamp(kb));

    // 権限: フォルダは本人だけ、ファイルも本人だけ
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(home, "kbs", "mine"))).mode & 0o777, 0o700);
      assert.equal((await stat(store.path("mine"))).mode & 0o777, 0o600);
    }

    // 控えから戻す（空の状態へ）
    const [first] = await store.backups("mine");
    await store.restore("mine", first);
    assert.deepEqual((await store.load("mine")).spots, {});
    assert.equal((await store.backups("mine")).length, 2, "戻す前の中身も控える");
    assert.equal(await codeAsync(store.restore("mine", "../../etc/passwd")), "invalid_input");

    // おかしい差分は書かない
    const broken = await store.load("mine");
    broken.spots.x = { op: "add", spot: {} };
    assert.equal(await codeAsync(store.save("mine", broken)), "invalid_input");

    // 半端なファイル（.tmp）が残っていない
    assert.deepEqual((await readdir(path.join(home, "kbs", "mine"))).filter((f) => f.endsWith(".tmp") || f === ".lock"), []);

    const to = await store.drop("mine");
    assert.deepEqual(await store.list(), []);
    assert.ok((await stat(path.join(to, "overlay.json"))).isFile());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("置き場: 控えは決まった数まで、鍵がかかっていれば待たせる", async () => {
  const home = await tmpHome();
  try {
    let t = 0;
    const store = openStore({ home, now: () => new Date(Date.UTC(2026, 9, 27) + t++) });
    const doc = await store.create("mine");
    for (let i = 0; i < 35; i++) await store.save("mine", doc);
    assert.equal((await store.backups("mine")).length, 30);

    await writeFile(path.join(home, "kbs", "mine", ".lock"), "1");
    assert.equal(await codeAsync(store.save("mine", doc)), "locked");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("置き場: シンボリックリンクや大きすぎる・壊れた・__proto__ 入りのファイルは読まない", async () => {
  const home = await tmpHome();
  try {
    const store = openStore({ home });
    await mkdir(path.join(home, "kbs", "link"), { recursive: true });
    const outside = path.join(home, "outside.json");
    await writeFile(outside, JSON.stringify(emptyOverlay("link")));
    await symlink(outside, path.join(home, "kbs", "link", "overlay.json"));
    assert.equal(await codeAsync(store.load("link")), "unsafe_path");

    await mkdir(path.join(home, "kbs", "bad"), { recursive: true });
    await writeFile(path.join(home, "kbs", "bad", "overlay.json"), "{ not json");
    assert.equal(await codeAsync(store.load("bad")), "broken_file");

    await mkdir(path.join(home, "kbs", "proto"), { recursive: true });
    await writeFile(path.join(home, "kbs", "proto", "overlay.json"),
      `{"schema":"${SCHEMA}","name":"proto","spots":{},"__proto__":{"polluted":true}}`);
    const doc = await store.load("proto");
    assert.equal(doc.polluted, undefined);
    assert.equal({}.polluted, undefined);

    assert.equal(await codeAsync(store.load("../etc")), "invalid_name");
    assert.equal(await codeAsync(store.load("nothing")), "not_found");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("置き場の根は TABISAKI_HOME、無ければ ~/.tabisaki", () => {
  assert.equal(userKbHome({ TABISAKI_HOME: "/srv/t" }), path.resolve("/srv/t"));
  assert.equal(userKbHome({}), path.join(os.homedir(), ".tabisaki"));
});

// --- 本物の kb/ で ------------------------------------------------------------------

const KB_DIR = fileURLToPath(new URL("../kb/", import.meta.url));
async function hashKbDir() {
  const h = createHash("sha256");
  for (const f of (await readdir(KB_DIR)).sort()) {
    if (!f.endsWith(".json")) continue;
    h.update(f);
    h.update(await readFile(path.join(KB_DIR, f)));
  }
  return h.digest("hex");
}

test("本物の kb/ に重ねて旅程が組める。kb/ のファイルは1バイトも変わらない", async () => {
  const before = await hashKbDir();
  const plain = await createCore();
  const doc = emptyOverlay("mine");
  const target = plain.kb.spotsById.get("takao-1");
  patchSpot(doc, target, "takao-1", { set: { description: "利用者が書いた説明" } });
  removeSpot(doc, plain.kb.spotsById.get("takao-2"), "takao-2");
  const id = addSpot(doc, { name: "利用者の展望所", lat: 35.63, lng: 139.25, category: "展望台", genres: ["view"], dwell: 30 });

  const core = await createCore({ userKb: doc });
  assert.equal(core.overlayReport.added, 1);
  assert.equal(core.kb.spotsById.get("takao-1").description, "利用者が書いた説明");
  assert.equal(core.kb.spotsById.has("takao-2"), false);
  assert.equal(core.kb.spotsById.get(id).regionId, "takao");
  assert.equal(plain.kb.spotsById.get("takao-1").description, target.description, "重ねる前の知識ベースは元のまま");
  const r = await core.plan({ wish: "高尾山で景色", from: "新宿駅", date: "2026-11-07" });
  assert.ok(r.itinerary.days.length >= 1);
  assert.equal(await hashKbDir(), before);
});

test("CLI: --kb=<名前> でユーザーKBを重ねる。無い名前は終了コード 2", async () => {
  const home = await tmpHome();
  try {
    const store = openStore({ home });
    await store.create("mine");
    const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
    const env = { ...process.env, TABISAKI_HOME: home };
    const ok = spawnSync(process.execPath, [BIN, "plan", "温泉", "--kb=mine", "--date=2026-11-07"], { encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^# /);
    const missing = spawnSync(process.execPath, [BIN, "plan", "温泉", "--kb=nothing"], { encoding: "utf8", env });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /ありません/);
    const bad = spawnSync(process.execPath, [BIN, "plan", "温泉", "--kb=../x"], { encoding: "utf8", env });
    assert.equal(bad.status, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("UserKbError は code を持つ", () => {
  const e = new UserKbError("not_found", "x");
  assert.equal(e.code, "not_found");
  assert.ok(e instanceof Error);
});
