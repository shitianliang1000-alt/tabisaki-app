// ./tabisaki（入口のシェルスクリプト）が壊れていないかを確かめます。
// マージで case の行が重なると、どのコマンドも動かなくなるためです。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (...args) => spawnSync("sh", args, { encoding: "utf8" });

test("./tabisaki は sh の文法として正しい", () => {
  const r = run("-n", "tabisaki");
  assert.equal(r.status, 0, r.stderr);
});

test("./tabisaki help と --version が動く", () => {
  const help = run("tabisaki", "help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /使いかた: \.\/tabisaki/);
  const v = run("tabisaki", "--version");
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^tabisaki \d+\.\d+\.\d+\n$/);
});

test("help に出るコマンドは Node 側へ渡され、同じ行が重ならない", () => {
  const src = readFileSync("tabisaki", "utf8");
  const help = run("tabisaki", "help").stdout.split("\n").filter((l) => l.trim());
  assert.equal(new Set(help).size, help.length, "help に同じ行があります");
  const dispatch = src.match(/^\s*(plan\|[^)]*)\) need node/m);
  assert.ok(dispatch, "Node へ渡す case の行がありません");
  for (const c of ["plan", "tui", "local", "kb", "similar", "spot", "area", "plugins", "sync", "voice-plan"]) {
    assert.ok(dispatch[1].split("|").includes(c), `${c} が case にありません`);
  }
});
