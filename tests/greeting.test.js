// はじめの画面の挨拶（js/shell.js の greeting）。時刻で変わります。

import test from "node:test";
import assert from "node:assert/strict";
import { greeting } from "../js/shell.js";

const at = (h, m = 0) => new Date(2026, 9, 11, h, m);

test("朝・昼・夜で挨拶が変わる", () => {
  assert.equal(greeting(at(4)), "おはようございます");
  assert.equal(greeting(at(9, 59)), "おはようございます");
  assert.equal(greeting(at(10)), "こんにちは");
  assert.equal(greeting(at(16, 59)), "こんにちは");
  assert.equal(greeting(at(17)), "こんばんは");
  assert.equal(greeting(at(23)), "こんばんは");
  assert.equal(greeting(at(2)), "こんばんは");
});

test("挨拶の字は、配っている見出しの字に入っている", async () => {
  // css/app.css の @font-face（見出しの字）が持つのは一部の字だけです。
  // 挨拶を変えたら、字が入っているかをここで確かめます。
  const fs = await import("node:fs");
  const css = fs.readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  const ranges = [...css.matchAll(/font-family: "Tabisaki Title";[\s\S]*?unicode-range: ([^;]+);/g)]
    .flatMap((m) => m[1].split(",").map((r) => r.trim().slice(2).split("-").map((h) => parseInt(h, 16))));
  const has = (ch) => ranges.some(([a, b = a]) => ch.codePointAt(0) >= a && ch.codePointAt(0) <= b);
  for (const word of ["おはようございます", "こんにちは", "こんばんは", "どんな旅にしますか？", "旅さき"]) {
    for (const ch of word) assert.ok(has(ch), `「${ch}」（${word}）が見出しの字にありません`);
  }
});
