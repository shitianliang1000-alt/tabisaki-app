// ユーザーKBの差分・3者の統合・点検・集計（packages/core/kbmerge.mjs）と、
// 置き場の fork・switch・土台の控え（packages/core/userkb.mjs）の試験。Issue #358。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as m from "../packages/core/kbmerge.mjs";
import * as u from "../packages/core/userkb.mjs";

const at = "2026-11-01T00:00:00.000Z";
const patch = (set, { unset = [], was = {}, name = "高尾山薬王院" } = {}) => ({
  op: "patch", set, unset, was: { ...Object.fromEntries(Object.keys(set).map((k) => [k, null])), ...was },
  anchor: { name, lat: 35.6256, lng: 139.2472 }, at,
});
const add = (spot) => ({ op: "add", spot: { name: "秘密の滝", lat: 35.1, lng: 139.2, ...spot }, at });
const remove = (name = "高尾山山頂") => ({ op: "remove", reason: "", anchor: { name, lat: 35.6252, lng: 139.2434 }, at });
const doc = (spots, extra = {}) => ({ ...u.emptyOverlay("x"), spots, ...extra });
const official = {
  spots: [
    { id: "takao-1", name: "高尾山薬王院", lat: 35.6256, lng: 139.2472, regionId: "takao", region: "高尾山", prefecture: "東京都", open: 8, close: 16, fee: 0 },
    { id: "takao-2", name: "高尾山山頂", lat: 35.6252, lng: 139.2434, regionId: "takao", region: "高尾山", prefecture: "東京都" },
  ],
  regions: [{ id: "takao", name: "高尾山", prefecture: "東京都", lat: 35.63, lng: 139.25 }],
  manifest: { counts: { regions: 1, spots: 2 } },
};

test("差分: 足した・無くなった・項目ごとの違いを出す。書いた時刻だけの違いは数えない", () => {
  const a = doc({ "takao-1": patch({ fee: 500, dwell: 40 }), "takao-2": remove(), "u:aaaaaa01": add({}) });
  const b = doc({
    "takao-1": { ...patch({ fee: 800 }, { unset: ["tel"] }), at: "2026-12-01T00:00:00.000Z" },
    "u:aaaaaa01": { ...add({}), at: "2026-12-31T00:00:00.000Z" },
    "u:bbbbbb02": add({ name: "公園" }),
  });
  const d = m.diffOverlays(a, b);
  assert.deepEqual(d.map((c) => [c.id, c.kind]), [["takao-1", "changed"], ["takao-2", "removed"], ["u:bbbbbb02", "added"]]);
  assert.deepEqual(d[0].fields, [
    { field: "dwell", from: 40, to: undefined },
    { field: "fee", from: 500, to: 800 },
    { field: "tel", from: undefined, to: null },
  ]);
  assert.equal(m.diffOverlays(a, a).length, 0);
  const text = m.formatDiff(d, { from: "a", to: "b" });
  assert.match(text, /~ takao-1 高尾山薬王院/);
  assert.match(text, /fee: 500 → 800/);
  assert.match(text, /\+ u:bbbbbb02 公園［b で足した］/);
});

test("統合: 片方だけが変えたところは変えた方を取り、競合にしない", () => {
  const base = doc({ "takao-1": patch({ fee: 500 }), "takao-2": remove(), "u:aaaaaa01": add({}) });
  const ours = doc({ "takao-1": patch({ fee: 500 }), "takao-2": remove(), "u:aaaaaa01": add({ dwell: 30 }) });
  const theirs = doc({ "takao-1": patch({ fee: 800 }), "u:aaaaaa01": add({}), "u:bbbbbb02": add({ name: "公園" }) });
  const r = m.mergeOverlays(base, ours, theirs);
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.spots["takao-1"].set.fee, 800, "相手だけが変えた → 相手");
  assert.equal(r.spots["u:aaaaaa01"].spot.dwell, 30, "自分だけが変えた → 自分");
  assert.equal(r.spots["takao-2"], undefined, "相手が消した印を取り消した → こちらも取り消す");
  assert.equal(r.spots["u:bbbbbb02"].spot.name, "公園", "相手が足した → 足す");
  assert.deepEqual(r.counts, { added: 1, replaced: 1, fields: 0, dropped: 1, conflicts: 0 });
});

