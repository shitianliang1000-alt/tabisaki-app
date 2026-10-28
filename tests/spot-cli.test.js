// tabisaki spot / area（packages/cli/bin/spot.mjs）の試験。
// 足した情報は一時フォルダ（TABISAKI_HOME）に書き、kb/ には触らないことも見ます。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
const HOME = mkdtempSync(path.join(os.tmpdir(), "tabisaki-home-"));
test.after(() => rmSync(HOME, { recursive: true, force: true }));
const env = { ...process.env, TZ: "UTC", TABISAKI_HOME: HOME, TABISAKI_TODAY: "2026-10-27" };
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env });
const store = () => JSON.parse(readFileSync(path.join(HOME, "spots.json"), "utf8"));
const kbBefore = readFileSync(new URL("../kb/spots-jp20-nagano.json", import.meta.url), "utf8");

test("営業時間・別名・季節を足すと、出典と確認日つきで手元の spots.json に入る", () => {
  let r = run("spot", "hours", "set", "雲場池", "9:00-17:00", "--closed=水", "--last-entry=16:30", "--source=公式サイト", "--url=https://example.jp/");
  assert.equal(r.status, 0, r.stderr);
  r = run("spot", "alias", "add", "雲場池", "白鳥湖");
  assert.equal(r.status, 0, r.stderr);
  r = run("spot", "seasonal", "add", "白鳥湖", "紅葉", "--from=10-20", "--to=11-10", "--source=町の観光案内");
  assert.equal(r.status, 0, r.stderr);

  const e = store().spots["karuizawa-2"];
  assert.deepEqual(e.hours.value, { open: 9, close: 17, lastEntry: 16.5, closedDays: [3] });
  assert.deepEqual(e.hours.source, { name: "公式サイト", url: "https://example.jp/", retrievedAt: "2026-10-27" });
  assert.equal(e.hours.status, "verified");
  assert.equal(e.aliases[0].value, "白鳥湖");
  assert.equal(e.seasonal[0].value.name, "紅葉");

  r = run("spot", "show", "白鳥湖");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /雲場池（karuizawa-2/);
  assert.match(r.stdout, /営業時間: 9:00〜17:00・最終入場 16:30・定休 水曜/);
  assert.match(r.stdout, /✓ 確認済み 2026-10-27（今日）・出典 公式サイト/);
  const j = JSON.parse(run("spot", "show", "karuizawa-2", "--output=json").stdout);
  assert.equal(j.extras.length, 3);
  assert.equal(j.extras[0].freshness.verified, true);

  assert.equal(run("spot", "check").status, 0);
  assert.equal(readFileSync(new URL("../kb/spots-jp20-nagano.json", import.meta.url), "utf8"), kbBefore, "kb/ は書き換えない");
});

test("足した営業時間が旅程に効く（定休日の水曜には入らない）", () => {
  const plan = (date) => run("plan", "軽井沢 雲場池", `--date=${date}`).stdout;
  assert.match(plan("2026-11-05"), /雲場池 \| 09:00〜17:00・最終入場 16:30・定休 水曜/);
  assert.doesNotMatch(plan("2026-11-04"), /\| 📍 \| 雲場池 \|/);
});

test("未確認の値は旅程に使わず、verify で確認済みになる", () => {
  const doc = store();
  doc.spots["karuizawa-1"] = { hours: {
    value: { open: 10, close: 11 }, origin: "wikidata", status: "unverified",
    source: { name: "Wikidata", license: "CC0 1.0", retrievedAt: "2026-10-01" },
  } };
  writeFileSync(path.join(HOME, "spots.json"), JSON.stringify(doc));
  let r = run("spot", "show", "karuizawa-1");
  assert.match(r.stdout, /\? 未確認・Wikidataから 2026-10-01（26日前）/);
  assert.match(r.stdout, /旅程の計算には使いません/);
  r = run("spot", "verify", "karuizawa-1", "hours");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1件/);
  assert.equal(store().spots["karuizawa-1"].hours.checkedAt, "2026-10-27");
});

test("写真はライセンスと撮った人が無いと入らない", () => {
  let r = run("spot", "photo", "add", "雲場池", "--url=https://example.jp/a.jpg", "--author=私");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--license/);
  r = run("spot", "photo", "add", "雲場池", "--url=https://example.jp/a.jpg", "--author=私", "--license=CC BY 4.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(store().spots["karuizawa-2"].photos[0].source.license, "CC BY 4.0");
});

test("エリアを決めて、手で決めたものだけを並べる", () => {
  let r = run("area", "define", "my-pond", "--name=軽井沢の池", "--center=36.35,138.63", "--radius=3");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /収録のスポット \d+か所/);
  r = run("area", "define", "my-two", "--name=二つ", "--spots=karuizawa-1,雲場池");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(store().areas["my-two"].spots, ["karuizawa-1", "karuizawa-2"]);
  r = run("area", "ls", "--custom-only", "--output=json");
  assert.deepEqual(JSON.parse(r.stdout).areas.map((a) => a.id), ["my-pond", "my-two"]);
  assert.ok(JSON.parse(run("area", "ls", "--output=json").stdout).areas.length > 1000);
  assert.equal(run("area", "rm", "my-two").status, 0);
});

test("使いかたのまちがいは終了コード 2", () => {
  for (const args of [
    ["spot", "show", "神明社"], // いくつもある
    ["spot", "show", "どこにもない場所"],
    ["spot", "hours", "set", "雲場池", "9:00-17:00"], // 出典が無い
    ["spot", "hours", "set", "雲場池", "17:00-9:00", "--source=x"],
    ["spot", "seasonal", "add", "雲場池", "祭", "--from=秋", "--to=11-01", "--source=x"],
    ["spot", "fly"],
    ["spot", "show", "雲場池", "--nope=1"],
    ["spot", "generate", "軽井沢"], // AI の場所が無い
    ["area", "define", "Bad Id", "--name=x", "--center=1,1", "--radius=1"],
    ["area", "define", "karuizawa", "--name=x", "--center=1,1", "--radius=1"], // 収録のエリアと同じ id
  ]) {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...env, TABISAKI_LLM_URL: "", TABISAKI_LLM_MODEL: "" } });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^tabisaki: /);
  }
  assert.match(run("spot", "help").stdout, /spot enrich/);
});
