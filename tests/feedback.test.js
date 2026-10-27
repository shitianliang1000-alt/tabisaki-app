// 行ってきた旅の感想（js/feedback.js）。
//
// 端末の中だけに、選んだ項目だけを、決まった期間だけ残す。

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import {
  FEEDBACK_KEY, ISSUES, MAX_TRIPS, RETAIN_DAYS, clearFeedback, cleanEntry, feedbackFor,
  issueUrl, loadFeedback, removeFeedback, reportMarkdown, saveFeedback, spotsOf, summarize,
  tripKey, tripStarted,
} from "../js/feedback.js";

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
}

const NOW = new Date("2026-11-03T20:00:00+09:00");
const spot = (id, name, start) => ({ kind: "spot", spotId: id, place: { id, name },
  start: new Date(start), end: new Date(new Date(start).getTime() + 3600000) });
const itin = {
  regionName: "鎌倉",
  days: [{ items: [
    { kind: "move", start: new Date("2026-11-03T09:00:00+09:00") },
    spot("kb:1", "鶴岡八幡宮", "2026-11-03T10:00:00+09:00"),
    spot("kb:2", "長谷寺", "2026-11-03T13:00:00+09:00"),
    spot("kb:1", "鶴岡八幡宮", "2026-11-03T15:00:00+09:00"),
  ] }],
};

test("立ち寄り先は重複なしで、出てくる順", () => {
  assert.deepEqual(spotsOf(itin), [
    { spotId: "kb:1", name: "鶴岡八幡宮" }, { spotId: "kb:2", name: "長谷寺" },
  ]);
});

test("旅の印は立ち寄り先の並びだけから作る（同じ旅なら同じ印）", () => {
  const k = tripKey(itin);
  assert.match(k, /^t[0-9a-z]+$/);
  assert.equal(tripKey(structuredClone(itin)), k);
  assert.notEqual(tripKey({ days: [{ items: [spot("kb:9", "x", NOW)] }] }), k);
  assert.equal(tripKey({ days: [] }), "");
});

test("感想の欄は、旅が始まってから", () => {
  assert.equal(tripStarted(itin, new Date("2026-11-02T12:00:00+09:00")), false);
  assert.equal(tripStarted(itin, NOW), true);
  // 開き直した旅程は日時が文字列のこともあります。
  assert.equal(tripStarted({ days: [{ items: [{ start: "2026-11-03T00:00:00Z" }] }] }, NOW), true);
  assert.equal(tripStarted({}, NOW), false);
});

test("持つのは決まった項目だけ（自由な文字・出発地・知らない値は落とす）", () => {
  const e = cleanEntry({
    key: tripKey(itin), region: "鎌倉", pace: "tight", from: "東京都港区…",
    note: "友だちの家に泊まった",
    spots: [
      { spotId: "kb:1", name: "鶴岡八幡宮", status: "went", issues: ["crowd", "typed", "crowd"], memo: "x" },
      { spotId: "kb:2", name: "長谷寺", status: "", issues: [] },     // 何も選んでいない
      { spotId: "<script>", status: "went" },                          // id として変
    ],
  }, NOW);
  assert.deepEqual(Object.keys(e).sort(), ["key", "pace", "region", "savedAt", "spots"]);
  assert.deepEqual(e.spots, [{ spotId: "kb:1", name: "鶴岡八幡宮", status: "went", issues: ["crowd"] }]);
  assert.equal(cleanEntry({ key: tripKey(itin), spots: [] }, NOW), null);
  assert.equal(cleanEntry({ key: "東京", pace: "ok" }, NOW), null);
});

test("残す・上書き・消す", () => {
  const s = memStorage();
  const key = tripKey(itin);
  assert.ok(saveFeedback({ key, pace: "ok", spots: [] }, s, NOW));
  saveFeedback({ key, pace: "tight", spots: [{ spotId: "kb:2", status: "skipped", issues: ["hours"] }] }, s, NOW);
  const list = loadFeedback(s, NOW);
  assert.equal(list.length, 1);
  assert.equal(feedbackFor(key, s, NOW).pace, "tight");
  // 何も選んでいなければ残しません。
  assert.equal(saveFeedback({ key: "tabc", spots: [] }, s, NOW), null);
  removeFeedback(key, s, NOW);
  assert.equal(s.raw.has(FEEDBACK_KEY), false);
  saveFeedback({ key, pace: "ok", spots: [] }, s, NOW);
  clearFeedback(s);
  assert.deepEqual(loadFeedback(s, NOW), []);
});

