// 多言語対応（packages/core/i18n.mjs・locales/・tools/i18n_check.mjs）の試験。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createI18n, localizeSpot, pickLang, sourceHash } from "../packages/core/i18n.mjs";
import { checkLocales, checkSpotOverlays, loadLocaleDir } from "../tools/i18n_check.mjs";

const catalogs = loadLocaleDir();

test("言語の名前のゆれを受け止める。知らない言語は null", () => {
  assert.equal(pickLang("en-US"), "en");
  assert.equal(pickLang("en_US.UTF-8"), "en");
  assert.equal(pickLang("JA"), "ja");
  assert.equal(pickLang("fr"), null);
  assert.equal(pickLang(undefined), null);
});

test("差し込みと、数で変わる文", () => {
  const en = createI18n("en", catalogs);
  assert.equal(en.t("plan.day", { n: 3 }), "Day 3");
  assert.equal(en.t("plan.days", { n: 1 }), "Length: 1 day");
  assert.equal(en.t("plan.days", { n: 2 }), "Length: 2 days");
  assert.equal(createI18n("ja", catalogs).t("plan.days", { n: 1 }), "日数: 1日");
});

test("訳が無い鍵は原文（日本語）に戻る。原文にも無ければ鍵を出す", () => {
  const i = createI18n("en", { ja: { "a.b": "原文 {x}" }, en: {} });
  assert.equal(i.t("a.b", { x: 1 }), "原文 1");
  assert.equal(i.t("no.such"), "no.such");
  assert.equal(createI18n("fr", catalogs).lang, "ja");
});

test("時刻は日本時間、通貨は円、距離は km", () => {
  const d = new Date("2026-11-02T23:05:00Z"); // 日本時間 11/3 08:05
  const ja = createI18n("ja", catalogs);
  const en = createI18n("en", catalogs);
  assert.equal(ja.time(d), "08:05");
  assert.equal(en.time(d), "08:05");
  assert.equal(ja.date(d), "11/3(火)");
  assert.equal(en.date(d), "Tue, Nov 3");
  assert.equal(ja.yen(21700), "21,700円");
  assert.equal(en.yen(21700), "¥21,700");
  assert.equal(ja.km(3.25), "3.3km");
  assert.equal(en.km(3.25), "3.3 km");
});

test("locales/ の訳は原文と鍵・差し込みが合っている", () => {
  const r = checkLocales(catalogs);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("点検は、原文に無い鍵・差し込みの食い違いを誤り、訳していない鍵を気になる点にする", () => {
  const r = checkLocales({
    ja: { "a": "{x} です", "b": "びー" },
    en: { _meta: { lang: "en" }, "a": "{y} is", "zzz": "?" },
  });
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.join("\n"), /zzz は原文/);
  assert.match(r.errors.join("\n"), /差し込み/);
  assert.deepEqual(r.warnings, ["en.json: b がまだ訳されていません（原文が出ます）"]);
});

test("スポットの訳: 原文が変わった訳は使わず、原文を出す", () => {
  const spot = { id: "s1", name: "清水寺", description: "古刹。" };
  const tr = { s1: { name: "Kiyomizu-dera", description: "An old temple.", by: "human", sourceHash: sourceHash(spot) } };
  assert.deepEqual(localizeSpot(spot, tr), { name: "Kiyomizu-dera", description: "An old temple.", original: false });
  assert.deepEqual(localizeSpot({ ...spot, description: "直した説明。" }, tr), { name: "清水寺", description: "直した説明。", original: true });
  assert.equal(localizeSpot(spot, undefined).original, true);
});

test("スポットの訳の点検（kb/i18n/<言語>/）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "i18n-"));
  const spots = [{ id: "s1", name: "清水寺", description: "古刹。" }, { id: "s2", name: "金閣寺" }];
  writeFileSync(path.join(dir, "spots-x.json"), JSON.stringify({ spots }));
  mkdirSync(path.join(dir, "i18n", "en"), { recursive: true });
  writeFileSync(path.join(dir, "i18n", "en", "spots-x.json"), JSON.stringify({
    lang: "en",
    spots: {
      s1: { name: "Kiyomizu-dera", by: "human", sourceHash: sourceHash(spots[0]) },
      s2: { name: "Kinkaku-ji", by: "human", sourceHash: "00000000" },
      s9: { name: "?", by: "human", sourceHash: "x" },
    },
  }));
  const r = checkSpotOverlays(dir);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /s9 は収録にありません/);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /s2（金閣寺）は原文が変わりました/);
  assert.equal(r.stats.en.spots, 3);
});
