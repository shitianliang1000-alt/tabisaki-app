// tabisaki spot history / undo / redo / blame / batch と、kb snapshot / kb git
// （packages/cli/bin/spotkb.mjs・kbuser.mjs）の試験。Issue #360。
// ユーザーKB は一時フォルダ（TABISAKI_HOME）に書き、公式の kb/ には触らないことも見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
const HOME = mkdtempSync(path.join(os.tmpdir(), "tabisaki-hist-cli-"));
test.after(() => rmSync(HOME, { recursive: true, force: true }));
const env = { ...process.env, TZ: "UTC", TABISAKI_HOME: HOME, TABISAKI_PLUGINS: "0" };
delete env.TABISAKI_KB;
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env, input: "" });
const ok = (...args) => {
  const r = run(...args);
  assert.equal(r.status, 0, `${args.join(" ")}\n${r.stderr}`);
  return r;
};
const json = (...args) => JSON.parse(ok(...args, "--output=json").stdout);
const dir = (name = "mine") => path.join(HOME, "kbs", name);
const overlay = (name = "mine") => JSON.parse(readFileSync(path.join(dir(name), "overlay.json"), "utf8"));
// 差分の中身（書いた時刻 at は、取り消しで戻したときに新しくなるので、比べない）
const content = () => JSON.stringify(Object.fromEntries(Object.entries(overlay().spots).map(([id, e]) => [id, { ...e, at: undefined }])));
const file = (name, text) => {
  const p = path.join(HOME, name);
  writeFileSync(p, text);
  return p;
};
const kbBefore = readFileSync(new URL("../kb/spots-jp13-tokyo.json", import.meta.url), "utf8");

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }

let waterfall;

