// 映像で見るページ（tour.html）。
//
// assets/ は公開先で1年持たれます（_headers の immutable）。tour.html は静的なページで、
// トップのように開くたびに版を入れられないので、?v= に中身の指紋を手で書いています。
// 中身を変えて ?v= を直し忘れると、古い CSS・JS が残るので、ここで突き合わせます。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root));
const html = read("tour.html").toString();

test("tour.html の ?v= が、CSS と JS の中身と合っている", () => {
  for (const f of ["tour.css", "tour.js"]) {
    const want = createHash("sha1").update(read(`php/assets/${f}`)).digest("hex").slice(0, 8);
    assert.match(html, new RegExp(`assets/${f.replace(".", "\\.")}\\?v=${want}"`),
      `assets/${f} の ?v= を ${want} にしてください`);
  }
});

test("tour.html が読む絵と動画が、ぜんぶある", () => {
  const refs = [...html.matchAll(/\s(?:src|poster|href)="(assets\/[^"?]+)/g)].map((m) => m[1]);
  // 札で切り替える動画（data-src に拡張子なしで書いてあります）
  for (const m of html.matchAll(/data-src="(assets\/[^"]+)"/g)) refs.push(`${m[1]}.mp4`, `${m[1]}.webp`);
  assert.ok(refs.length > 15);
  for (const r of refs) assert.ok(fs.existsSync(new URL(`php/${r}`, root)), `php/${r} がありません`);
});

test("動画の出典を書いている", () => {
  assert.match(html, /id="credits"/);
  assert.match(html, /OpenStreetMap contributors/);
});

test("公開するものに入っている", () => {
  assert.match(read("tools/build_site.sh").toString(), /\btour\.html\b/);
});