test("統合: 同じスポットの別々の項目は両方取り込み、同じ項目を別の値にしたところだけ競合", () => {
  const base = doc({ "takao-1": patch({ fee: 500 }, { was: { fee: 0 } }) });
  const ours = doc({ "takao-1": patch({ fee: 600, dwell: 40 }, { was: { fee: 0, dwell: 50 } }) });
  const theirs = doc({ "takao-1": patch({ fee: 800, description: "家族向け" }, { unset: ["tel"], was: { fee: 0, description: "寺", tel: "042" } }) });
  const r = m.mergeOverlays(base, ours, theirs);
  assert.deepEqual(r.spots["takao-1"].set, { description: "家族向け", dwell: 40, fee: 600 });
  assert.deepEqual(r.spots["takao-1"].unset, ["tel"]);
  assert.deepEqual(r.spots["takao-1"].was, { description: "寺", dwell: 50, fee: 0, tel: "042" }, "直す前の公式の値を、取り込んだ項目にも持つ");
  assert.deepEqual(r.conflicts.map((c) => [c.key, c.kind, c.base, c.ours, c.theirs]), [["takao-1#fee", "field", 500, 600, 800]]);
  assert.deepEqual(r.taken, [{ id: "takao-1", name: "高尾山薬王院", how: "fields", op: "patch", fields: ["description", "tel"] }]);

  // 解き方を当てはめる
  assert.equal(m.resolveMerge(r, theirs, {}).unresolved.length, 1);
  assert.equal(m.resolveMerge(r, theirs, { "takao-1#fee": "ours" }).spots["takao-1"].set.fee, 600);
  const t = m.resolveMerge(r, theirs, { "takao-1#fee": "theirs" });
  assert.equal(t.unresolved.length, 0);
  assert.equal(t.spots["takao-1"].set.fee, 800);
  assert.equal(t.spots["takao-1"].set.dwell, 40, "競合していない項目はそのまま");
  assert.deepEqual(u.checkOverlay(doc(t.spots)), []);
  assert.match(m.formatConflict(r.conflicts[0], { ours: "mine", theirs: "family" }), /分かれる前: 500\n {4}mine: 600\n {4}family: 800/);
});

test("統合: 両方が同じに変えたら競合にしない。消した・直したの食い違いはスポットごとの競合", () => {
  const base = doc({ "takao-1": patch({ fee: 500 }) });
  const same = m.mergeOverlays(base, doc({ "takao-1": patch({ fee: 700 }) }), doc({ "takao-1": patch({ fee: 700 }) }));
  assert.equal(same.conflicts.length, 0);
  assert.equal(same.taken.length, 0);

  const ours = doc({ "takao-1": patch({ fee: 600 }) });
  const theirs = doc({ "takao-1": remove("高尾山薬王院") });
  const r = m.mergeOverlays(base, ours, theirs);
  assert.deepEqual(r.conflicts.map((c) => [c.key, c.kind]), [["takao-1", "entry"]]);
  assert.equal(r.spots["takao-1"].op, "patch", "解くまでは自分のまま");
  assert.equal(m.resolveMerge(r, theirs, { "takao-1": "theirs" }).spots["takao-1"].op, "remove");
  assert.equal(m.resolveMerge(r, theirs, { "takao-1": "ours" }).spots["takao-1"].set.fee, 600);

  // 相手が差分を取り消し、自分は直した → 競合。相手を取ると、差分が無くなる（収録のまま）
  const r2 = m.mergeOverlays(base, ours, doc({}));
  assert.equal(r2.conflicts[0].theirs, null);
  assert.equal(m.resolveMerge(r2, doc({}), { "takao-1": "theirs" }).spots["takao-1"], undefined);
  assert.match(m.formatConflict(r2.conflicts[0]), /相手: 収録のまま/);
});

test("統合: 土台が無いとき（別の端末のファイル）は、空から比べる", () => {
  const ours = doc({ "takao-1": patch({ fee: 600, dwell: 40 }), "u:aaaaaa01": add({ dwell: 20 }) });
  const theirs = doc({ "takao-1": patch({ fee: 600, description: "朝が静か" }), "u:aaaaaa01": add({ dwell: 45, fee: 300 }), "u:cccccc03": add({ name: "別の端末の滝" }) });
  const r = m.mergeOverlays(null, ours, theirs);
  assert.equal(r.hasBase, false);
  assert.deepEqual(r.spots["takao-1"].set, { description: "朝が静か", dwell: 40, fee: 600 }, "同じ値どうしは競合にしない");
  assert.deepEqual(r.conflicts.map((c) => c.key), ["u:aaaaaa01#dwell"]);
  assert.equal(r.spots["u:aaaaaa01"].spot.fee, 300, "足したスポットも項目ごとにまとめる");
  assert.ok(r.spots["u:cccccc03"]);
  const done = m.resolveMerge(r, theirs, { "u:aaaaaa01#dwell": "theirs" });
  assert.equal(done.spots["u:aaaaaa01"].spot.dwell, 45);
  assert.doesNotThrow(() => m.checkMerged(doc(m.normalizeAdded(done.spots))));
  assert.doesNotMatch(m.formatConflict(r.conflicts[0], { hasBase: false }), /分かれる前/);
});

