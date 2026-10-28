// 旅程ファイル（Journey as Code、packages/journey）の試験。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml, stringifyYaml, YamlError } from "../packages/journey/yaml.mjs";
import { parseJourney, JourneyError, diffJourneys, lineOf } from "../packages/journey/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "packages/cli/bin/tabisaki-plan.mjs");
const SAMPLE = path.join(ROOT, "examples/trips/hakone.yaml");
const QUICK = path.join(ROOT, "examples/trips/hakone-quick.yaml");
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: ROOT, env: { ...process.env, TZ: "UTC" } });
const tmp = mkdtempSync(path.join(tmpdir(), "tabisaki-journey-"));
const write = (name, text) => { const f = path.join(tmp, name); writeFileSync(f, text); return f; };

test("YAML: 入れ子・並び・引用・複数行・注釈を読む", () => {
  const v = parseYaml(`# 注釈
version: 1
title: 箱根 # 後ろの注釈
date: 2026-11-07
start: "08:00"
tags: [温泉, "海 と 山", 3]
c:
  list:
    - 大涌谷
    - 'It''s'
  n: 40_000
items:
- name: a
  more:
  - x
- plain
note: |
  1行目
  2行目
fold: >-
  a
  b
empty:
`);
  assert.deepEqual(v, {
    version: 1, title: "箱根", date: "2026-11-07", start: "08:00", tags: ["温泉", "海 と 山", 3],
    c: { list: ["大涌谷", "It's"], n: 40000 },
    items: [{ name: "a", more: ["x"] }, "plain"],
    note: "1行目\n2行目\n", fold: "a b", empty: null,
  });
});

test("YAML: 読まない書きかたは、行の番号つきのエラー", () => {
  const cases = [
    ["a: 1\na: 2", 2, /2回/], ["a: &x 1", 1, /アンカー/], ["a: {b: 1}", 1, /\{/],
    ["a:\n\tb: 1", 2, /タブ/], ['a: "x', 1, /閉じ/], ["a: 1\n---\nb: 2", 2, /1つだけ/],
    ["a: !!str 1", 1, /型/], ["a: [1, [2]]", 1, /入れ子/],
  ];
  for (const [text, line, re] of cases) {
    assert.throws(() => parseYaml(text), (e) => e instanceof YamlError && e.line === line && re.test(e.message), text);
  }
});

test("YAML: 書いたものを読み戻すと同じになる", () => {
  const v = {
    version: 1, title: "true", wish: "温泉: 海 # と", date: "2026-11-07", start: "08:00",
    list: ["- a", "b", 1, true, null], deep: { x: [{ a: 1, b: "c" }, "d"] }, note: "1\n2\n", s: "",
  };
  const text = stringifyYaml(v);
  assert.deepEqual(parseYaml(text), v);
  assert.equal(stringifyYaml(parseYaml(text)), text);
});

test("旅程ファイル: 知らない項目・型・範囲のまちがいを、行の番号と近い名前つきで出す", () => {
  const text = "version: 1\ntitle: x\nwhish: y\ndays: 0\ntransport: trnsit\nconstraints:\n  budget_yen: たくさん\n";
  assert.throws(() => parseJourney(text, "t.yaml"), (e) => {
    assert.ok(e instanceof JourneyError);
    const by = Object.fromEntries(e.problems.map((p) => [p.path, p]));
    assert.match(by.whish.message, /もしかして wish/);
    assert.equal(by.whish.line, 3);
    assert.ok(by.wish, "wish が無いことも出す");
    assert.equal(by.days.line, 4);
    assert.match(by.transport.message, /もしかして transit/);
    assert.equal(by["constraints.budget_yen"].line, 7);
    return true;
  });
});

test("旅程ファイル: 新しい版は読まない（新しい tabisaki にしてと出す）", () => {
  assert.throws(() => parseJourney("version: 2\ntitle: x\nwish: y\n"), /新しい tabisaki/);
});

test("旅程ファイル: 書いていない項目は既定の値で埋まる", () => {
  const { def } = parseJourney("version: 1\ntitle: x\nwish: 温泉\n");
  assert.equal(def.from, "東京駅");
  assert.equal(def.days, 1);
  assert.equal(def.constraints.respect_hours, true);
  assert.deepEqual(def.constraints.must_visit, []);
  assert.equal(def.output.format, "markdown");
});

test("lineOf は入れ子の項目の行を探す", () => {
  const t = "a: 1\nconstraints:\n  must_visit: []\n  budget_yen: 3\n";
  assert.equal(lineOf(t, "constraints.budget_yen"), 4);
  assert.equal(lineOf(t, "nope"), null);
});

test("build: 見本の旅程が組め、必ず立ち寄る場所が入る", () => {
  const r = run("build", SAMPLE, "--output=json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.title, "秋の箱根で温泉と美術館");
  assert.equal(j.days.length, 2);
  assert.ok(j.days.flatMap((d) => d.items).some((it) => it.kind === "spot" && it.title === "ポーラ美術館"));
});

test("build: output.file があればそこへ書く", () => {
  const f = write("out.yaml", "version: 1\ntitle: 書き出し\nwish: 温泉と海\ndate: \"2026-11-07\"\noutput:\n  file: out.md\n");
  const r = run("build", f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(readFileSync(path.join(tmp, "out.md"), "utf8"), /^# 書き出し/);
});

test("test: 見本は条件を守る（終了コード 0）", () => {
  const r = run("test", SAMPLE);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ 必ず立ち寄る: ポーラ美術館/);
  assert.match(r.stdout, /すべて守っています/);
});

test("test: 守れない条件があれば ✗ と終了コード 1", () => {
  const f = write("tight.yaml", `version: 1
title: きつい条件
wish: 箱根で温泉と美術館
date: "2026-11-07"
constraints:
  budget_yen: 1
  max_leg_minutes: 5
  max_spots_per_day: 1
`);
  const r = run("test", f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ 費用/);
  assert.match(r.stdout, /✗ 移動の長さ/);
  assert.match(r.stdout, /✗ 1日の立ち寄り/);
});

test("収録に無いスポットは、近い名前つきでエラー（終了コード 2）", () => {
  const f = write("nospot.yaml", "version: 1\ntitle: x\nwish: 箱根\nconstraints:\n  must_visit: [ポーラ美術]\n");
  const r = run("test", f);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^tabisaki: .*nospot\.yaml:5: constraints\.must_visit\[0\]: 「ポーラ美術」が収録にありません（近い名前: ポーラ美術館/m);
});

test("ファイルのまちがいは、1件1行で stderr に出て終了コード 2", () => {
  const f = write("bad.yaml", "version: 1\ntitle: x\nwhish: y\n");
  const r = run("build", f);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  const lines = r.stderr.trim().split("\n");
  assert.ok(lines.length >= 2);
  for (const l of lines) assert.match(l, /^tabisaki: .*bad\.yaml/);
  assert.equal(run("build", path.join(tmp, "nothing.yaml")).status, 2);
  assert.equal(run("build", SAMPLE, "--days=3").status, 2, "条件はファイルに書く");
  assert.equal(run("test").status, 2);
  assert.equal(run("diff", SAMPLE).status, 2);
});

test("diff: 違いがあれば日ごとに出して終了コード 1、同じなら 0", () => {
  const r = run("diff", SAMPLE, QUICK.replace(/\.yaml$/, ""));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /^--- /);
  assert.match(r.stdout, /日数: 2日 → 1日（-1）/);
  const json = run("build", SAMPLE, "--output=json").stdout;
  const jf = write("a.json", json);
  const same = run("diff", SAMPLE, jf);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /違いはありません/);
});

