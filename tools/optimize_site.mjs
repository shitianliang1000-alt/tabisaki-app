// 公開する前に、ページを速く開けるように整える道具。
//
// 中身（何をするか）は変えません。届けかただけを変えます。
//
// js/ と css/ の注釈と空白を削ります（esbuild の minify）。
// このリポジトリの注釈は日本語で、1字が3バイトあります。数えると
// js/ は gzip しても 537KB あり、削ると 254KB になりました（css/ は
// 50KB → 21KB）。手元のファイルはそのまま（注釈は読む人のための
// ものです）で、公開する dist/ の中だけを削ります。
//
// 試してやめたこと: 起動に要るモジュールを index.html に先に並べる
// （modulepreload）。app.js → ui.js → … と、読んでみるまで次が分からない
// 鎖を短くするためでしたが、Lighthouse で測ると、61件を先に取りに行くぶん
// 見た目の CSS と回線を取り合い、最初に字が出るまでが 1.3秒 → 3.0秒に
// 延びました（深い段の22件だけでも 1.4秒 → 2.0秒）。鎖を待つのは、画面が
// 出たあとの部品の読み込みです。最初の表示を遅らせてまで縮める理由は
// ありません。
//
// 使いかた（tools/build_site.sh が呼びます）:
//
//     node tools/optimize_site.mjs dist
//
// esbuild が入っていないときは、削らずに先へ進みます（公開が
// 止まるよりは、削らずに出すほうがましです）。CI では
// REQUIRE_MINIFY=1 を付けて、飛ばしたら失敗にします。

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function minifyDir(esbuild, dir, ext, loader) {
  let before = 0;
  let after = 0;
  const names = (await readdir(dir)).filter((n) => n.endsWith(ext));
  for (const name of names) {
    const path = join(dir, name);
    const src = await readFile(path, "utf8");
    const { code } = await esbuild.transform(src, {
      loader,
      minify: true,
      // 既定のままだと日本語を \uXXXX に書き換え、かえって大きくなります。
      charset: "utf8",
      // 構文はそのまま（古いブラウザ向けの書き換えはしません）。
      target: "esnext",
      legalComments: "none",
    });
    before += Buffer.byteLength(src);
    after += Buffer.byteLength(code);
    await writeFile(path, code);
  }
  return { files: names.length, before, after };
}

// 起動に要る js/ を、数個のファイルにまとめます（js/app.js と js/chunk-*.js）。
//
// 手元の js/ は 95 ファイルで、起動のとき app.js から import を辿って
// 80 本ほどを、深さ数段の鎖で取りに行きます。回線が遅い・同時の接続を絞る
// 無料のサーバー（InfinityFree など）では、その1本が落ちる・遅れるだけで
// モジュール全体が読めず、「画面の部品を読み込めませんでした」になります。
// まとめれば、起動に要る取得は 2〜3 本です。
//
// 元の js/*.js は消しません（管理画面 admin/ と stops-worker.js が個別に
// 読みます）。使わないぶんは、ブラウザが取りに来ないだけです。
// 動的 import（旅程を組む部分など）は、esbuild が別の chunk に分けます。
async function bundleApp(esbuild, dist) {
  const outdir = join(dist, "js");
  // 前の chunk が残っていたら消します（毎回名前が変わるので）。
  for (const n of await readdir(outdir)) {
    if (/^chunk-.*\.js$/.test(n)) await rm(join(outdir, n));
  }
  await esbuild.build({
    entryPoints: [join(outdir, "app.js")],
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    minify: true,
    charset: "utf8",
    target: "esnext",
    legalComments: "none",
    allowOverwrite: true,
    logLevel: "warning",
  });
  const chunks = (await readdir(outdir)).filter((n) => /^chunk-.*\.js$/.test(n)).sort();
  // 先に入れるファイル（sw.js）にも足します。
  const swPath = join(dist, "sw.js");
  const sw = await readFile(swPath, "utf8");
  const marker = '  "./packages/core/src/access.js",\n';
  if (!sw.includes(marker)) throw new Error("sw.js に packages/core/src/access.js の行が見つかりません");
  await writeFile(swPath, sw.replace(marker, chunks.map((n) => `  "./js/${n}",\n`).join("") + marker));
  console.log(`bundle js/app.js: ${chunks.length} chunks`);
}

async function main() {
  const dist = process.argv[2];
  if (!dist) {
    console.error("usage: node tools/optimize_site.mjs <dist>");
    process.exit(2);
  }

  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch {
    const msg = "esbuild が見つからないので、js/ と css/ は削らずに出します";
    if (process.env.REQUIRE_MINIFY) {
      console.error(msg);
      process.exit(1);
    }
    console.log(`::warning::${msg}`);
    return;
  }
  for (const [sub, ext, loader] of [["js", ".js", "js"], ["packages/core/src", ".js", "js"], ["css", ".css", "css"]]) {
    const r = await minifyDir(esbuild, join(dist, sub), ext, loader);
    const kb = (n) => `${Math.round(n / 1024)}KB`;
    console.log(`minify ${sub}/: ${r.files} files, ${kb(r.before)} -> ${kb(r.after)}`);
  }
  await bundleApp(esbuild, dist);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
