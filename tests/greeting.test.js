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

test("挨拶は Zen Maru Gothic、ロゴと入力案内は同梱の見出し字を使う", async () => {
  const fs = await import("node:fs");
  const css = fs.readFileSync(new URL("../css/app.css", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

  const greetingRule = css.match(/\.hero-greet\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(greetingRule, /font-family:\s*"Zen Maru Gothic",\s*sans-serif\s*;/);
  assert.match(greetingRule, /font-size:\s*32px\s*;/);
  assert.match(greetingRule, /font-weight:\s*400\s*;/);
  assert.match(html, /https:\/\/fonts\.googleapis\.com\/css2\?family=Zen\+Maru\+Gothic:wght@400/);
  assert.match(html, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com;/);
  assert.match(html, /font-src 'self' https:\/\/fonts\.gstatic\.com;/);

  // ロゴと入力案内は同梱フォントの文字セットで表示できることを確認します。
  const ranges = [...css.matchAll(/font-family: "Tabisaki Title";[\s\S]*?unicode-range: ([^;]+);/g)]
    .flatMap((m) => m[1].split(",").map((r) => r.trim().slice(2).split("-").map((h) => parseInt(h, 16))));
  const has = (ch) => ranges.some(([a, b = a]) => ch.codePointAt(0) >= a && ch.codePointAt(0) <= b);
  for (const word of ["どんな旅にしますか？", "旅さき"]) {
    for (const ch of word) assert.ok(has(ch), "同梱の見出し字にありません: " + ch + " (" + word + ")");
  }
});
