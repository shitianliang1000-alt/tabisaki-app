// tabisaki kb ls / create / fork / switch / diff / merge / validate / stats / backups / restore / rm
// （packages/cli/bin/kbuser.mjs）の試験。Issue #358。
// ユーザーKB は一時フォルダ（TABISAKI_HOME）に書き、公式の kb/ には触らないことも見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { overlayFingerprint, MERGE_SCHEMA } from "../packages/core/kbmerge.mjs";
import { parseKbArgs, parsePicks } from "../packages/cli/bin/kbuser.mjs";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
const HOME = mkdtempSync(path.join(os.tmpdir(), "tabisaki-kbuser-"));
test.after(() => rmSync(HOME, { recursive: true, force: true }));
const env = { ...process.env, TZ: "UTC", TABISAKI_HOME: HOME, TABISAKI_PLUGINS: "0" };
delete env.TABISAKI_KB;
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env, input: "" });
const ok = (...args) => {
  const r = run(...args);
  assert.equal(r.status, 0, `${args.join(" ")}\n${r.stderr}`);
  return r;
};
const dir = (name) => path.join(HOME, "kbs", name);
const overlay = (name) => JSON.parse(readFileSync(path.join(dir(name), "overlay.json"), "utf8"));
const kbBefore = readFileSync(new URL("../kb/spots-jp13-tokyo.json", import.meta.url), "utf8");

test("引数の読みかた", () => {
  assert.deepEqual(parsePicks("takao-1#fee=theirs, takao-2=ours"), { "takao-1#fee": "theirs", "takao-2": "ours" });
  assert.throws(() => parsePicks("takao-1#fee=both"), /--pick/);
  assert.deepEqual(parseKbArgs("merge", ["family", "--dry-run", "--pick=a=ours"]), { opts: { "dry-run": true, pick: "a=ours" }, words: ["family"] });
  assert.throws(() => parseKbArgs("ls", ["--yes"]), /--yes はありません/);
});

