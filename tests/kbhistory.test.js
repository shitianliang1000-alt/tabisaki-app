// ユーザーKBの履歴・取り消し・項目ごとの出どころ・スナップショット・一括編集・git への写し
// （packages/core/kbhistory.mjs と、userkb.mjs の置き場）の試験。Issue #360。

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as h from "../packages/core/kbhistory.mjs";
import * as u from "../packages/core/userkb.mjs";

const at = "2026-11-01T00:00:00.000Z";
const patch = (set, unset = []) => ({ op: "patch", set, unset, was: Object.fromEntries(Object.keys(set).map((k) => [k, null])), anchor: { name: "高尾山薬王院", lat: 35.6256, lng: 139.2472 }, at });
const add = (spot = {}) => ({ op: "add", spot: { name: "秘密の滝", lat: 35.1, lng: 139.2, ...spot }, at });
const removed = () => ({ op: "remove", reason: "", anchor: { name: "高尾山山頂", lat: 35.6252, lng: 139.2434 }, at });
const rec = (seq, cmd, changes, extra = {}) => ({ v: 1, seq, at: `2026-11-0${seq}T00:00:00.000Z`, cmd, note: "", changes, ...extra });
const official = new Map([
  ["takao-1", { id: "takao-1", name: "高尾山薬王院", lat: 35.6256, lng: 139.2472, fee: 0, dwell: 50 }],
  ["takao-2", { id: "takao-2", name: "高尾山山頂", lat: 35.6252, lng: 139.2434 }],
]);

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }

test("履歴の1行: 変わった差分だけを id ごとに。こわれた行は飛ばして読む", () => {
  const a = { "takao-1": patch({ fee: 500 }), "u:aaaaaa01": add() };
  const b = { "takao-1": { ...patch({ fee: 800 }), at: "2030-01-01T00:00:00.000Z" }, "u:aaaaaa01": { ...add(), at: "2030-01-01T00:00:00.000Z" }, "takao-2": removed() };
  const ch = h.entryChanges(a, b);
  assert.deepEqual(ch.map((c) => c.id), ["takao-1", "takao-2"]);
  assert.equal(h.describeChange(ch[0]), "fee: 500 → 800");
  assert.equal(h.describeChange(ch[1]), "消した");
  assert.equal(h.describeChange({ before: a["takao-1"], after: null }), "直したのを取り消した");

  const text = [JSON.stringify(rec(2, "spot edit", ch)), "{ こわれた", "", JSON.stringify(rec(1, "spot add", [])), '{"seq":"x","changes":[]}'].join("\n");
  assert.deepEqual(h.parseHistory(text).map((r) => r.seq), [1, 2]);
  assert.equal(h.jst("2026-11-11T11:10:00.000Z"), "2026-11-11 20:10");
});