test("履歴: 書くたびに1行。取り消し・やり直し・スポットごとの取り消し", () => {
  assert.match(ok("spot", "history").stdout, /まだありません/);
  let r = ok("spot", "add", "name=秘密の滝", "lat=35.1", "lng=139.2", "genres=nature");
  waterfall = /足しました: (u:[0-9a-z]+)/.exec(r.stdout)[1];
  ok("spot", "edit", "takao-1", "fee=500");
  ok("spot", "edit", "takao-1", "fee=800", "dwell=40");
  ok("spot", "rm", "takao-2", "--yes");

  r = ok("spot", "history");
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.startsWith("#")).map((l) => l.replace(/\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+/, " ").split("  ")[0]), ["#4 spot rm", "#3 spot edit", "#2 spot edit", "#1 spot add"]);
  assert.match(r.stdout, /takao-1 [^\n]*: fee: 500 → 800、dwell: [^\n]* → 40|takao-1 [^\n]*fee: 500 → 800/);
  assert.equal(json("spot", "history").total, 4);
  assert.equal(json("spot", "history", "takao-1").records.length, 2);
  assert.equal(json("spot", "history", "--limit=1").records[0].seq, 4);
  assert.equal(run("spot", "history", "--limit=0").status, 2);

  // 試し（--dry-run）は書かない
  r = ok("spot", "undo", "--dry-run");
  assert.match(r.stdout, /#4 spot rm[^\n]*を取り消すと（試し/);
  assert.equal(overlay().spots["takao-2"].op, "remove");

  // いちばん新しい変更を取り消す → やり直す
  assert.match(ok("spot", "undo").stdout, /取り消しました: #4 spot rm[^\n]*tabisaki spot redo/);
  assert.equal(overlay().spots["takao-2"], undefined);
  assert.match(ok("spot", "redo").stdout, /やり直しました: #5 spot undo/);
  assert.equal(overlay().spots["takao-2"].op, "remove");
  r = run("spot", "redo");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /取り消した変更がありません/);
  assert.equal(run("spot", "redo", "takao-1").status, 2);

  // 古い変更（#2）は、あとで同じスポットが変わっている（#3）ので止まる。--force なら、あとの変更ごと戻す
  r = run("spot", "undo", "--seq=2");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /#2 spot edit[^\n]*を取り消せません/);
  assert.match(r.stderr, /takao-1 [^\n]*（#3 で変更）/);
  assert.equal(overlay().spots["takao-1"].set.fee, 800);
  assert.deepEqual(json("spot", "history").total, 6, "止まったときは、履歴にも足さない");
  const c = JSON.parse(run("spot", "undo", "--seq=2", "--output=json").stdout);
  assert.deepEqual([c.ok, c.target, c.conflicts[0].later], [false, 2, [3]]);
  ok("spot", "undo", "--seq=2", "--force");
  assert.equal(overlay().spots["takao-1"], undefined, "#2 の前（収録のまま）に戻る");
  assert.match(ok("spot", "redo").stdout, /やり直しました: #7 spot undo/);
  assert.equal(overlay().spots["takao-1"].set.fee, 800, "取り消しの取り消しで、元に戻る");

  // スポットを選ぶと、そのスポットを最後に変えた変更だけを取り消す
  r = ok("spot", "undo", "takao-2");
  assert.match(r.stdout, /取り消しました: #4 spot rm/);
  assert.equal(overlay().spots["takao-2"], undefined);
  assert.equal(overlay().spots["takao-1"].set.fee, 800);

  r = run("spot", "undo", "--seq=99");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /#99 の変更は履歴にありません/);
  assert.equal(run("spot", "undo", "--seq=x").status, 2);
  assert.equal(readFileSync(new URL("../kb/spots-jp13-tokyo.json", import.meta.url), "utf8"), kbBefore);
});

test("出どころ: 項目ごとに、どの変更で入った値か。手で書き換えた分は external として残る", () => {
  let b = json("spot", "blame", "takao-1");
  const by = Object.fromEntries(b.fields.map((f) => [f.field, f]));
  assert.equal(by.fee.source, "history");
  assert.equal(by.fee.by.seq, 3);
  assert.equal(by.fee.by.cmd, "spot edit");
  assert.equal(by.name.source, "official");
  const text = ok("spot", "blame", "takao-1").stdout;
  assert.match(text, /fee: 800\t#3 {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}spot edit/);
  assert.match(text, /name: [^\t]+\t収録/);

  // 足したスポット: 書いた項目は足した変更、書いていない項目は「自動で付いた値」
  b = json("spot", "blame", "秘密の滝");
  const mine = Object.fromEntries(b.fields.map((f) => [f.field, f]));
  assert.equal(mine.name.by.seq, 1);
  assert.equal(mine.lat.by.cmd, "spot add");
  assert.ok(b.fields.every((f) => f.source === "history" || f.source === "derived"), JSON.stringify(b.fields.filter((f) => f.source !== "history")));

  // 道具を通さずに overlay.json を書き換えると、次に使ったとき external の行になる
  const doc = overlay();
  doc.spots["takao-1"].set.fee = 1234;
  writeFileSync(path.join(dir(), "overlay.json"), JSON.stringify(doc, null, 2));
  const h = json("spot", "history", "--limit=1");
  assert.equal(h.records[0].cmd, "external");
  b = json("spot", "blame", "takao-1");
  assert.equal(b.fields.find((f) => f.field === "fee").by.cmd, "external");
  assert.match(ok("spot", "undo").stdout, /取り消しました: #\d+ external/);
  assert.equal(overlay().spots["takao-1"].set.fee, 800);

  // 履歴のこわれた行は飛ばして読む
  appendFileSync(path.join(dir(), "history.jsonl"), "{ 途中で止まった行\n");
  assert.equal(run("spot", "history").status, 0);
  assert.equal(run("spot", "blame", "ありえない名前のスポット").status, 2);
});

test("一括編集: まず試す。--apply で書く。まちがいが1つでもあれば、1つも書かない", () => {
  const before = content();
  const good = file("good.js", `
    for (const s of spots) {
      if (s.status === "add") edit(s.id, { dwell: 25, description: "静かな滝" });
    }
    edit("takao-1", { fee: 900 });
    log("見た数", spots.length);
  `);
  let r = ok("spot", "batch", good);
  assert.match(r.stdout, /｜見た数 2/);
  assert.match(r.stdout, /見せたスポット 2・頼まれた変更 2・変わるスポット 2・まちがい 0/);
  assert.match(r.stdout, /fee: 800 → 900/);
  assert.match(r.stdout, /試しです。書き込むには --apply/);
  assert.equal(content(), before, "試しでは書かない");

  // 決まりに合わない値・知らない id・囲いの外のものは、理由つきで止まる
  const bad = file("bad.js", 'edit("takao-1", { fee: 950 });\nedit("takao-1", { lat: 999 });\nedit("nope-1", { fee: 1 });\n');
  r = run("spot", "batch", bad, "--apply");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /2番目の edit（takao-1）: [^\n]*lat/);
  assert.match(r.stderr, /3番目の edit（nope-1）/);
  assert.match(r.stderr, /1つも書き込んでいません/);
  assert.equal(content(), before);
  for (const [name, code, re] of [
    ["req.js", 'require("node:fs").writeFileSync("x", "x")', /require is not defined/],
    ["proc.js", "process.exit(0)", /process is not defined/],
    ["eval.js", 'eval("1")', /Code generation from strings disallowed/],
    ["imp.js", 'import("node:fs")', /import は使えません/],
    ["loop.js", "while (true) {}", /時間がかかりすぎました/],
    ["many.js", 'for (let i = 0; i < 9; i++) edit("takao-1", { fee: i })', /変更が多すぎます（5 件まで/],
    ["syntax.js", "edit(", /batch|syntax\.js|Unexpected/],
  ]) {
    r = run("spot", "batch", file(name, code), "--apply", "--timeout=300", "--max=5");
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, name);
    assert.doesNotMatch(r.stderr, /\n\s+at /, `${name}: 積み重ねを見せない`);
  }
  assert.equal(content(), before);
  assert.equal(existsSync(path.join(process.cwd(), "x")), false);
  assert.equal(run("spot", "batch").status, 2);
  assert.equal(run("spot", "batch", path.join(HOME, "nope.js")).status, 2);
  assert.equal(run("spot", "batch", good, "--max=0").status, 2);

  // 書く → 1回の undo で、まとめて戻る
  const out = json("spot", "batch", good, "--apply");
  assert.deepEqual([out.applied, out.changed, out.errors.length], [true, 2, 0]);
  assert.equal(overlay().spots["takao-1"].set.fee, 900);
  assert.equal(overlay().spots[waterfall].spot.dwell, 25);
  assert.equal(json("spot", "history", "--limit=1").records[0].cmd, "spot batch");
  assert.match(ok("spot", "undo").stdout, /取り消しました: #\d+ spot batch（good\.js（2 件））・2 件/);
  assert.equal(content(), before);

  // --all は収録のスポットも見せる。--q でしぼる
  const all = file("all.js", 'log(spots.length, spots.every((s) => typeof s.id === "string"), spots.filter((s) => s.status === "official").length > 0)');
  assert.match(ok("spot", "batch", all, "--all", "--q=高尾").stdout, /｜\d+ true true/);
  assert.equal(readFileSync(new URL("../kb/spots-jp13-tokyo.json", import.meta.url), "utf8"), kbBefore);
});

test("スナップショット: 取っておく・確かめる・戻す（戻したことも取り消せる）・消す", () => {
  let r = ok("kb", "snapshot", "save", "before", "--note=作り直しの前");
  assert.match(r.stdout, /取っておきました: before（mine・差分 2 件/);
  assert.equal(run("kb", "snapshot", "save", "before").status, 2, "同じ名前では取らない");
  assert.equal(run("kb", "snapshot", "save", "../x").status, 2);
  r = ok("kb", "snapshot", "save");
  const auto = /取っておきました: (\d{8}-\d{6})/.exec(r.stdout)[1];
  assert.ok(existsSync(path.join(dir(), "snapshots", `${auto}.json`)));

  ok("spot", "edit", "takao-1", "fee=50");
  ok("spot", "rm", "秘密の滝", "--yes");
  r = ok("kb", "snapshot", "ls");
  assert.match(r.stdout, /before[^\n]*作り直しの前/);
  assert.match(ok("kb", "snapshot", "verify").stdout, /2 個すべて、取ったときのままです/);

  r = ok("kb", "snapshot", "restore", "before");
  assert.equal(overlay().spots["takao-1"].set.fee, 800);
  assert.equal(overlay().spots[waterfall].op, "add");
  assert.equal(json("spot", "history", "--limit=1").records[0].cmd, "kb snapshot restore");
  ok("spot", "undo");
  assert.equal(overlay().spots["takao-1"].set.fee, 50, "戻したことを取り消すと、戻す前になる");
  ok("spot", "redo");
  assert.equal(overlay().spots["takao-1"].set.fee, 800);

  // 中身を書き換えられたスナップショットには戻さない
  const p = path.join(dir(), "snapshots", "before.json");
  const snap = JSON.parse(readFileSync(p, "utf8"));
  snap.overlay.spots["takao-1"].set.fee = 1;
  writeFileSync(p, JSON.stringify(snap));
  r = run("kb", "snapshot", "verify", "before");
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /指紋が合いません/);
  r = run("kb", "snapshot", "restore", "before");
  assert.equal(r.status, 1);
  assert.equal(overlay().spots["takao-1"].set.fee, 800);

  assert.equal(run("kb", "snapshot", "rm", "before").status, 2, "--yes が要る");
  ok("kb", "snapshot", "rm", "before", "--yes");
  assert.deepEqual(readdirSync(path.join(dir(), "snapshots")), [`${auto}.json`]);
  assert.equal(run("kb", "snapshot", "restore", "before").status, 2);
  assert.equal(run("kb", "snapshot", "nope").status, 2);
  assert.match(ok("kb", "stats").stdout, /スナップショット 1 個/);
});

test("git への写し: kb git init のあとは、書くたびにコミット。あやしい設定があれば git を呼ばない", { skip: !hasGit && "git がありません" }, () => {
  assert.match(ok("kb", "git", "status").stdout, /git リポジトリではありません|kb git init/);
  const r0 = ok("kb", "git", "init");
  assert.match(r0.stdout, /git/);
  const git = (...a) => execFileSync("git", ["-C", dir(), ...a], { encoding: "utf8" });
  const count = () => Number(git("rev-list", "--count", "HEAD").trim());
  const n = count();
  ok("spot", "edit", "takao-1", "fee=700");
  assert.equal(count(), n + 1);
  assert.match(git("log", "-1", "--format=%B"), /^spot edit: [^\n]*\n\nTabisaki-Seq: \d+\nTabisaki-Changes: 1/);
  ok("spot", "undo");
  assert.equal(count(), n + 2);
  assert.match(git("log", "-1", "--format=%s"), /^spot undo: #\d+ spot edit を取り消した/);
  assert.equal(git("status", "--porcelain").trim(), "", "書いたあとは、写し残しが無い");
  assert.ok(!git("ls-files").split("\n").some((f) => f.startsWith("backups/") || f === ".lock" || f === "MERGE.json"));
  assert.match(ok("kb", "git", "status").stdout, new RegExp(`コミット ${n + 2}`));

  // フックは動かさない
  const hook = path.join(dir(), ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\ntouch hook-ran\nexit 1\n", { mode: 0o755 });
  ok("spot", "edit", "takao-1", "fee=710");
  assert.equal(count(), n + 3);
  assert.equal(existsSync(path.join(dir(), "hook-ran")), false);

  // 外の道具を動かす設定（filter など）があれば、git は呼ばない。ユーザーKBへの書き込みは通る
  appendFileSync(path.join(dir(), ".git", "config"), '[filter "x"]\n\tclean = touch filter-ran\n');
  writeFileSync(path.join(dir(), ".gitattributes"), "* filter=x\n");
  const r = ok("spot", "edit", "takao-1", "fee=720");
  assert.match(r.stdout + r.stderr, /git への写しはしていません[^\n]*\[filter\]/);
  assert.equal(overlay().spots["takao-1"].set.fee, 720);
  assert.equal(existsSync(path.join(dir(), "filter-ran")), false);
  assert.match(run("kb", "git", "status").stdout + run("kb", "git", "status").stderr, /\[filter\]/);
});

test("読む側が先に閉じても落ちない（tabisaki … | head）", { skip: process.platform === "win32" && "sh がありません" }, () => {
  const r = spawnSync("sh", ["-c", `"${process.execPath}" "${BIN}" spot help | true; "${process.execPath}" "${BIN}" kb help | head -n 1`], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /EPIPE|Unhandled|node:events/);
  assert.match(r.stdout, /\S/);
});
