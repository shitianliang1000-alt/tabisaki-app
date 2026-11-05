// 見た目の仕上げ（php/assets/tour-polish.css）が、
// 公開の組み立てに入っているか・CSP をゆるめていないかを見ます。
//
// 2026-11-05: tour.html の見た目を直すとき、CSS を足したのに
// tour.html が読んでいない（または CSP の style-src で止まる）と、
// 画面は何も変わりません。気づけるようにここで見ます。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('tour.html は tour.css の後に tour-polish.css を読む', async () => {
  const html = await read('tour.html');
  const base = html.indexOf('assets/tour.css');
  const polish = html.indexOf('assets/tour-polish.css');
  assert.ok(base > -1, 'tour.css を読んでいません');
  assert.ok(polish > -1, 'assets/tour-polish.css を読んでいません');
  assert.ok(polish > base, 'tour-polish.css は tour.css より後で読む必要があります（上書きする層なので）');
});

test('仕上げの CSS は外を指していない（CSP の style-src self で止まらない）', async () => {
  const css = await read('php/assets/tour-polish.css');
  assert.equal(/@import/.test(css), false, '@import は使いません');
  assert.equal(/url\(\s*['"]?(?:https?:)?\/\//.test(css), false, '外部の url() は使いません（同じ場所に置いて配ります）');
  assert.equal(/expression\s*\(/.test(css), false, 'expression() は使いません');
});

test('tour.html の CSP をゆるめていない', async () => {
  const html = await read('tour.html');
  const m = html.match(/Content-Security-Policy"\s+content="([^"]*)"/);
  assert.ok(m, 'CSP の meta がありません');
  assert.equal(/unsafe-inline/.test(m[1]), false, 'unsafe-inline は足さないでください（style-src は self のまま）');
  assert.ok(/style-src 'self'/.test(m[1]), 'style-src は self のままにしてください');
  assert.ok(/script-src 'self'/.test(m[1]), 'script-src は self のままにしてください');
});
