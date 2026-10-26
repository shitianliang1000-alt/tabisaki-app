// CLI（packages/cli/bin/tabisaki-plan.mjs と ./tabisaki plan）の試験。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });

test("plan で Markdown の旅程が stdout に出る（ログは混ざらない）", () => {
  const r = run("plan", "温泉と海をゆっくり楽しみたい", "--days=2", "--date=2026-11-07");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^# /);
  assert.match(r.stdout, /## 2日目/);
  assert.match(r.stdout, /\| 08:00〜/);
  assert.doesNotMatch(r.stdout, /Warning|\[kb\]/);
});

test("--output=json は JSON として読める", () => {
  const r = run("plan", "京都の寺", "--from=新大阪駅", "--output=json", "--date=2026-11-03");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.request.from, "新大阪駅");
});

test("使いかたのまちがいは終了コード 2 と、理由の1行", () => {
  for (const args of [["plan"], ["plan", "x", "--days=abc"], ["plan", "x", "--from=どこか"],
    ["plan", "x", "--nope=1"], ["plan", "x", "--local"], ["fly"], ["plan", "x", "--output=pdf"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^tabisaki: /);
    assert.equal(r.stdout, "");
  }
});

test("help と --version", () => {
  assert.match(run("help").stdout, /使いかた: tabisaki plan/);
  assert.match(run("--version").stdout, /^tabisaki \d+\.\d+\.\d+\n$/);
});