test("統合: 決まりに合わない結果は書かせない。指紋は中身だけで決まる", () => {
  assert.throws(() => m.checkMerged(doc({ "u:aaaaaa01": { op: "add", spot: { name: "x" }, at } })), /決まりに合いません/);
  const a = doc({ "takao-1": patch({ fee: 1, dwell: 30 }) });
  const b = doc({ "takao-1": { ...patch({ dwell: 30, fee: 1 }), at: "2030-01-01T00:00:00.000Z" } }, { updated: "2030-01-01T00:00:00.000Z" });
  assert.equal(m.overlayFingerprint(a), m.overlayFingerprint(b));
  assert.notEqual(m.overlayFingerprint(a), m.overlayFingerprint(doc({ "takao-1": patch({ fee: 2, dwell: 30 }) })));
});

test("統合で足されるスポットが、もとからあるものと重なっていたら知らせる", () => {
  const spots = { "u:bbbbbb02": add({ name: "高尾山山頂", lat: 35.6253, lng: 139.2435 }) };
  const taken = [{ id: "u:bbbbbb02", name: "高尾山山頂", how: "add", op: "add" }];
  const view = [...official.spots, { id: "u:bbbbbb02", ...spots["u:bbbbbb02"].spot }];
  const d = m.mergeDuplicates(taken, spots, view);
  assert.equal(d.length, 1);
  assert.equal(d[0].with, "takao-2");
  assert.ok(d[0].meters < 30);
});

test("点検: 使えない差分はまちがい、見ておくものは気をつけること", () => {
  const d = doc({
    "takao-1": patch({ open: 17 }, { was: { open: 8 } }),            // close 16 より後に開く
    "takao-9": patch({ fee: 1 }, { name: "消えた寺" }),               // 公式に無い
    "u:aaaaaa01": add({ regionId: "nowhere" }),                       // 知らないエリア
    "u:bbbbbb02": add({ name: "ゼロ", lat: 0, lng: 0 }),
    "u:cccccc03": add({ name: "ハワイ", lat: 21.3, lng: -157.8 }),
    "u:dddddd04": add({ name: "同じ滝", lat: 35.5, lng: 139.5 }),
    "u:eeeeee05": add({ name: "同じ滝", lat: 35.5003, lng: 139.5003 }),
    "u:ffffff06": { op: "add", spot: { name: "座標なし" }, at },
  }, { base: { kind: "official", stamp: "/1/1" }, parent: { name: "gone", forkedAt: at } });
  const { report } = u.applyOverlay(official, d);
  const v = m.validateKb(d, official, { report, names: ["x"] });
  assert.equal(v.ok, false);
  const codes = (list) => Object.fromEntries(list.map((e) => [e.id + "/" + e.code, true]));
  const e = codes(v.errors);
  assert.ok(e["takao-1/hours"]);
  assert.ok(e["u:aaaaaa01/unknown_region"]);
  assert.ok(e["u:bbbbbb02/zero_coord"]);
  assert.ok(e["u:ffffff06/invalid"]);
  const w = codes(v.warnings);
  assert.ok(w["takao-9/orphan"]);
  assert.ok(w["u:cccccc03/outside_japan"]);
  assert.ok(w["u:eeeeee05/duplicate"]);
  assert.ok(w["/no_parent"]);
  assert.ok(w["/base_changed"]);
  assert.equal(v.checked, 8);

  const ok = m.validateKb(doc({ "takao-1": patch({ fee: 300 }, { was: { fee: 0 } }), "u:aaaaaa01": add({}) }), official);
  assert.deepEqual([ok.ok, ok.errors.length, ok.warnings.length], [true, 0, 0]);
});

