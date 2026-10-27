// 旅程を組む部分（packages/core/src/）と、画面（js/）の境目の試験（#348）。
//
// packages/core/src/ は Web・CLI・TUI・API が同じものを使います。
// ここが画面の部品を読みはじめると、Node.js からは動かなくなります。
// 黙って崩れないよう、次のことを毎回確かめます。
//
//   ・src/ の中は、src/ の中だけを読む（js/ を読まない）
//   ・画面（js/）は、src/ を ../packages/core/src/ から読む
//   ・src/ のモジュールは、画面の無い Node.js でそのまま読み込める
//   ・アプリの一番上（kb/ がある場所）を、まとめる前でも後でも正しく指す

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url);
const SRC = new URL("packages/core/src/", root);
const JS = new URL("js/", root);
const list = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
const specifiers = (src) => [
  ...src.matchAll(/(?:^|[\s;])(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g),
  ...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
].map((m) => m[1]);

test("src/ の中は、src/ の中だけを読む", () => {
  const files = list(SRC);
  assert.ok(files.length > 50, `src/ が ${files.length} 件しかありません`);
  for (const f of files) {
    for (const s of specifiers(fs.readFileSync(new URL(f, SRC), "utf8"))) {
      assert.match(s, /^\.\/[\w-]+\.js$/, `${f} が src/ の外を読んでいます: ${s}`);
      assert.ok(files.includes(s.slice(2)), `${f} が読む ${s} がありません`);
    }
  }
});

test("画面（js/）は、src/ を ../packages/core/src/ から読む", () => {
  const core = new Set(list(SRC));
  const ui = new Set(list(JS));
  let viaCore = 0;
  for (const f of ui) {
    for (const s of specifiers(fs.readFileSync(new URL(f, JS), "utf8"))) {
      const m = /^\.\.\/packages\/core\/src\/([\w-]+\.js)$/.exec(s);
      if (m) {
        assert.ok(core.has(m[1]), `${f} が読む ${s} がありません`);
        viaCore++;
        continue;
      }
      assert.match(s, /^\.\/[\w-]+\.js$/, `${f} の読みかたが変わっています: ${s}`);
      assert.ok(ui.has(s.slice(2)), `${f} が読む ${s} が js/ にありません（src/ に移したなら道を直してください）`);
    }
  }
  assert.ok(viaCore > 10, "画面が src/ を読んでいません");
  // 同じ名前が両方にあると、どちらを直せばよいか分からなくなります。
  const both = [...ui].filter((f) => core.has(f));
  assert.deepEqual(both, [], `js/ と src/ の両方にあります: ${both.join(" ")}`);
});

test("src/ のモジュールは、画面の無い Node.js でそのまま読み込める", async () => {
  assert.equal(typeof globalThis.document, "undefined");
  for (const f of list(SRC)) {
    // 別のスレッドの入口（self.onmessage を置くだけ）は、ここでは読みません。
    if (f === "stops-worker.js") continue;
    await import(pathToFileURL(new URL(f, SRC).pathname).href);
  }
});

test("アプリの一番上を、まとめる前でも後でも正しく指す", async () => {
  const { APP_ROOT, appUrl } = await import("../packages/core/src/root.js");
  assert.equal(APP_ROOT.href, root.href);
  assert.equal(appUrl("kb/index.json"), new URL("kb/index.json", root).href);
  // まとめたあと（js/chunk-*.js の中）は、1段上が一番上です。
  const src = fs.readFileSync(new URL("root.js", SRC), "utf8");
  const bundled = new Function("importMetaUrl",
    src.replace(/^export /gm, "").replace(/import\.meta\.url/g, "importMetaUrl") + "\nreturn APP_ROOT.href;");
  assert.equal(bundled("https://example.test/js/chunk-ABC.js"), "https://example.test/");
  assert.equal(bundled("https://example.test/packages/core/src/root.js"), "https://example.test/");
});

test("公開するときに、src/ も入れる", () => {
  const site = fs.readFileSync(new URL("tools/build_site.sh", root), "utf8");
  assert.match(site, /cp -r packages\/core\/src /);
  const opt = fs.readFileSync(new URL("tools/optimize_site.mjs", root), "utf8");
  assert.match(opt, /"packages\/core\/src"/, "src/ の注釈を削っていません");
});
