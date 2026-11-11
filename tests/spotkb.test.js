// tabisaki spot add / edit / rm / restore / list / show / import / export / dedup（packages/cli/bin/spotkb.mjs）の試験。
// ユーザーKB は一時フォルダ（TABISAKI_HOME）に書き、公式の kb/ には触らないことも見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
const HOME = mkdtempSync(path.join(os.tmpdir(), "tabisaki-kb-"));
test.after(() => rmSync(HOME, { recursive: true, force: true }));
const env = { ...process.env, TZ: "UTC", TABISAKI_HOME: HOME };
delete env.TABISAKI_KB;
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env, input: "" });
const overlay = (name = "mine") => JSON.parse(readFileSync(path.join(HOME, "kbs", name, "overlay.json"), "utf8"));
const kbBefore = readFileSync(new URL("../kb/spots-jp20-nagano.json", import.meta.url), "utf8");
const file = (name, text) => {
  const p = path.join(HOME, name);
  writeFileSync(p, text);
  return p;
};

test("足す・直す・消す・戻す。公式の kb/ は変わらない", () => {
  let r = run("spot", "add", "name=裏高尾の湧き水", "lat=35.64", "lng=139.25", "genres=nature;view", "dwell=20");
  assert.equal(r.status, 0, r.stderr);
  const id = /足しました: (u:[0-9a-z]+)/.exec(r.stdout)[1];
  assert.equal(overlay().spots[id].spot.name, "裏高尾の湧き水");
  assert.deepEqual(overlay().spots[id].spot.genres, ["nature", "view"]);
  if (process.platform !== "win32") assert.equal(statSync(path.join(HOME, "kbs", "mine", "overlay.json")).mode & 0o777, 0o600);

  // 近くに同じ名前があれば止める（--force で足せる）
  r = run("spot", "add", "name=裏高尾の湧き水", "lat=35.6401", "lng=139.2501");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /近くに同じ名前/);

  // まちがった値は理由を返す
  r = run("spot", "add", "name=x", "lat=95", "lng=139");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /lat/);

  // 公式のスポットは差分として直す
  r = run("spot", "edit", "takao-1", "fee=300", "description=朝が静か");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(overlay().spots["takao-1"].set, { fee: 300, description: "朝が静か" });
  assert.equal(overlay().spots["takao-1"].was.fee, 0);

  // 足したスポットは名前でも選べる
  r = run("spot", "edit", "裏高尾の湧き水", "fee=0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(overlay().spots[id].spot.fee, 0);

  // 端末でなければ、--yes が無いと消さない
  r = run("spot", "rm", "takao-2");
  assert.equal(r.status, 2);
  assert.equal(overlay().spots["takao-2"], undefined);
  r = run("spot", "rm", "takao-2", "--yes", "--reason=混む");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(overlay().spots["takao-2"].op, "remove");
  assert.equal(overlay().spots["takao-2"].reason, "混む");

  r = run("spot", "restore", "takao-2");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(overlay().spots["takao-2"], undefined);

  // 書くたびに控えが残る
  assert.ok(readdirSync(path.join(HOME, "kbs", "mine", "backups")).length >= 3);
  assert.equal(readFileSync(new URL("../kb/spots-jp20-nagano.json", import.meta.url), "utf8"), kbBefore);
});