test("点検: 直したあとで公式の側も変わっていたら知らせる", () => {
  const d = doc({ "takao-1": patch({ fee: 300 }, { was: { fee: 100 } }) });
  const { report } = u.applyOverlay(official, d);
  const v = m.validateKb(d, official, { report });
  assert.equal(v.ok, true);
  assert.deepEqual(v.warnings.map((x) => x.code), ["official_changed"]);
});

test("集計: 件数・都道府県・直した項目・時刻", () => {
  const d = doc({
    "takao-1": patch({ fee: 300, dwell: 40 }),
    "takao-2": { ...remove(), at: "2026-11-05T00:00:00.000Z" },
    "u:aaaaaa01": add({ lat: 35.63, lng: 139.25, genres: ["nature", "view"], category: "滝" }),
  });
  const { kb: view } = u.applyOverlay(official, d);
  const s = m.kbStats(d, view, official);
  assert.equal(s.total, 3);
  assert.deepEqual(s.counts, { add: 1, patch: 1, remove: 1 });
  assert.deepEqual(s.prefectures, [{ name: "東京都", count: 3 }]);
  assert.deepEqual(s.editedFields.map((x) => x.name).sort(), ["dwell", "fee"]);
  assert.deepEqual(s.genres.map((x) => x.name).sort(), ["nature", "view"]);
  assert.equal(s.newestEntry, "2026-11-05T00:00:00.000Z");
  assert.equal(s.oldestEntry, at);
});

test("置き場: 分ける・切り替える・土台を控える・途中の統合を控える", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tabisaki-fork-"));
  try {
    let t = Date.parse("2026-11-01T00:00:00Z");
    const store = u.openStore({ home, now: () => new Date((t += 1000)) });
    await store.create("mine", { title: "自分の旅" });
    const d = await store.load("mine");
    u.addSpot(d, { name: "秘密の滝", lat: 35.1, lng: 139.2 });
    await store.save("mine", d);

    assert.equal(await store.current(), null);
    await assert.rejects(store.switchTo("family"), (e) => e.code === "not_found");
    const f = await store.fork("mine", "family");
    assert.equal(f.parent.name, "mine");
    assert.equal(f.title, "自分の旅");
    assert.equal(Object.keys((await store.load("family")).spots).length, 1);
    await assert.rejects(store.fork("mine", "family"), (e) => e.code === "exists");
    await assert.rejects(store.fork("mine", "../x"), (e) => e.code === "invalid_name");
    if (process.platform !== "win32") {
      assert.equal(readFileSync(path.join(home, "kbs", "family", "bases", "mine.json"), "utf8").includes("秘密の滝"), true);
    }

    assert.equal(await store.switchTo("family"), "family");
    assert.equal(await store.current(), "family");
    assert.equal((await store.info("family")).bases[0], "mine");

    // 土台は、どちらの側に控えてあっても、新しい方を使う
    const first = await store.commonBase("mine", "family");
    assert.equal(Object.keys(first.overlay.spots).length, 1);
    await store.setBase("mine", "family", { ...d, spots: {} });
    const second = await store.commonBase("family", "mine");
    assert.equal(Object.keys(second.overlay.spots).length, 0);
    assert.ok(second.at > first.at);

    assert.equal(await store.mergeState("mine"), null);
    await store.setMergeState("mine", { schema: m.MERGE_SCHEMA, picks: { a: "ours" } });
    assert.deepEqual((await store.mergeState("mine")).picks, { a: "ours" });
    assert.equal((await store.info("mine")).merging, true);
    await store.setMergeState("mine", null);
    assert.equal(await store.mergeState("mine"), null);

    // いま使っているものを消したら、切り替えも外れる
    await store.drop("family");
    assert.equal(await store.current(), null);

    // current-kb がリンクや変な中身なら、決めていないものとして扱う
    writeFileSync(path.join(home, "current-kb"), "../../etc\n");
    assert.equal(await store.current(), null);
    if (process.platform !== "win32") {
      rmSync(path.join(home, "current-kb"));
      symlinkSync(path.join(home, "kbs", "mine", "overlay.json"), path.join(home, "current-kb"));
      assert.equal(await store.current(), null);
    }

    // 置き場の外のファイルは、読むだけ。おかしければ断る
    const good = path.join(home, "other.json");
    writeFileSync(good, JSON.stringify(d));
    assert.equal(Object.keys((await u.readOverlayFile(good)).spots).length, 1);
    writeFileSync(good, JSON.stringify({ ...d, spots: { "u:zzzzzz99": { op: "add", spot: { name: "x" } } } }));
    await assert.rejects(u.readOverlayFile(good), (e) => e.code === "broken_file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
