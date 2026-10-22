// 中継（Cloudflare Worker）が、どのページからの呼び出しを許すか。
//
// ここを間違えると、ブラウザには「Load failed」としか出ません。中継は
// ちゃんと断り文句を返しているのに、CORSの見出しが合わないとブラウザが
// 中身を捨てるためです。利用者から見ると、原因の分からない通信失敗に
// なります（実際にそう出ていました）。
//
// 見るのは2つ。許した出どころにはその出どころを返すこと、
// 断るときも中身が読めること。

import assert from "node:assert/strict";
import test from "node:test";

import worker, { cors } from "../server/worker.js";

const A = "https://shitianliang1000-alt.github.io";
const B = "http://localhost:8000";

const acao = (res) => res.headers.get("Access-Control-Allow-Origin");

test("許した出どころには、その出どころを返す", () => {
  const res = cors(new Response("x"), B, [A, B]);
  assert.equal(acao(res), B);
  // 固定の1つを返していたころは、公開先が2つあると片方が必ず失敗しました。
  assert.equal(acao(cors(new Response("x"), A, [A, B])), A);
});

test("ALLOW_ORIGIN は複数書ける", async () => {
  const req = new Request("https://example.com/yahoo/transit", {
    method: "OPTIONS", headers: { Origin: B },
  });
  const res = await worker.fetch(req, { ALLOW_ORIGIN: `${A}, ${B}` });
  assert.equal(res.status, 204);
  assert.equal(acao(res), B);
});

test("断るときも、なぜ断ったかが読める", async () => {
  const req = new Request("https://example.com/yahoo/transit", {
    method: "POST",
    headers: { Origin: "https://example.org", "Content-Type": "application/json" },
    body: "{}",
  });
  const res = await worker.fetch(req, { ALLOW_ORIGIN: A });
  assert.equal(res.status, 403);
  // ここが相手の出どころでないと、ブラウザは中身を捨てます。
  assert.equal(acao(res), "https://example.org");
  const body = await res.json();
  assert.match(body.error.message, /example\.org/);
  assert.match(body.error.message, /ALLOW_ORIGIN/);
});

test("PHP 版の置き場（tabisaki.site.je）は、ALLOW_ORIGIN に書いていなくても通す", async () => {
  for (const origin of ["https://tabisaki.site.je", "http://tabisaki.site.je"]) {
    const res = await worker.fetch(new Request("https://example.com/yahoo/transit", {
      method: "OPTIONS", headers: { Origin: origin },
    }), { ALLOW_ORIGIN: A });
    assert.equal(res.status, 204, origin);
    assert.equal(acao(res), origin);
  }
});
