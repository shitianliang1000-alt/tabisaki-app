// 学習したモデルの合否（training/eval_gate.mjs、Issue #434）。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { gate, report } from "../training/eval_gate.mjs";

const baseline = JSON.parse(await readFile(new URL("../training/baseline.json", import.meta.url), "utf8"));
const good = { n: 59, errors: 0, "fact.prefecture": 0.98, "fact.grounded": 0.95, "unknown.refused": 0.9, "list.known": 0.85 };

test("下限を上回り、学習前より下がっていなければ合格", () => {
  const r = gate(good, { baseline, before: { ...good, "fact.grounded": 0.96 } });
  assert.equal(r.pass, true, r.fails.join());
  assert.match(report(r), /合格（59問）/);
});

test("下限を下回る点があれば不合格", () => {
  const r = gate({ ...good, "unknown.refused": 0.5 }, { baseline });
  assert.equal(r.pass, false);
  assert.match(r.fails[0], /unknown\.refused/);
  assert.match(report(r), /×/);
});

test("学習前から tolerance を超えて下がれば、下限より上でも不合格", () => {
  const r = gate({ ...good, "fact.prefecture": 0.93 }, { baseline, before: good });
  assert.equal(r.pass, false);
  assert.match(r.fails.join(), /学習前/);
  // 幅の中なら合格
  assert.equal(gate({ ...good, "fact.prefecture": 0.97 }, { baseline, before: good }).pass, true);
});

test("失敗が多い・数が少ないときは不合格、null の点は飛ばす", () => {
  assert.equal(gate({ ...good, errors: 10 }, { baseline }).pass, false);
  assert.equal(gate({ ...good, n: 10 }, { baseline }).pass, false);
  assert.equal(gate({ ...good, "list.known": null }, { baseline }).pass, true);
});
