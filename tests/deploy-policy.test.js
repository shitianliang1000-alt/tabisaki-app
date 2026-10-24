// 公開のしかたの約束。
//   ・公開先は Cloudflare Worker と PHP 版だけ（GitHub Pages の流れは置かない）
//   ・試験が落ちたら上げない（Workers Builds も ./tabisaki deploy も）
//   ・PHP 版のキャッシュは種類ごと（画面と部品は毎回確かめ、版の付いた部品だけ長く持つ）

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (f) => readFile(new URL(f, root), "utf8");

test("GitHub Pages へ公開する流れは無い", async () => {
  const flows = await readdir(new URL(".github/workflows/", root));
  for (const f of flows) {
    const y = await read(`.github/workflows/${f}`);
    assert.doesNotMatch(y, /actions\/deploy-pages|actions\/upload-pages-artifact/, f);
  }
});

test("Workers Builds では、組み立ての前に試験を通す", async () => {
  const sh = await read("tools/build_worker.sh");
  const gate = sh.indexOf('node --test tests/*.test.js');
  assert.ok(gate > 0, "tools/build_worker.sh に試験がありません");
  assert.match(sh, /WORKERS_CI/);
  assert.ok(gate < sh.indexOf("tools/build_site.sh \"$out\""), "試験が組み立てより後です");
});

test("./tabisaki deploy は、先に試験を通す", async () => {
  const cli = await read("tabisaki");
  const deploy = cli.slice(cli.indexOf("  deploy)"));
  assert.ok(deploy.indexOf("node --test") < deploy.indexOf("wrangler"));
  assert.ok(deploy.indexOf("node --test") < deploy.indexOf("ftp_upload"));
});

test("PHP 版: 画面と部品は毎回確かめ、版の付いたトップの部品だけ長く持つ", async () => {
  const ht = await read("php/.htaccess");
  const noCache = /<FilesMatch "([^"]+)">\s*Header set Cache-Control "no-cache"/.exec(ht);
  assert.ok(noCache, "no-cache の決まりがありません");
  const re = new RegExp(noCache[1]);
  for (const f of ["app.php", "index.php", "sw.js", "app.js", "app.css", "manifest.webmanifest", "areas.json"]) {
    assert.ok(re.test(f), `${f} が毎回確かめる側に入っていません`);
  }
  for (const f of ["icon.svg", "og.png", "noto-sans-jp-109-500-normal.woff2"]) {
    assert.ok(!re.test(f), `${f} まで毎回確かめています`);
  }
  assert.match(ht, /<FilesMatch "\^landing\\\.\(css\|js\)\$">\s*Header set Cache-Control "public, max-age=31536000, immutable"/);
  // 長く持つのは ?v= を付けて読むときだけ成り立ちます。
  const tpl = await read("php/inc/landing.html");
  assert.match(tpl, /assets\/landing\.css\?v=\{\{build\}\}/);
  assert.match(tpl, /assets\/landing\.js\?v=\{\{build\}\}/);
});