test("作る・分ける・切り替える。official という名前は使えない", () => {
  let r = run("kb", "help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /kb merge <相手>/);
  assert.match(ok("kb", "ls").stdout, /まだありません/);

  ok("spot", "add", "name=秘密の滝", "lat=35.1", "lng=139.2", "genres=nature");
  ok("spot", "edit", "takao-1", "fee=500");
  assert.match(ok("kb", "current").stdout, /決めていません/);

  r = ok("kb", "fork", "family", "--title=家族の旅");
  assert.match(r.stdout, /分けました: mine → family（差分 2 件/);
  assert.equal(overlay("family").parent.name, "mine");
  assert.equal(overlay("family").title, "家族の旅");
  assert.ok(existsSync(path.join(dir("family"), "bases", "mine.json")));

  assert.equal(run("kb", "create", "official").status, 2);
  assert.equal(run("kb", "fork", "mine", "official").status, 2);
  assert.equal(run("kb", "fork", "mine", "family").status, 2, "もうある名前には分けない");
  assert.equal(run("kb", "switch", "nowhere").status, 2);

  ok("kb", "switch", "family");
  assert.equal(ok("kb", "current").stdout.trim(), "family");
  const ls = JSON.parse(ok("kb", "ls", "--output=json").stdout);
  assert.equal(ls.current, "family");
  assert.deepEqual(ls.kbs.map((k) => [k.name, k.current, k.parent]), [["family", true, null].with(2, "mine"), ["mine", false, null]]);

  // 切り替えた先に、spot のコマンドが書く
  ok("spot", "edit", "takao-1", "fee=800", "description=家族向け");
  ok("spot", "add", "name=公園", "lat=35.2", "lng=139.3");
  ok("spot", "rm", "takao-2", "--yes");
  assert.equal(overlay("family").spots["takao-1"].set.fee, 800);
  assert.equal(overlay("mine").spots["takao-1"].set.fee, 500, "元は変わらない");

  // --kb と環境変数は、切り替えより先に使う
  ok("spot", "edit", "takao-1", "fee=600", "dwell=40", "--kb=mine");
  ok("spot", "edit", "takao-3", "fee=100", "--kb=mine");
  assert.equal(overlay("mine").spots["takao-1"].set.fee, 600);
});

test("比べる: 公式の収録から・ほかのユーザーKBと・控えと", () => {
  ok("kb", "switch", "mine");
  let r = ok("kb", "diff");
  assert.match(r.stdout, /公式の収録 → mine: 3 件/);
  assert.match(r.stdout, /fee: 0（収録） → 600/);

  r = ok("kb", "diff", "family");
  assert.match(r.stdout, /mine → family: 4 件/);
  assert.match(r.stdout, /fee: 600 → 800/);
  assert.match(r.stdout, /\+ takao-2 高尾山山頂［family で消した］/);

  const j = JSON.parse(ok("kb", "diff", "mine", "family", "--output=json").stdout);
  assert.deepEqual(j.changes.map((c) => c.kind).sort(), ["added", "added", "changed", "removed"]);

  const backups = ok("kb", "backups").stdout.trim().split("\n");
  assert.ok(backups.length >= 3);
  r = ok("kb", "diff", `mine@${backups[0]}`, "mine");
  assert.match(r.stdout, /takao-1/);
  assert.equal(run("kb", "diff", "mine@nope.json").status, 2);
  assert.equal(run("kb", "diff", "a", "b", "c").status, 2);
});

test("まとめる: 競合があれば書かずに止まり、解いてから続ける", () => {
  const before = readFileSync(path.join(dir("mine"), "overlay.json"), "utf8");

  let r = run("kb", "merge", "family", "--dry-run");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /試し。書き込みません/);
  assert.match(r.stdout, /足す 2・置き換える 0・項目を取り込む 1・差分を消す 0・競合 1/);
  assert.equal(existsSync(path.join(dir("mine"), "MERGE.json")), false, "試しでは何も書かない");

  r = run("kb", "merge", "family");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /takao-1#fee　高尾山薬王院 の fee\n {4}分かれる前: 500\n {4}mine: 600\n {4}family: 800/);
  assert.match(r.stderr, /--continue --pick=takao-1#fee=theirs/);
  assert.equal(readFileSync(path.join(dir("mine"), "overlay.json"), "utf8"), before, "競合が残っているうちは書かない");
  assert.ok(existsSync(path.join(dir("mine"), "MERGE.json")));
  assert.match(ok("kb", "validate").stdout, /途中の統合があります/);

  // 途中のあいだは、別の統合を始めない。知らない競合の名前は断る
  r = run("kb", "merge", "family");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /途中の統合があります/);
  assert.equal(run("kb", "merge", "--continue", "--pick=takao-9#fee=ours").status, 2);

  r = ok("kb", "merge", "--continue", "--pick=takao-1#fee=theirs");
  assert.match(r.stdout, /取り込みました（family → mine）: 足した 2・置き換えた 0・項目を取り込んだ 1・差分を消した 0・競合 1（自分 0・相手 1・まだ 0）/);
  assert.match(r.stderr, /戻すとき: tabisaki kb restore \d{8}T\d{9}Z\.json --kb=mine/);
  const o = overlay("mine");
  assert.deepEqual(o.spots["takao-1"].set, { description: "家族向け", dwell: 40, fee: 800 });
  assert.equal(o.spots["takao-2"].op, "remove");
  assert.equal(o.spots["takao-3"].set.fee, 100);
  assert.equal(Object.values(o.spots).filter((e) => e.op === "add").length, 2);
  assert.equal(existsSync(path.join(dir("mine"), "MERGE.json")), false);
  assert.ok(existsSync(path.join(dir("mine"), "bases", "family.json")), "次の統合の土台を控える");

  assert.match(ok("kb", "merge", "family").stdout, /取り込むものはありません/);

  // 逆向き: family は分かれてから変わっていないので、競合なしで mine の分が入る
  r = ok("kb", "merge", "mine", "--kb=family", "--output=json");
  const j = JSON.parse(r.stdout);
  assert.equal(j.written, true);
  assert.equal(j.counts.conflicts, 0);
  assert.match(ok("kb", "diff", "mine", "family").stdout, /違いはありません/);
  assert.equal(readFileSync(new URL("../kb/spots-jp13-tokyo.json", import.meta.url), "utf8"), kbBefore, "公式の kb/ は変わらない");
});

