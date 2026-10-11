import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("著作権表記でフォントの配布元とライセンスが区別されている", async () => {
  const html = await readFile(new URL("credits.html", root), "utf8");
  const bundledLicense = await readFile(new URL("vendor/fonts/OFL.txt", root), "utf8");

  assert.match(html, /<dt>Zen Maru Gothic（挨拶）<\/dt>/);
  assert.match(html, /Copyright 2021 The Zen Maru Gothic Authors/);
  assert.match(html, /href="https:\/\/github\.com\/googlefonts\/zen-marugothic\/blob\/main\/OFL\.txt"/);
  assert.match(html, /href="https:\/\/fonts\.google\.com\/specimen\/Zen\+Maru\+Gothic"/);
  assert.match(html, /Google Fonts — Zen Maru Gothic/);

  assert.match(html, /<dt>Noto Sans JP（同梱の見出し字）<\/dt>/);
  assert.match(html, /href="https:\/\/fontsource\.org\/fonts\/noto-sans-jp\/about"/);
  assert.match(html, /href="vendor\/fonts\/OFL\.txt"/);
  assert.match(bundledLicense, /SIL OPEN FONT LICENSE Version 1\.1/);

  // 間違った属性や重複した href を見逃さないようにします。
  assert.doesNotMatch(html, /,\s*href=/);
  assert.doesNotMatch(html, /<a\b[^>]*\bhref="[^"]*"[^>]*\bhref="/i);

  // このページは意図的に JavaScript を実行しない静的ページです。
  assert.match(html, /script-src 'none'/);
  assert.doesNotMatch(html, /<script\b/i);
});
