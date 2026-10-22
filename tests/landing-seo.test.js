// トップ（/）の、検索エンジン向けの書き込み。
//
//   ・構造化データ（WebSite・WebApplication・FAQPage）が JSON として読めること
//   ・よくある質問の字が、画面に出ている #faq と同じであること（違うと載りません）

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { landingView, renderTpl } from "../server/landing.js";

const root = new URL("../", import.meta.url);
const tpl = await readFile(new URL("php/inc/landing.html", root), "utf8");
const base = "https://tabisaki.example/";
const html = renderTpl(tpl, landingView(new Date("2026-10-22T03:00:00Z"),
  { areas: [], news: [], spotCount: 54115, prefCount: 47 }, base, "test"));

const text = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

test("トップの構造化データは JSON として読め、サイトの根を指す", () => {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "構造化データがありません");
  const ld = JSON.parse(m[1]);
  const site = ld["@graph"].find((x) => x["@type"] === "WebSite");
  assert.equal(site.url, base);
  assert.equal(ld["@graph"].find((x) => x["@type"] === "WebApplication").url, `${base}app`);
});

test("よくある質問の構造化データは、画面の #faq と同じ字", () => {
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const faq = ld["@graph"].find((x) => x["@type"] === "FAQPage").mainEntity;
  const section = /<section class="faq"[\s\S]*?<\/section>/.exec(html)[0];
  const shown = [...section.matchAll(/<summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p>/g)]
    .map((m) => [text(m[1]), text(m[2])]);
  assert.equal(shown.length, faq.length);
  assert.deepEqual(faq.map((q) => [q.name, q.acceptedAnswer.text]), shown);
});
