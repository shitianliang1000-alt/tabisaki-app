// 複数ページのサイト: トップは tour.html、公開物に新しいページが入る、写真は出典つきの高画質だけ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("公開物に、SSH・アプリ・API・観光地のページが入る", async () => {
  const sh = await read("tools/build_site.sh");
  for (const f of ["ssh.html", "mobile.html", "api.html", "tour.html"]) assert.ok(sh.includes(f), f);
  assert.match(sh, /cp -r css js kb vendor spots /);
});

test("トップ（/）は Worker も PHP も tour.html を出す", async () => {
  assert.match(await read("server/worker.js"), /url\.pathname === "\/" && !url\.searchParams\.has\("p"\)/);
  assert.match(await read("php/index.php"), /tour\.html/);
});

test("件数は「4万」ではなく 40,000 と書く", async () => {
  const tour = await read("tour.html");
  assert.ok(!tour.includes("4万"));
  assert.ok(tour.includes("40,000"));
  assert.ok(!tour.includes("立ち寄る順に番号をふって"));
});

test("写真は、著者と許諾が付いた幅1200px以上のものだけ", async () => {
  const photos = JSON.parse(await read("data/photos.json"));
  const all = Object.entries(photos);
  assert.ok(all.length >= 40);
  for (const [slug, p] of all) {
    assert.ok(p.width >= 1200, `${slug} の幅`);
    assert.ok(p.author && p.license, `${slug} の出典`);
    assert.ok(!/-NC|-ND/i.test(p.license), `${slug} の許諾`);
    assert.ok(!/[<>]/.test(p.author), `${slug} の著者に HTML`);
  }
});