test("まとめる: やめる・途中で止まったあとの後片付け・始めてから変わっていたら止める", () => {
  // family の側で fee を変え、mine でも変える → 競合
  ok("spot", "edit", "takao-1", "fee=900", "--kb=family");
  ok("spot", "edit", "takao-1", "fee=700", "--kb=mine");
  assert.equal(run("kb", "merge", "family").status, 1);
  assert.match(ok("kb", "merge", "--abort").stdout, /やめました/);
  assert.equal(overlay("mine").spots["takao-1"].set.fee, 700);
  assert.match(ok("kb", "merge", "--abort").stdout, /途中の統合はありません/);
  assert.equal(run("kb", "merge", "--continue").status, 2);

  // 始めてから自分の側が変わったら、続けない
  assert.equal(run("kb", "merge", "family").status, 1);
  ok("spot", "edit", "takao-3", "fee=150", "--kb=mine");
  let r = run("kb", "merge", "--continue", "--theirs");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /始めてから「mine」が変わっています/);
  ok("kb", "merge", "--abort");

  // 書き込んだ直後に止まった形（MERGE.json に applying が残っている）を作り、--continue で片付ける
  const state = {
    schema: MERGE_SCHEMA, into: "mine", from: { kind: "kb", label: "family", name: "family" },
    startedAt: "2026-11-11T00:00:00.000Z", ours: "x", theirs: overlay("family"), base: null, picks: {},
    applying: overlayFingerprint(overlay("mine")),
  };
  writeFileSync(path.join(dir("mine"), "MERGE.json"), JSON.stringify(state));
  r = ok("kb", "merge", "--continue");
  assert.match(r.stdout, /書き込み済みでした/);
  assert.equal(existsSync(path.join(dir("mine"), "MERGE.json")), false);

  // 土台が今の family になったので、もう競合しない（自分の 700 が残る）
  assert.match(ok("kb", "merge", "family").stdout, /取り込むものはありません/);
  assert.equal(overlay("mine").spots["takao-1"].set.fee, 700);
});

test("まとめる: 別の端末のファイルから。--ours / --theirs でまとめて解く", () => {
  const other = overlay("mine");
  other.spots["takao-1"].set.fee = 1200;
  other.spots["u:zz12345678"] = { op: "add", spot: { name: "別の端末の滝", lat: 35.3, lng: 139.1 }, at: "2026-11-11T00:00:00.000Z" };
  const file = path.join(HOME, "other-device.json");
  writeFileSync(file, JSON.stringify(other));

  let r = run("kb", "merge", file, "--dry-run");
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /分かれる前/, "土台が無いときは、分かれる前を出さない");
  r = ok("kb", "merge", file, "--ours");
  assert.match(r.stdout, /足した 1・.*競合 1（自分 1・相手 0・まだ 0）/);
  assert.equal(overlay("mine").spots["takao-1"].set.fee, 700);
  assert.equal(overlay("mine").spots["u:zz12345678"].spot.name, "別の端末の滝");
  r = ok("kb", "merge", file, "--theirs");
  assert.equal(overlay("mine").spots["takao-1"].set.fee, 1200);

  // おかしいファイルは取り込まない
  writeFileSync(file, JSON.stringify({ ...other, spots: { "u:zz12345678": { op: "add", spot: { name: "座標なし" } } } }));
  r = run("kb", "merge", file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ユーザーKBとして読めません/);
  writeFileSync(file, "{ こわれた");
  assert.equal(run("kb", "merge", file).status, 1);
  assert.equal(run("kb", "merge", "mine").status, 2, "自分自身は取り込めない");
  assert.equal(run("kb", "merge", "official").status, 2);
  assert.equal(run("kb", "merge", "family", "--ours", "--theirs").status, 2);
});