test(`${RETAIN_DAYS}日を過ぎた感想は、読むときに消える`, () => {
  const s = memStorage();
  const old = new Date(NOW.getTime() - (RETAIN_DAYS + 1) * 86400000);
  saveFeedback({ key: "told", pace: "ok", spots: [] }, s, old);
  saveFeedback({ key: "tnew", pace: "loose", spots: [] }, s, NOW);
  assert.deepEqual(loadFeedback(s, NOW).map((x) => x.key), ["tnew"]);
  assert.equal(JSON.parse(s.raw.get(FEEDBACK_KEY)).length, 1);
});

test(`覚えるのは${MAX_TRIPS}件まで`, () => {
  const s = memStorage();
  for (let i = 0; i < MAX_TRIPS + 5; i++) saveFeedback({ key: `t${i}`, pace: "ok", spots: [] }, s, NOW);
  assert.equal(loadFeedback(s, NOW).length, MAX_TRIPS);
});

test("壊れた保存や、保存できない端末でも落ちない", () => {
  assert.deepEqual(loadFeedback(memStorage({ [FEEDBACK_KEY]: "{" }), NOW), []);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); },
                   removeItem: () => {} };
  assert.deepEqual(loadFeedback(broken, NOW), []);
  assert.ok(saveFeedback({ key: "tx", pace: "ok", spots: [] }, broken, NOW));
});

test("集計とまとめ：心当たりの多い順、件数だけ", () => {
  const list = [
    cleanEntry({ key: "ta", pace: "tight", spots: [
      { spotId: "kb:2", name: "長谷寺", status: "skipped", issues: ["hours"] },
      { spotId: "kb:1", name: "鶴岡八幡宮", status: "went", issues: [] }] }, NOW),
    cleanEntry({ key: "tb", pace: "ok", spots: [
      { spotId: "kb:2", name: "長谷寺", status: "went", issues: ["hours", "move"] }] }, NOW),
  ];
  const sum = summarize(list);
  assert.equal(sum.trips, 2);
  assert.deepEqual(sum.pace, { ok: 1, tight: 1, loose: 0 });
  assert.equal(sum.spots[0].spotId, "kb:2");
  assert.equal(sum.spots[0].issues.hours, 2);
  assert.equal(sum.spots[0].skipped, 1);
  const md = reportMarkdown(sum);
  assert.match(md, /\| 長谷寺 \| `kb:2` \| 1 \| 2 \|/);
  assert.doesNotMatch(md, /鶴岡八幡宮/);   // 何も無かった場所は出さない
  assert.match(md, new RegExp(ISSUES.hours));
  assert.match(reportMarkdown(summarize([])), /違ったところはありませんでした/);
});

test("名前の | や改行で表が崩れない", () => {
  const sum = summarize([cleanEntry({ key: "ta", spots: [
    { spotId: "kb:3", name: "A|B\nC", status: "skipped", issues: [] }] }, NOW)]);
  assert.match(reportMarkdown(sum), /\| A B C \|/);
});

test("Issue の URL は GitHub の新規 Issue で、長すぎる本文は切る", () => {
  const u = new URL(issueUrl("本文"));
  assert.equal(u.origin + u.pathname, "https://github.com/shitianliang1000-alt/tabisaki-app/issues/new");
  assert.equal(u.searchParams.get("body"), "本文");
  assert.match(u.searchParams.get("title"), /旅の感想/);
  assert.ok(new URL(issueUrl("x".repeat(20000))).searchParams.get("body").length < 6100);
});

test("感想はどこにも送らない（fetch・sendBeacon・metrics を使わない）", () => {
  const src = fs.readFileSync(new URL("../js/feedback.js", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /fetch\(|sendBeacon|XMLHttpRequest|metrics\.js|import /);
});