test("一覧・1件の中身（show は差分があるときだけユーザーKB の形で出す）", () => {
  let r = run("spot", "list", "--output=json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.spots.map((s) => s.status).sort(), ["add", "patch"]);

  r = run("spot", "show", "takao-1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /［直した］/);
  assert.match(r.stdout, /fee: 300（収録: 0）/);

  r = run("spot", "show", "裏高尾の湧き水", "--output=json");
  assert.equal(JSON.parse(r.stdout).status, "add");

  // 差分の無い公式のスポットは、これまでどおり収録の情報（#361）を出す
  r = run("spot", "show", "takao-2");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /収録: 出どころ/);

  r = run("spot", "list", "--all");
  assert.equal(r.status, 2);
  r = run("spot", "list", "--all", "--q=薬王院");
  assert.match(r.stdout, /takao-1\t高尾山薬王院［直した］/);
});

test("取り込み: 部分失敗・重なり・--dry-run・--strict・Shift_JIS", () => {
  const csv = file("in.csv", [
    "名前,緯度,経度,説明",
    "秘密の滝,35.1,139.2,夏が涼しい",
    "裏高尾の湧き水,35.64,139.25,",   // 足したものと重なる
    "秘密の滝,35.1001,139.2001,",      // 同じファイルの中で重なる
    "入れ替わり,139.3,35.3,",           // 緯度・経度が逆
    "名無し,abc,139,",                  // 数でない
  ].join("\n"));

  let r = run("spot", "import", csv, "--dry-run", "--output=json");
  assert.equal(r.status, 1);
  let j = JSON.parse(r.stdout);
  assert.equal(j.wouldAdd, 1);
  assert.equal(j.added, 0);
  assert.deepEqual(j.duplicates.map((d) => d.line), [3, 4]);
  assert.deepEqual(j.failed.map((f) => f.line), [5, 6]);
  assert.match(j.failed[0].errors.join(), /入れ替わって/);
  const before = Object.keys(overlay().spots).length;

  r = run("spot", "import", csv, "--strict");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1行も足していません/);
  assert.equal(Object.keys(overlay().spots).length, before);

  r = run("spot", "import", csv);
  assert.equal(r.status, 1, "一部の行が取り込めなかったときは 1");
  assert.match(r.stdout, /足した行 1・重なり 2・まちがい 2/);
  assert.match(r.stderr, /5行目 入れ替わり: 緯度と経度が入れ替わっているようです/);
  assert.equal(Object.keys(overlay().spots).length, before + 1);

  // Shift_JIS（表計算ソフトの既定）。「名前,緯度,経度\n滝,35.5,139.5\n」
  const sjis = Buffer.from([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x88, 0xdc, 0x93, 0x78, 0x2c, 0x8c, 0x6f, 0x93, 0x78, 0x0a, 0x91, 0xea, 0x2c, 0x33, 0x35, 0x2e, 0x35, 0x2c, 0x31, 0x33, 0x39, 0x2e, 0x35, 0x0a]);
  const sj = path.join(HOME, "sjis.csv");
  writeFileSync(sj, sjis);
  r = run("spot", "import", sj, "--kb=other", "--output=json");
  assert.equal(r.status, 0, r.stderr);
  j = JSON.parse(r.stdout);
  assert.equal(j.encoding, "shift_jis");
  assert.equal(j.added, 1);
  assert.equal(Object.values(overlay("other").spots)[0].spot.name, "滝");

  r = run("spot", "import", path.join(HOME, "nai.csv"));
  assert.equal(r.status, 2);
});

test("書き出し: 足したスポットを CSV・GeoJSON・KML・JSON で。取り込み直すと同じになる", () => {
  let r = run("spot", "export", "--format=geojson");
  assert.equal(r.status, 0, r.stderr);
  const g = JSON.parse(r.stdout);
  assert.ok(g.features.length >= 2);
  assert.ok(g.features.every((f) => f.id.startsWith("u:")), "既定では足したものだけ");

  r = run("spot", "export", "--format=json", "--with-edited");
  assert.ok(JSON.parse(r.stdout).spots.some((s) => s.id === "takao-1" && s.fee === 300));

  const out = path.join(HOME, "out.kml");
  r = run("spot", "export", `--out=${out}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(out, "utf8"), /<kml/);
  r = run("spot", "export", `--out=${out}`);
  assert.equal(r.status, 2, "上書きしない");

  // 別のユーザーKB に取り込み直すと、同じ名前と座標になる
  const csvOut = path.join(HOME, "out.csv");
  run("spot", "export", `--out=${csvOut}`);
  r = run("spot", "import", csvOut, "--kb=copy", "--output=json");
  assert.equal(r.status, 0, r.stderr);
  const names = (n) => Object.values(overlay(n).spots).filter((e) => e.op === "add").map((e) => `${e.spot.name}@${e.spot.lat},${e.spot.lng}`).sort();
  assert.deepEqual(names("copy"), names("mine"));
});

test("重なりの点検と、使いかたのまちがい", () => {
  let r = run("spot", "add", "name=高尾山薬王院", "lat=35.6257", "lng=139.2473", "--force");
  assert.equal(r.status, 0, r.stderr);
  r = run("spot", "dedup", "--output=json");
  assert.equal(r.status, 0, r.stderr);
  const pair = JSON.parse(r.stdout).pairs.find((p) => p.with === "takao-1");
  assert.ok(pair && pair.official);

  assert.equal(run("spot", "add", "--bogus").status, 2);
  assert.equal(run("spot", "list", "--kb=../etc").status, 2);
  assert.equal(run("spot", "dedup", "--radius=0").status, 2);
  assert.equal(run("spot", "edit", "takao-1").status, 2);
  assert.ok(!existsSync(path.join(HOME, "kbs", "..", "etc")));
});
