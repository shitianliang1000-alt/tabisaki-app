// 圏外で初めて開いたときに、画面が出るか。
//
// このアプリがいちばん役に立つのは旅行の当日で、その日は電波の弱い
// 場所にいます。service worker が先にファイルを入れておくのは、
// そのためです。
//
// ところが、先に入れるものは**手で並べていました**。数えてみると
//
//   app.js が import で辿るもの   72件
//   sw.js に並んでいたもの        13件
//
// で、残る45件は「初回に読んだものが、あとから自然に入る」に
// 任されていました。それが成り立つのは、一度でも圏内で使ったときだけ
// です。ホーム画面に追加して翌朝そのまま山へ行くと、import が1つ
// 解けずに真っ白な画面になります。
//
// 手で並べる形は**黙って腐ります**。新しいモジュールを足した人が
// sw.js を直し忘れても、圏内では何も起きないので気づけません。
// だから、ここで突き合わせます。

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");
const sw = read("sw.js");

/** sw.js が先に入れると言っているファイル。 */
const listed = [...sw.matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1]);

test("js/ のモジュールが、1つ残らず並んでいる", () => {
  const actual = fs.readdirSync(new URL("js/", root))
    .filter((f) => f.endsWith(".js")).sort();
  const inSw = listed.filter((f) => f.startsWith("js/"))
    .map((f) => f.slice(3));
  const missing = actual.filter((f) => !inSw.includes(f));
  assert.deepEqual(missing, [],
    `sw.js に無いモジュール（圏外で初めて開くと真っ白になります）: ${missing.join(" ")}`);
  // 消したファイルが残っていると、install のたびに404を引きます。
  const gone = inSw.filter((f) => !actual.includes(f));
  assert.deepEqual(gone, [], `もう無いものが並んでいます: ${gone.join(" ")}`);
});

test("app.js が静的に読むものは、ぜんぶ入っている", () => {
  // import の輪を実際に辿ります。並びの数を数えるだけでは、
  // 「73件あるから大丈夫」で見落とします。
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(`js/${file}`);
    for (const m of src.matchAll(/^import[^;]*?from "\.\/([\w-]+\.js)"/gm)) {
      walk(m[1]);
    }
  };
  walk("app.js");
  const inSw = new Set(listed.filter((f) => f.startsWith("js/"))
    .map((f) => f.slice(3)));
  const missing = [...seen].filter((f) => !inSw.has(f));
  assert.deepEqual(missing, [],
    `起動に要るのに入っていません: ${missing.join(" ")}`);
  // 辿れていること自体も見ます（正規表現が空振りしたら、この試験は
  // 何も確かめないまま通ります）。
  assert.ok(seen.size > 50, `辿れたのが ${seen.size} 件しかありません`);
});

test("画面と見た目も、先に入っている", () => {
  for (const f of ["index.html", "css/hig-tokens.css", "css/hig.css",
                   "css/app.css", "manifest.webmanifest"]) {
    assert.ok(listed.includes(f), `${f} が入っていません`);
  }
  // 入口そのもの（"./"）も。ホーム画面から開くとここに来ます。
  assert.match(sw, /"\.\/",/);
  // チャットの画面の正式なアドレスと、ホーム画面のアプリの入口。
  assert.ok(listed.includes("app"), "./app が入っていません");
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.start_url, "./app",
    "ホーム画面から開く先は、チャットの画面（/app）にします");
});

test("並べたものは、ぜんぶ実在する", () => {
  for (const f of listed) {
    // "app" はファイルではなく、Worker・PHP 版が返す画面です。
    if (f === "" || f === "app") continue;
    assert.ok(fs.existsSync(new URL(f, root)), `${f} がありません`);
  }
});

test("版を上げ忘れていない", () => {
  // 上げないと、前の版の殻を持っている端末は入れ直しません。
  // 中身を増やしても、増えたぶんは端末に入りません。
  const m = /const VERSION = "tabisaki-v(\d+)"/.exec(sw);
  assert.ok(m, "VERSION が読めません");
  assert.ok(Number(m[1]) >= 5, `版が ${m[1]} のままです`);
});

test("1件の取りこぼしで、全部が無駄にならない", () => {
  // Promise.all だと、1つ404を引いただけで install がまるごと失敗し、
  // **何も入りません**。allSettled であること。
  assert.match(sw, /allSettled/);
  assert.ok(!/await Promise\.all\(SHELL_FILES/.test(sw));
});
