// 画面のCSPに、中継の入口が入っているか。
//
// ここが抜けていると、ブラウザは中継への通信を**黙って**止めます。
// アプリから見えるのは「Load failed」だけで、中継は何も受け取っていません。
// 実際にそうなっていました。原因は `;` の位置です。
//
//     https://ja.wikipedia.org;                     ← ここで connect-src が終わる
//     https://…workers.dev                          ← 別の指示の名前として捨てられる
//     base-uri 'none';
//
// 見た目には並んで書いてあるので、読んでも気づけません。
// packages/core/src/config.js の PROXY_URL と突き合わせて、機械に見張らせます。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { PROXY_URL } from "../packages/core/src/config.js";

const root = new URL("../", import.meta.url);

async function connectSrc(file) {
  const html = await readFile(new URL(file, root), "utf8");
  const csp = html.match(
    /<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*content=["']([\s\S]*?)["']\s*>/i)?.[1];
  assert.ok(csp, `${file} に CSP がありません`);
  const directive = csp.split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .find((d) => d.startsWith("connect-src"));
  assert.ok(directive, `${file} に connect-src がありません`);
  return directive.split(" ").slice(1);
}

for (const file of ["index.html", "admin/index.html"]) {
  test(`${file} のCSPが、中継の入口を通す`, async () => {
    if (!PROXY_URL) return;               // 中継を使わない設定なら見ません
    const sources = await connectSrc(file);
    const origin = new URL(PROXY_URL).origin;
    assert.ok(sources.includes(origin),
      `connect-src に ${origin} がありません（${sources.join(" ")}）`);
  });
}

// 天気の入口。
//
// 予報（api.open-meteo.com）と過去の観測（archive-api.open-meteo.com）は
// **別のホスト**です。片方しか書いていないと、もう片方はブラウザが
// 黙って止めます。アプリから見えるのは「取得できませんでした」だけで、
// 相手には1件も届きません。js/ が実際に呼んでいる先と突き合わせます。
test("天気を聞く先が、ぜんぶ通してある", async () => {
  const sources = await connectSrc("index.html");
  const js = ["packages/core/src/weather.js", "packages/core/src/normals.js"];
  const hosts = new Set();
  for (const f of js) {
    const src = await readFile(new URL(f, root), "utf8");
    for (const m of src.matchAll(/https:\/\/[a-z0-9.-]+/g)) {
      hosts.add(new URL(m[0]).origin);
    }
  }
  assert.ok(hosts.size >= 2, `呼び先が ${hosts.size} 件しか拾えませんでした`);
  for (const h of hosts) {
    assert.ok(sources.includes(h),
      `connect-src に ${h} がありません（${sources.join(" ")}）`);
  }
});

test("connect-src の途中で、指示が切れていない", async () => {
  const sources = await connectSrc("index.html");
  for (const s of sources) {
    assert.ok(s === "'self'" || /^https:\/\//.test(s),
      `connect-src に紛れ込んでいます: ${s}`);
  }
  // `;` が早すぎると、後ろの行が別の指示として捨てられます。
  // 出どころの数で、その取りこぼしに気づけます。
  assert.ok(sources.length >= 5, `出どころが ${sources.length} 件しかありません`);
});