test("取り消し: いちばん新しい変更から。取り消しを取り消す（redo）と、元の変更が生き返る", () => {
  const e1 = patch({ fee: 500 });
  const e2 = patch({ fee: 800, dwell: 40 });
  const records = [
    rec(1, "spot edit", [{ id: "takao-1", before: null, after: e1 }]),
    rec(2, "spot edit", [{ id: "takao-1", before: e1, after: e2 }]),
  ];
  const doc = { spots: { "takao-1": e2 } };
  let plan = h.planUndo(records, doc.spots);
  assert.equal(plan.target.seq, 2);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(h.applyUndo(doc, plan), 1);
  assert.equal(doc.spots["takao-1"].set.fee, 500);
  records.push(rec(3, "spot undo", [{ id: "takao-1", before: e2, after: e1 }], { reverts: 2, undoes: 2 }));
  assert.deepEqual([...h.revertedSeqs(records)], [2]);

  // もう一度 undo すると、#2 は飛ばして #1 を取り消す
  plan = h.planUndo(records, doc.spots);
  assert.equal(plan.target.seq, 1);

  // redo は、いちばん新しい取り消し（#3）を取り消す
  plan = h.planUndo(records, doc.spots, { redo: true });
  assert.equal(plan.target.seq, 3);
  h.applyUndo(doc, plan);
  assert.equal(doc.spots["takao-1"].set.fee, 800);
  records.push(rec(4, "spot redo", [{ id: "takao-1", before: e1, after: e2 }], { reverts: 3, undoes: 3 }));
  assert.deepEqual([...h.revertedSeqs(records)], [3], "#2 は生き返る");
  assert.equal(h.planUndo(records, doc.spots).target.seq, 2);
  assert.equal(h.planUndo(records, doc.spots, { redo: true }).target, null);
  assert.match(h.formatHistory(records), /#3 {2}2026-11-03 09:00 {2}spot undo（取り消し済み）/);
});

test("取り消し: あとで同じスポットが変わっていたら止める。もう戻っているものは数えない。スポットごとにも戻せる", () => {
  const e1 = patch({ fee: 500 });
  const e2 = patch({ fee: 800 });
  const a1 = add();
  const records = [
    rec(1, "spot import", [{ id: "takao-1", before: null, after: e1 }, { id: "u:aaaaaa01", before: null, after: a1 }]),
    rec(2, "spot edit", [{ id: "takao-1", before: e1, after: e2 }]),
  ];
  const spots = { "takao-1": e2, "u:aaaaaa01": a1 };
  let plan = h.planUndo(records, spots, { seq: 1 });
  assert.deepEqual(plan.conflicts.map((c) => [c.id, c.later]), [["takao-1", [2]]]);
  assert.equal(plan.apply.length, 2, "--force なら、あとの変更ごと戻す");

  // そのスポットの分だけ
  plan = h.planUndo(records, spots, { id: "u:aaaaaa01" });
  assert.equal(plan.target.seq, 1);
  assert.equal(plan.partial, true);
  assert.deepEqual(plan.apply, [{ id: "u:aaaaaa01", to: null }]);
  const doc = { spots: { ...spots } };
  h.applyUndo(doc, plan);
  assert.equal(doc.spots["u:aaaaaa01"], undefined);

  // もう戻っている分は already に入り、競合にも apply にも入らない
  plan = h.planUndo(records, { "takao-1": e1 }, { seq: 1 });
  assert.deepEqual(plan.already, ["u:aaaaaa01"]);
  assert.deepEqual(plan.apply.map((a) => a.id), ["takao-1"]);
  assert.equal(h.planUndo(records, spots, { seq: 99 }).target, null);
  assert.equal(h.planUndo(records, spots, { id: "takao-9" }).target, null);
});

test("出どころ: 項目ごとに、いまの値を最後に書いた変更。取り消し・やり直しは、もとの変更を指す", () => {
  const e1 = patch({ fee: 500 });
  const e2 = patch({ fee: 500, dwell: 40 });
  const e3 = patch({ fee: 800, dwell: 40 });
  const records = [
    rec(1, "spot edit", [{ id: "takao-1", before: null, after: e1 }]),
    rec(2, "spot edit", [{ id: "takao-1", before: e1, after: e2 }]),
    rec(3, "kb merge", [{ id: "takao-1", before: e2, after: e3 }]),
  ];
  let b = h.blameSpot(records, "takao-1");
  assert.deepEqual([b.fields.fee.seq, b.fields.dwell.seq, b.touched], [3, 2, 3]);
  assert.equal(b.fields.fee.cmd, "kb merge");

  // #3 を取り消す → fee は #1 のもの。やり直す → #3 のもの
  records.push(rec(4, "spot undo", [{ id: "takao-1", before: e3, after: e2 }], { reverts: 3, undoes: 3 }));
  b = h.blameSpot(records, "takao-1");
  assert.deepEqual([b.fields.fee.seq, b.fields.dwell.seq], [1, 2]);
  records.push(rec(5, "spot redo", [{ id: "takao-1", before: e2, after: e3 }], { reverts: 4, undoes: 4 }));
  assert.equal(h.blameSpot(records, "takao-1").fields.fee.seq, 3);

  // 消した印は removed に。差分が無くなったら（収録のまま）、何も指さない
  const gone = { op: "remove", reason: "", anchor: e3.anchor, patch: { set: e3.set, unset: [], was: {} }, at };
  records.push(rec(6, "spot rm", [{ id: "takao-1", before: e3, after: gone }]));
  b = h.blameSpot(records, "takao-1");
  assert.equal(b.removed.seq, 6);
  assert.equal(b.fields.fee.seq, 3);
  records.push(rec(7, "spot restore", [{ id: "takao-1", before: gone, after: e3 }]));
  assert.equal(h.blameSpot(records, "takao-1").removed, null);
  assert.equal(h.blameSpot(records, "takao-1").fields.fee.seq, 3, "消して戻しただけでは、値を書いた変更は変わらない");
  records.push(rec(8, "spot restore", [{ id: "takao-1", before: e3, after: null }]));
  assert.deepEqual(h.blameSpot(records, "takao-1").fields, {});
  assert.equal(h.blameSpot(records, "takao-9").touched, 0);
});

test("スナップショット: 中身が変わったら見分ける", () => {
  const doc = { ...u.emptyOverlay("mine"), spots: { "takao-1": patch({ fee: 500 }) } };
  const snap = h.makeSnapshot(doc, "before", { note: "一括の前", now: new Date(at), seq: 3 });
  assert.equal(snap.entries, 1);
  assert.equal(h.snapshotProblem(snap), null);
  assert.equal(h.snapshotProblem(JSON.parse(JSON.stringify(snap))), null, "鍵の並びが変わっても同じ");
  const tampered = JSON.parse(JSON.stringify(snap));
  tampered.overlay.spots["takao-1"].set.fee = 1;
  assert.match(h.snapshotProblem(tampered), /指紋が合いません/);
  assert.match(h.snapshotProblem({ ...snap, schema: "x" }), /形の版/);
  assert.match(h.snapshotProblem({ ...snap, overlay: {} }), /中身/);
  assert.ok(h.SNAPSHOT_LABEL_RE.test("before-batch_2"));
  assert.equal(h.SNAPSHOT_LABEL_RE.test("../x"), false);
});

test("一括編集: スクリプトは「こう変えたい」を返すだけ。require・process・eval・import は使えない", async () => {
  const spots = [{ id: "u:aaaaaa01", name: "秘密の滝", category: "滝" }, { id: "takao-1", name: "高尾山薬王院", category: "寺院" }];
  const r = await h.runBatchScript(`
    for (const s of spots) if (s.category === "滝") edit(s.id, { dwell: 30 }, ["tel"]);
    remove("takao-2", "混む");
    add({ name: "公園", lat: 35.5, lng: 139.6 });
    restore("takao-1");
    log("見た数", spots.length, { a: 1 });
    console.log(typeof require, typeof process, typeof fetch, typeof setTimeout);
  `, spots);
  assert.deepEqual(r.ops, [
    { do: "edit", id: "u:aaaaaa01", set: { dwell: 30 }, unset: ["tel"] },
    { do: "remove", id: "takao-2", reason: "混む" },
    { do: "add", spot: { name: "公園", lat: 35.5, lng: 139.6 } },
    { do: "restore", id: "takao-1" },
  ]);
  assert.deepEqual(r.logs, ['見た数 2 {"a":1}', "undefined undefined undefined undefined"]);

  const fails = (code, re, opts) => assert.rejects(h.runBatchScript(code, spots, opts), (e) => {
    assert.equal(e.code, "batch_failed");
    assert.match(e.message, re);
    return true;
  });
  await Promise.all([
    fails('eval("1")', /Code generation from strings disallowed/),
    fails('new Function("return 1")()', /Code generation from strings disallowed/),
    fails('this.constructor.constructor("return process")()', /Code generation from strings disallowed/),
    fails('edit.constructor("return process")()', /Code generation from strings disallowed/),
    fails('import("node:fs")', /import は使えません/),
    fails('import /* x */ ("node:fs")', /import は使えません/),
    fails('import // x\r("node:fs")', /import は使えません/),
    fails('import <!-- x\n("node:fs")', /import は使えません/),
    fails('[...import("node:fs")]', /import は使えません/),
    fails("import.meta.url", /import は使えません/),
    fails('log("import")', /import という語は書けません/),
    fails("while (true) {}", /時間がかかりすぎました/, { timeoutMs: 100 }),
    fails("Promise.resolve().then(() => { while (true) {} })", /時間がかかりすぎました/, { timeoutMs: 100 }),
    fails('for (let i = 0; i < 4; i++) remove("takao-1")', /変更が多すぎます（3 件まで/, { maxOps: 3 }),
    fails('__max = 99; for (let i = 0; i < 4; i++) remove("takao-1")', /変更が多すぎます/, { maxOps: 3 }),
    fails("\n\nnope()", /batch\.js の 3 行目.*nope is not defined/),
    fails('"use strict"; spots[0].name = "x"', /read only|Cannot assign/),
    // 受け取り手のいない Promise の失敗は、こちら（呼んだ側のプロセス）を落とさず、失敗として返る
    fails('Promise.reject(new Error("あとで失敗"))', /Promise が失敗したまま.*あとで失敗/),
    fails('(async () => { throw new Error("非同期で失敗") })()', /非同期で失敗/),
    // メモリを使いすぎても、止まるのはスクリプトだけ
    fails("const a = []; for (;;) a.push(new Array(100000).fill(1))", /メモリを使いすぎました|時間がかかりすぎました|途中で終わりました/, { timeoutMs: 3000, memoryMb: 32 }),
    fails("JSON.stringify = () => 1", /結果が読めません/),
  ]);

  // 結果をすり替えても、外の世界のものは渡らない（文字だけを受け取り、形を確かめる）
  assert.deepEqual((await h.runBatchScript("__ops.push(1, null, [2], { do: 'boom' })", spots)).ops, [{ do: "boom" }]);
  // 名前に import を含むだけのもの（important・imported など）は、止めない
  assert.deepEqual((await h.runBatchScript('const important = "imported"; log(important)', spots)).logs, ["imported"]);
  // エラーの形をどう作っても、外の世界の Function には届かない
  const probe = await h.runBatchScript(`
    const tries = [() => { null.x }, () => JSON.parse("{"), () => { (function f() { f() })() }, () => { throw new Error("x") }];
    for (const t of tries) {
      try { t() } catch (e) {
        try { log(typeof e.constructor.constructor("return process")()) } catch (x) { log("止めた") }
      }
    }
  `, spots);
  assert.deepEqual(probe.logs, ["止めた", "止めた", "止めた", "止めた"]);
});

test("一括編集: 権限モデルが使える Node.js では、スクリプトを動かす worker から、書き込みも子プロセスも使えない", async () => {
  const { Worker } = await import("node:worker_threads");
  const box = await h.batchSandbox();
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) assert.equal(box.permission, "--permission");
  if (!box.permission) return;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tabisaki-perm-"));
  try {
    const got = await new Promise((resolve) => {
      const w = new Worker(`
        const { parentPort, workerData } = require("node:worker_threads");
        const fs = require("node:fs");
        const out = {};
        const tryIt = (k, f) => { try { f(); out[k] = "できた"; } catch (e) { out[k] = e.code; } };
        tryIt("root", () => fs.readdirSync(workerData.root));
        tryIt("tmp", () => fs.readdirSync(workerData.tmp));
        tryIt("write", () => fs.writeFileSync(workerData.tmp + "/x", "x"));
        tryIt("child", () => require("node:child_process").execFileSync(process.execPath, ["-v"]));
        tryIt("worker", () => new (require("node:worker_threads").Worker)("", { eval: true }));
        parentPort.postMessage(out);
      `, { eval: true, execArgv: box.flags, env: {}, stdout: true, stderr: true, workerData: { root: path.parse(tmp).root, tmp } });
      w.once("message", resolve);
      w.once("error", (e) => resolve({ error: String(e?.message ?? e) }));
    });
    const denied = "ERR_ACCESS_DENIED";
    assert.deepEqual(got, { root: denied, tmp: denied, write: denied, child: denied, worker: denied });
    assert.equal(existsSync(path.join(tmp, "x")), false);
    // こちら（呼んだ側）は、変わらず読み書きできる
    writeFileSync(path.join(tmp, "y"), "y");
    assert.equal(readFileSync(path.join(tmp, "y"), "utf8"), "y");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("一括編集: 頼まれた変更は spot edit と同じ決まりを通す。1つでもまちがいなら、呼んだ側は書かない", () => {
  const doc = { ...u.emptyOverlay("mine"), spots: { "u:aaaaaa01": add(), "takao-2": removed() } };
  const ops = [
    { do: "edit", id: "u:aaaaaa01", set: { dwell: 30 }, unset: [] },
    { do: "edit", id: "takao-1", set: { fee: 900 }, unset: ["dwell"] },
    { do: "restore", id: "takao-2" },
    { do: "add", spot: { name: "公園", lat: 35.5, lng: 139.6 } },
    { do: "remove", id: "takao-1", reason: "x" },
  ];
  const good = h.applyBatchOps(doc, ops, { userkb: u, official });
  assert.deepEqual([good.applied, good.errors.length], [5, 0]);
  assert.equal(doc.spots["u:aaaaaa01"].spot.dwell, 30);
  assert.equal(doc.spots["takao-1"].op, "remove");
  assert.equal(doc.spots["takao-2"], undefined);
  assert.equal(Object.values(doc.spots).filter((e) => e.op === "add").length, 2);
  assert.deepEqual(u.checkOverlay(doc), []);

  const bad = h.applyBatchOps(doc, [
    { do: "edit", id: "takao-2", set: { lat: 999 } },
    { do: "edit", id: "nope", set: { fee: 1 } },
    { do: "edit", id: "takao-1", set: { fee: 1 } },
    { do: "boom" },
    { do: "restore", id: "takao-2" },
    { do: "add", spot: { name: "座標なし" } },
    { do: "edit", id: "u:aaaaaa01", set: { src: "x" } },
  ], { userkb: u, official });
  assert.equal(bad.applied, 0);
  assert.deepEqual(bad.errors.map((e) => e.index), [0, 1, 2, 3, 4, 5, 6]);
  assert.match(bad.errors[0].message, /lat は -90〜90/);
  assert.match(bad.errors[2].message, /消した印/);
  assert.match(bad.errors[6].message, /知らない項目/);
});

test("git への写し: .git/config に知らない設定があれば、git を呼ばない", () => {
  const ok = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[user]\n\tname = x\n\temail = x@example.com\n[remote "origin"]\n\turl = git@example.com:me/kb.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n';
  assert.equal(h.unsafeGitConfig(ok), null);
  assert.equal(h.unsafeGitConfig(`${ok}[filter "evil"]\n\tclean = touch /tmp/x\n`), "[filter]");
  assert.equal(h.unsafeGitConfig("[core]\n\tfsmonitor = /tmp/evil.sh\n"), "core.fsmonitor");
  assert.equal(h.unsafeGitConfig("[core]\n\tsshCommand = evil\n"), "core.sshcommand");
  assert.equal(h.unsafeGitConfig('[include]\n\tpath = /tmp/evil\n'), "[include]");
  assert.equal(h.unsafeGitConfig("[alias]\n\tci = !evil\n"), "[alias]");
  assert.equal(h.unsafeGitConfig("fsmonitor = x\n"), "fsmonitor = x");
  assert.equal(h.commitMessage({ cmd: "spot edit", note: "takao-1（fee）", seq: 12, changes: 1 }), "spot edit: takao-1（fee）\n\nTabisaki-Seq: 12\nTabisaki-Changes: 1\n");
});

test("置き場: 書くたびに履歴へ1行。外で書き換えられた分は、別の1行にする", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tabisaki-hist-"));
  try {
    let t = Date.parse("2026-11-01T00:00:00Z");
    const store = u.openStore({ home, now: () => new Date((t += 1000)) });
    await store.create("mine");
    const dir = store.dir("mine");
    let doc = await store.load("mine");
    const id = u.addSpot(doc, { name: "秘密の滝", lat: 35.1, lng: 139.2 });
    let r = await store.save("mine", doc, { log: { cmd: "spot add", note: "秘密の滝" } });
    assert.equal(r.seq, 1);
    assert.equal(r.git, null, "git リポジトリでなければ、git は呼ばない");
    u.patchSpot(doc, official.get("takao-1"), "takao-1", { set: { fee: 500 } });
    r = await store.save("mine", doc, { log: { cmd: "spot edit", note: "takao-1（fee）" } });
    assert.equal(r.seq, 2);

    // 中身が変わらない書き込みは、履歴に足さない
    r = await store.save("mine", doc);
    assert.equal(r.seq, null);
    let records = await store.history("mine");
    assert.deepEqual(records.map((x) => [x.seq, x.cmd, x.changes.length]), [[1, "spot add", 1], [2, "spot edit", 1]]);
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      assert.equal(statSync(path.join(dir, "history.jsonl")).mode & 0o777, 0o600);
    }

    // 手で overlay.json を書き換える → 次に書くとき、external の行が先に入る
    const hand = JSON.parse(readFileSync(path.join(dir, "overlay.json"), "utf8"));
    hand.spots["takao-1"].set.fee = 4321;
    writeFileSync(path.join(dir, "overlay.json"), JSON.stringify(hand));
    await store.syncHistory("mine");
    records = await store.history("mine");
    assert.deepEqual(records.map((x) => x.cmd), ["spot add", "spot edit", "external"]);
    assert.equal(h.describeChange(records[2].changes[0]), "fee: 500 → 4321");
    await store.syncHistory("mine");
    assert.equal((await store.history("mine")).length, 3, "同じ変更を2度は足さない");

    // 取り消し: external を取り消すと 500 に戻り、その行は reverts を持つ
    doc = await store.load("mine");
    const plan = h.planUndo(records, doc.spots);
    assert.equal(plan.target.cmd, "external");
    h.applyUndo(doc, plan);
    r = await store.save("mine", doc, { log: { cmd: "spot undo", note: "#3", reverts: 3, undoes: 3 } });
    assert.equal(r.seq, 4);
    assert.equal((await store.load("mine")).spots["takao-1"].set.fee, 500);
    assert.equal((await store.history("mine")).at(-1).reverts, 3);

    // 控えから戻すのも、履歴に残る
    const backups = await store.backups("mine");
    await store.restore("mine", backups[1]);
    records = await store.history("mine");
    assert.equal(records.at(-1).cmd, "kb restore");

    // こわれた行が混じっても読める
    appendFileSync(path.join(dir, "history.jsonl"), "{ 途中で止まった行\n");
    assert.equal((await store.history("mine")).length, records.length);

    // 分けると、履歴もついてくる（出どころをたどれる）
    await store.fork("mine", "family");
    const fam = await store.history("family");
    assert.equal(fam.length, records.length);
    assert.equal(h.blameSpot(fam, id).fields.name.seq, 1);

    // 履歴を取りはじめる前からあったユーザーKB（history が無い）は、start の行から始まる
    await store.create("old");
    writeFileSync(path.join(store.dir("old"), "overlay.json"), JSON.stringify({ ...u.emptyOverlay("old"), spots: { "u:bbbbbb02": add() } }));
    rmSync(path.join(store.dir("old"), "history-head.json"), { force: true });
    await store.syncHistory("old");
    assert.deepEqual((await store.history("old")).map((x) => x.cmd), ["start"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("置き場: スナップショットを取る・戻す・すり替えを見分ける", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tabisaki-snap-"));
  try {
    const store = u.openStore({ home });
    await store.create("mine");
    const doc = await store.load("mine");
    u.addSpot(doc, { name: "秘密の滝", lat: 35.1, lng: 139.2 });
    await store.save("mine", doc);
    const s = await store.snapshotSave("mine", "before", { note: "一括の前" });
    assert.equal(s.entries, 1);
    await assert.rejects(store.snapshotSave("mine", "before"), (e) => e.code === "exists");
    await assert.rejects(store.snapshotSave("mine", "../x"), (e) => e.code === "invalid_name");
    await assert.rejects(store.snapshotLoad("mine", "nope"), (e) => e.code === "not_found");

    u.addSpot(doc, { name: "あとで足した", lat: 35.2, lng: 139.3 });
    await store.save("mine", doc);
    const snap = await store.snapshotLoad("mine", "before");
    assert.equal(Object.keys(snap.overlay.spots).length, 1);
    await store.save("mine", { ...snap.overlay, name: "mine" }, { log: { cmd: "kb snapshot restore", note: "before" } });
    assert.equal(Object.keys((await store.load("mine")).spots).length, 1);
    assert.equal((await store.history("mine")).at(-1).cmd, "kb snapshot restore");
    assert.deepEqual((await store.snapshots("mine")).map((x) => [x.label, x.ok, x.note]), [["before", true, "一括の前"]]);
    assert.equal((await store.info("mine")).snapshots, 1);

    const file = path.join(store.dir("mine"), "snapshots", "before.json");
    const j = JSON.parse(readFileSync(file, "utf8"));
    Object.values(j.overlay.spots)[0].spot.name = "すり替え";
    writeFileSync(file, JSON.stringify(j));
    assert.equal((await store.snapshots("mine"))[0].ok, false);
    await assert.rejects(store.snapshotLoad("mine", "before"), (e) => e.code === "broken_file" && /指紋/.test(e.message));
    await store.snapshotRemove("mine", "before");
    assert.equal(existsSync(file), false);
    await assert.rejects(store.snapshotRemove("mine", "before"), (e) => e.code === "not_found");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("git への写し: kb git init のあとは、書くたびにコミットする", { skip: !hasGit && "git がありません" }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tabisaki-git-"));
  try {
    const store = u.openStore({ home });
    await store.create("mine");
    const dir = store.dir("mine");
    const doc = await store.load("mine");
    u.addSpot(doc, { name: "秘密の滝", lat: 35.1, lng: 139.2 });
    await store.save("mine", doc, { log: { cmd: "spot add", note: "秘密の滝" } });
    assert.deepEqual(await h.gitState(dir), { repo: false });
    assert.equal((await h.gitCommit(dir, "x")).skipped, "no_repo");

    const init = await h.gitInit(dir, { name: "mine" });
    assert.equal(init.ok, true, init.why);
    assert.equal(init.created, true);
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    assert.match(git("log", "--format=%s"), /履歴を git に写しはじめる/);
    assert.match(readFileSync(path.join(dir, ".gitignore"), "utf8"), /backups\//);

    u.patchSpot(doc, official.get("takao-1"), "takao-1", { set: { fee: 500 } });
    const r = await store.save("mine", doc, { log: { cmd: "spot edit", note: "takao-1（fee）" } });
    assert.equal(r.git.ok, true, r.git.why);
    assert.match(git("log", "-1", "--format=%B"), /^spot edit: takao-1（fee）\n\nTabisaki-Seq: 2\nTabisaki-Changes: 1/);
    const files = git("ls-files").trim().split("\n");
    assert.ok(files.includes("overlay.json") && files.includes("history.jsonl"));
    assert.ok(!files.some((f) => f.startsWith("backups/") || f === ".lock"), "控えと鍵は git に入れない");
    const sum = await h.gitSummary(dir);
    assert.deepEqual([sum.usable, sum.commits, sum.dirty], [true, 2, false]);
    assert.equal((await h.gitInit(dir, { name: "mine" })).created, false);

    // 仕掛けの入った設定があれば、git を呼ばない（ユーザーKBへの書き込みは通る）
    appendFileSync(path.join(dir, ".git", "config"), '[filter "evil"]\n\tclean = touch should-not-exist\n');
    writeFileSync(path.join(dir, ".gitattributes"), "* filter=evil\n");
    u.patchSpot(doc, official.get("takao-1"), "takao-1", { set: { fee: 900 } });
    const r2 = await store.save("mine", doc, { log: { cmd: "spot edit" } });
    assert.equal(r2.git.skipped, "unsafe");
    assert.match(r2.git.why, /\[filter\]/);
    assert.equal((await store.load("mine")).spots["takao-1"].set.fee, 900);
    assert.equal(existsSync(path.join(dir, "should-not-exist")), false);
    assert.equal((await h.gitInit(dir, { name: "mine" })).ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
