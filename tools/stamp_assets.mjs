#!/usr/bin/env node
// 旅さき — ページが読む CSS・JS に、中身から作った版（?v=…）を付け直します。
//
//     node tools/stamp_assets.mjs
//
// なぜ要るか: _headers が /assets/* を「1年持ってよい（immutable）」と返します。
// 中身を直しても URL が同じままだと、ブラウザは古いほうを使い続けます。
// 中身の SHA-1 の先頭8文字を ?v= に付けておけば、直したときに URL が変わります。
//
// 対象: tour.html・ssh.html・mobile.html・api.html と、spots/*.html（あれば）。
// 元になるファイル: php/assets/（サイトの CSS・JS はここに置いています）。
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const assetsDir = join(root, 'php/assets');
const hash = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 8);

const versions = {};
for (const f of await readdir(assetsDir)) {
  if (!/\.(css|js)$/.test(f)) continue;
  versions[f] = hash(await readFile(join(assetsDir, f)));
}

const pages = ['tour.html', 'ssh.html', 'mobile.html', 'api.html']
  .filter((f) => existsSync(join(root, f)));
if (existsSync(join(root, 'spots'))) {
  for (const f of await readdir(join(root, 'spots'))) if (f.endsWith('.html')) pages.push(`spots/${f}`);
}

let touched = 0;
for (const rel of pages) {
  const path = join(root, rel);
  const before = await readFile(path, 'utf8');
  let after = before.replace(/((?:\.\.\/)?assets\/)([\w.-]+\.(?:css|js))(\?v=[0-9a-f]+)?/g, (m, dir, name) =>
    versions[name] ? `${dir}${name}?v=${versions[name]}` : m);
  if (after !== before) { await writeFile(path, after, 'utf8'); touched++; }
}
console.log(`版を付け直しました（${touched} 枚 / 部品 ${Object.keys(versions).length} 本）`);
for (const [k, v] of Object.entries(versions)) console.log(`  ${k} → ${v}`);