test("diffJourneys: 足した・消した・時刻と日が変わったものを分ける", () => {
  const it = (title, start, end, kind = "spot") => ({ kind, title, start: `2026-11-07T${start}:00+09:00`, end: `2026-11-07T${end}:00+09:00` });
  const a = { title: "A", totalCostYen: 1000, days: [{ n: 1, items: [it("寺", "09:00", "10:00"), it("城", "11:00", "12:00"), it("滝", "13:00", "14:00")] }] };
  const b = { title: "B", totalCostYen: 1500, days: [{ n: 1, items: [it("寺", "09:30", "10:30"), it("湖", "11:00", "12:00")] }, { n: 2, items: [it("滝", "13:00", "14:00")] }] };
  const { same, lines } = diffJourneys(a, b);
  assert.equal(same, false);
  const text = lines.join("\n");
  assert.match(text, /~ 寺: 09:00〜10:00 → 09:30〜10:30/);
  assert.match(text, /- 11:00 城/);
  assert.match(text, /\+ 11:00 湖/);
  assert.match(text, /~ 滝: 1日目 → 2日目/);
  assert.match(text, /費用: 1,000円 → 1,500円（\+500円）/);
});

test("narrate: 4つの文体で書け、知らない文体は終了コード 2", () => {
  for (const style of ["blog", "diary", "guide", "haiku"]) {
    const r = run("narrate", SAMPLE, `--style=${style}`);
    assert.equal(r.status, 0, `${style}: ${r.stderr}`);
    assert.match(r.stdout, /ポーラ美術館|紅葉や/, style);
  }
  assert.match(run("narrate", SAMPLE, "--style=haiku").stdout, /紅葉や/, "11月の季語");
  assert.equal(run("narrate", SAMPLE, "--style=poem").status, 2);
  assert.equal(run("build", SAMPLE, "--style=blog").status, 2);
});

test("同じファイルからは、いつも同じ旅程になる", () => {
  const a = run("build", SAMPLE, "--output=json").stdout;
  const b = run("build", SAMPLE, "--output=json").stdout;
  assert.ok(a.length > 100);
  assert.equal(a, b);
});
