// 管理画面は、合言葉を知っている人にだけ見せます。
//
// admin/ には認証がありません。GitHub Pages に置くと、URL を知っている
// 誰でも開けます（実際にそうなっていました）。いまは Worker が
// 合言葉（ADMIN_PASSWORD）を聞いてから配ります（server/admin.js）。
//
// 見るのは3つ。公開サイトに admin/ を入れないこと、合言葉が無ければ
// 開けないこと、合言葉が合えば画面と、画面が読む js/・kb/ が届くこと。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import worker from "../server/worker.js";
import { basicPassword, serveAdmin, SITE_ROOT } from "../server/admin.js";

const root = new URL("../", import.meta.url);
const W = "https://tabisaki-github-io.example.workers.dev";

const basic = (pw, user = "ryo") =>
  `Basic ${Buffer.from(`${user}:${pw}`, "utf8").toString("base64")}`;

const files = {
  async fetch(req) {
    const name = new URL(req.url).pathname.slice(1);
    return new Response(`file:${name}`, { headers: { "Content-Type": "text/plain" } });
  },
};

const env = { ADMIN_PASSWORD: "かぎ-123", ADMIN_FILES: files };
const get = (path, headers = {}) => new Request(`${W}${path}`, { headers });

test("公開サイトの組み立てに、admin/ を入れない", async () => {
  // 何を公開するかは tools/build_site.sh に書いてあります。Cloudflare 用
  // （tools/build_worker.sh）も PHP 版（tools/build_php.sh）も、これを通ります。
  for (const f of ["tools/build_worker.sh", "tools/build_php.sh"]) {
    const by = await readFile(new URL(f, root), "utf8");
    assert.match(by, /tools\/build_site\.sh/, `${f} が tools/build_site.sh を通っていません`);
  }
  const sh = await readFile(new URL("tools/build_site.sh", root), "utf8");
  const copies = sh.split("\n").filter((l) => /^\s*cp\s/.test(l));
  assert.ok(copies.length > 0, "cp の行が見つかりません");
  for (const line of copies) {
    assert.ok(!/\badmin\b/.test(line), `admin を公開に入れています: ${line.trim()}`);
  }
  assert.match(sh, /dist"?\/admin/, "紛れ込んだときに止める確認がありません");
  // PHP 版には管理画面を入れません（合言葉を聞く仕組みが無いため）。
  const php = await readFile(new URL("tools/build_php.sh", root), "utf8");
  assert.ok(!/cp[^\n]*\badmin\//.test(php), "PHP 版に admin/ を入れています");
  // Cloudflare 用は __admin/ に置き、必ず Worker を先に通します。
  const wr = await readFile(new URL("wrangler.jsonc", root), "utf8");
  assert.match(wr, /"run_worker_first":\s*\[[^\]]*"\/__admin\/\*"/, "__admin/ が Worker を通りません");
});

test("Cloudflare の静的ファイルにある管理画面は、合言葉なしでは見えない", async () => {
  const seen = [];
  const ASSETS = {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      return new Response(`asset:${path}`, { headers: { "Content-Type": "text/plain" } });
    },
  };
  const e = { ADMIN_PASSWORD: "かぎ-123", ASSETS };
  const direct = await worker.fetch(get("/__admin/index.html"), e);
  assert.equal(direct.status, 404);
  const locked = await worker.fetch(get("/private/admin/"), e);
  assert.equal(locked.status, 401);
  const ok = await worker.fetch(get("/private/admin/", { Authorization: basic("かぎ-123") }), e);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "asset:/__admin/index.html");
  const js = await worker.fetch(get("/private/js/config.js", { Authorization: basic("かぎ-123") }), e);
  assert.equal(await js.text(), "asset:/js/config.js");
  // サイトのページ（無いファイル）は、静的ファイルの側へ渡します。
  const page = await worker.fetch(get("/nope.html"), e);
  assert.equal(await page.text(), "asset:/nope.html");
});

test("合言葉が入っていなければ、管理画面は無いことにする", async () => {
  const res = await worker.fetch(get("/admin", { Authorization: basic("x") }),
    { ADMIN_FILES: files });
  assert.equal(res.status, 404);
});

test("合言葉なしでは開けない（ブラウザに聞かせる）", async () => {
  const res = await worker.fetch(get("/private/admin/"), env);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate") ?? "", /^Basic /);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("合言葉を間違えたら開けず、回数に数える", async () => {
  let counted = 0;
  const res = await serveAdmin(get("/private/admin/", { Authorization: basic("ちがう") }), env,
    { onBadPassword: async () => { counted++; return { ok: true }; } });
  assert.equal(res.status, 401);
  assert.equal(counted, 1);

  const limited = await serveAdmin(get("/private/admin/", { Authorization: basic("ちがう") }), env,
    { onBadPassword: async () => ({ ok: false, retryAfter: 30 }) });
  assert.equal(limited.status, 429);
});

test("合言葉が合えば、/admin から画面へ案内する", async () => {
  const res = await worker.fetch(get("/admin", { Authorization: basic("かぎ-123") }), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), `${W}/private/admin/`);
});

test("画面のファイルは、Worker に同梱したものを渡す", async () => {
  const auth = { Authorization: basic("かぎ-123", "") };
  const index = await worker.fetch(get("/private/admin/", auth), env);
  assert.equal(index.status, 200);
  assert.equal(await index.text(), "file:index.html");
  assert.equal(index.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const js = await worker.fetch(get("/private/admin/admin.js", auth), env);
  assert.equal(await js.text(), "file:admin.js");
});

test("画面が読む js/・kb/ は公開サイトから取ってくる。それ以外は取りに行かない", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    seen.push(String(url));
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  });
  const auth = { Authorization: basic("かぎ-123") };
  const kb = await worker.fetch(get("/private/kb/index.json", auth), env);
  assert.equal(kb.status, 200);
  const cfg = await worker.fetch(get("/private/js/config.js", auth), env);
  assert.equal(cfg.status, 200);
  assert.deepEqual(seen, [`${SITE_ROOT}kb/index.json`, `${SITE_ROOT}js/config.js`]);

  for (const path of ["/private/server/worker.js", "/private/README.md",
                      "/private/js/%2e%2e/API_KEYS.md"]) {
    const res = await worker.fetch(get(path, auth), env);
    assert.equal(res.status, 404, path);
  }
  assert.equal(seen.length, 2);
});

test("管理画面からの「接続を確かめる」を、中継が断らない", async () => {
  const res = await worker.fetch(new Request(`${W}/status`, {
    method: "OPTIONS", headers: { Origin: W },
  }), {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), W);
});

test("Basic の見出しから合言葉だけを取り出す", () => {
  assert.equal(basicPassword(basic("a:b")), "a:b");
  assert.equal(basicPassword("Bearer x"), null);
  assert.equal(basicPassword(null), null);
});
