#!/usr/bin/env node
// 旅さき — 観光地の写真を、Wikipedia / Wikimedia Commons から取ってきます。
//
//     node tools/fetch_spot_photos.mjs              # 取ってくる（ダウンロードはしない）
//     node tools/fetch_spot_photos.mjs --download    # photos/ にも落とす
//     node tools/fetch_spot_photos.mjs --slug=sensoji
//
// 作るもの: data/photos.json
//   { "<slug>": { "url": …, "local": …, "file": …, "author": …, "license": …, "page": … } }
//
// **この道具は通信します。** ふだんのビルド（tools/build_spot_pages.mjs）は通信しません。
// 一度これを走らせて data/photos.json を作れば、あとは pages を作るたびに同じ写真を使います。
// 写真が無い場所は、地名の1字目を置いた下地で出ます（ページは壊れません）。
//
// 出典と許諾は、写真のページ（Commons の File:）から extmetadata を読んで書きます。
// 表示側（spots/*.html）は、この author と license をそのまま並べます。
// ライセンスが CC0 / パブリックドメインでないものは、著者名と許諾の表示が要ります。
// **消さずに、そのまま出してください。**

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPOTS } from '../data/spots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = new Set(process.argv.slice(2));
const download = args.has('--download');
const only = [...args].find((a) => a.startsWith('--slug='))?.slice(7);

const UA = 'tabisaki-site/1.0 (https://tabisaki-github-io.shitianliang1000.workers.dev/; photo credits)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** 1つの記事から、代表画像（記事の infobox の絵）を引きます。 */
async function pageImage(title) {
  const u = new URL('https://ja.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', redirects: '1',
    prop: 'pageimages', piprop: 'thumbnail|name', pithumbsize: '1280', titles: title,
  });
  const d = await json(u);
  const page = d?.query?.pages?.[0];
  if (!page || page.missing) return null;
  const src = page.thumbnail?.source?.split('?')[0]; // 計測用の ?utm_… は落とします
  const name = page.pageimage; // File: を外した名前
  if (!src || !name) return null;
  return { src, name };
}

/** その画像の著者・許諾・説明のページを、Commons の extmetadata から読みます。 */
async function credit(fileName) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2',
    prop: 'imageinfo', iiprop: 'extmetadata|url',
    titles: `File:${fileName}`,
  });
  try {
    const d = await json(u);
    const info = d?.query?.pages?.[0]?.imageinfo?.[0];
    const m = info?.extmetadata ?? {};
    const strip = (s) => String(s ?? '').replace(/[<>]/g, '').replace(/&amp;/g, '&').trim();
    return {
      author: strip(m.Artist?.value) || '',
      license: strip(m.LicenseShortName?.value) || '',
      licenseUrl: strip(m.LicenseUrl?.value) || '',
      page: info?.descriptionurl || `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`,
    };
  } catch {
    return { author: '', license: '', licenseUrl: '', page: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}` };
  }
}

const path = join(root, 'data/photos.json');
let out = {};
if (existsSync(path)) {
  try { out = JSON.parse(await readFile(path, 'utf8')); } catch { out = {}; }
}

const targets = SPOTS.filter((s) => !only || s.slug === only);
let got = 0, miss = 0;

for (const spot of targets) {
  try {
    const img = await pageImage(spot.title);
    if (!img) { console.warn(`× ${spot.slug}: 記事「${spot.title}」に代表画像がありません`); miss++; await sleep(120); continue; }
    const c = await credit(img.name);
    let local = '';
    if (download) {
      const ext = (img.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      local = `${spot.slug}.${ext}`;
      const dir = join(root, 'photos');
      await mkdir(dir, { recursive: true });
      const res = await fetch(img.src, { headers: { 'User-Agent': UA } });
      if (res.ok) await writeFile(join(dir, local), Buffer.from(await res.arrayBuffer()));
      else { console.warn(`  （落とせませんでした: ${res.status}）`); local = ''; }
    }
    out[spot.slug] = { url: img.src, local, file: img.name, author: c.author, license: c.license, licenseUrl: c.licenseUrl, page: c.page };
    got++;
    console.log(`○ ${spot.slug}: ${img.name}（${c.license || '許諾不明'}）`);
  } catch (e) {
    console.warn(`× ${spot.slug}: ${e.message}`);
    miss++;
  }
  await sleep(250); // 先方にやさしく
}

await writeFile(path, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`\ndata/photos.json に ${Object.keys(out).length} 件（今回 ${got} 件・取れず ${miss} 件）`);
if (miss) console.log('写真が無い場所は、地名の1字目を置いた下地で出ます。');
if (!download) console.log('写真も手元に置くなら --download を付けてください（photos/ に落ちます）。');
