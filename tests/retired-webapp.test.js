// 2026-11-24: ブラウザで使う Web 版をやめ、サイトは旅さき（端末版・アプリ版）の紹介ページだけにしました。
//
//   ・Worker: /app・/app/・/index.html・/landing・/?p=… はトップへ 301（旧リンク・ホーム画面に置いた人）
//   ・Worker: トップ（/）は tour.html。中継（POST）はそのまま
//   ・エリアのページ（WEBAPP=0 で組んだとき）に /app へのリンクが無い
//   ・公開サイトの sw.js は、前の Web 版の Service Worker を外すだけのもの

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";

import worker, { isRetiredWebApp } from "../server/worker.js";

const W = "https://tabisaki.example.workers.dev";
const ASSETS = {
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/tour") return new Response("<title>旅さき</title>", { headers: { "Content-Type": "text/html" } });
    return new Response(null, { status: 404 });
  },
};

test("Web 版の入口は、トップへ移す", async () => {
  for (const path of ["/app", "/app/", "/app?q=%E6%B8%A9%E6%B3%89&go=1", "/index.html", "/landing", "/?p=abc"]) {
    const res = await worker.fetch(new Request(`${W}${path}`), { ASSETS }, {});
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get("Location"), `${W}/`, path);
  }
});

test("トップ（/）は紹介ページ（tour.html）を出す", async () => {
  const res = await worker.fetch(new Request(`${W}/`), { ASSETS }, {});
  assert.equal(res.status, 200);
  assert.match(await res.text(), /旅さき/);
});

test("やめた入口の見分け", () => {
  assert.equal(isRetiredWebApp(new URL(`${W}/app`)), true);
  assert.equal(isRetiredWebApp(new URL(`${W}/?p=x`)), true);
  assert.equal(isRetiredWebApp(new URL(`${W}/`)), false);
  assert.equal(isRetiredWebApp(new URL(`${W}/apps.html`)), false);
  assert.equal(isRetiredWebApp(new URL(`${W}/spots/index.html`)), false);
});

test("WEBAPP=0 のエリアのページ・紹介・404 には、Web 版へのリンクが無い", () => {
  const code = `
    const m = await import("./tools/build_area_pages.mjs");
    const base = "https://x.example/";
    const pref = m.renderPrefPage({ prefName: "長野県", prefSlug: "nagano", spots: [], regions: [], base });
    const nf = m.renderNotFoundPage({ prefs: [], base });
    console.log(JSON.stringify({ webapp: m.WEBAPP, html: pref.html + nf.html }));`;
  const run = (env) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code],
    { cwd: new URL("..", import.meta.url), env: { ...process.env, ...env }, encoding: "utf8" }));
  const off = run({ WEBAPP: "0" });
  assert.equal(off.webapp, false);
  assert.doesNotMatch(off.html, /href="[^"]*app[?"]/);
  assert.match(off.html, /#get"/);
  // アプリ版の中身（既定）は今までどおり
  const on = run({ WEBAPP: "1" });
  assert.equal(on.webapp, true);
  assert.match(on.html, /href="[^"]*app\?q=/);
});

test("公開サイトの sw.js は、前の Service Worker を外して保存を消すだけ", async () => {
  const sh = execFileSync("sh", ["-c", "sed -n '/cat <<.SW./,/^SW$/p' tools/build_site.sh"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.match(sh, /registration\.unregister\(\)/);
  assert.match(sh, /caches\.delete/);
  assert.doesNotMatch(sh, /addEventListener\("fetch"/);
});