test("点検と集計", () => {
  let r = ok("kb", "validate");
  assert.match(r.stdout, /mine: 差分 \d+ 件を点検しました。まちがい 0・気をつけること 0（使えます）/);

  // 公式に無い id の差分（見失った差分）は、気をつけること。--strict ならまちがい扱い
  const d = overlay("mine");
  d.spots["gone-1"] = { op: "patch", set: { fee: 1 }, unset: [], was: { fee: 0 }, anchor: { name: "消えた寺", lat: 35, lng: 139 }, at: "2026-11-11T00:00:00.000Z" };
  writeFileSync(path.join(dir("mine"), "overlay.json"), JSON.stringify(d));
  r = ok("kb", "validate");
  assert.match(r.stdout, /△ gone-1: 公式の収録に見つかりません（消えた寺）/);
  assert.equal(run("kb", "validate", "--strict").status, 1);

  // 決まりに合わない差分は、まちがい
  d.spots["u:bad0000001"] = { op: "add", spot: { name: "ゼロ", lat: 0, lng: 0 }, at: "2026-11-11T00:00:00.000Z" };
  writeFileSync(path.join(dir("mine"), "overlay.json"), JSON.stringify(d));
  r = run("kb", "validate", "--output=json");
  assert.equal(r.status, 1);
  const v = JSON.parse(r.stdout);
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors.map((e) => e.code), ["zero_coord"]);

  const s = JSON.parse(ok("kb", "stats", "--output=json").stdout);
  assert.equal(s.name, "mine");
  assert.equal(s.total, Object.keys(d.spots).length);
  assert.equal(s.counts.remove, 1);
  assert.ok(s.prefectures.some((p) => p.name === "東京都"));
  assert.ok(s.backups > 3);
  assert.match(ok("kb", "stats", "family").stdout, /family（家族の旅）: 差分 \d+ 件/);

  // こわれたファイルは、読めないこと自体を点検の結果として返す
  writeFileSync(path.join(dir("family"), "overlay.json"), "{ こわれた");
  r = run("kb", "validate", "family");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /JSON として読めません/);
  assert.equal(run("kb", "validate", "nowhere").status, 2);
});

test("控えから戻す・消す", () => {
  const backups = ok("kb", "backups", "mine").stdout.trim().split("\n");
  const last = backups.at(-1);
  const r = ok("kb", "restore", last, "--kb=mine");
  assert.match(r.stdout, /戻しました: mine ← /);
  assert.equal(run("kb", "restore", "../../x.json").status, 2);

  assert.equal(run("kb", "rm", "family").status, 2, "--yes が無ければ消さない");
  ok("kb", "switch", "mine");
  // family は中身がこわれているけれど、片付けられる（読まずに trash/ へ動かす）
  assert.match(ok("kb", "rm", "family", "--yes").stdout, /trash/);
  assert.equal(run("kb", "rm", "family", "--yes").status, 2, "もう無いものは消せない");
  ok("kb", "fork", "mine", "trip2");
  ok("kb", "switch", "trip2");
  assert.match(ok("kb", "rm", "trip2", "--yes").stdout, /trash/);
  assert.match(ok("kb", "current").stdout, /決めていません/, "使っていたものを消したら、切り替えも外れる");
  assert.ok(readdirSync(path.join(HOME, "trash")).some((f) => f.startsWith("trip2-")));
});

test("plan は、切り替えたユーザーKBを重ねて組む（--kb=official で重ねない）", () => {
  ok("kb", "create", "planning");
  ok("kb", "switch", "planning");
  let r = run("plan", "高尾山で景色", "--output=json");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ユーザーKB「planning」を重ねて組みます/);
  r = run("plan", "高尾山で景色", "--output=json", "--kb=official");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /重ねて組みます/);
  ok("kb", "switch", "--official");
  r = run("plan", "高尾山で景色", "--output=json");
  assert.doesNotMatch(r.stderr, /重ねて組みます/);
});
