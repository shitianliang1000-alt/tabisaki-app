// 情報の確からしさを、3段階で伝えるテスト。
//
// 旅行では「その情報がどこから来たか」が結果を左右します。
// 公式で確認した営業時間と、分類ごとの目安と、AIが検索してきたものを
// 同じ顔で並べてはいけません。現地で閉まっていたとき、どれを疑えば
// よかったのかが分からなくなります。

import assert from "node:assert/strict";
import test from "node:test";

import { LEVELS, confidenceOf, describeSource, freshnessOf, reservationOf }
  from "../js/confidence.js";

const d = (s) => new Date(s);

test("3つの段階がある（確認済み・推定・AI調査）", () => {
  assert.deepEqual(Object.keys(LEVELS), ["verified", "estimated", "ai"]);
  for (const v of Object.values(LEVELS)) {
    assert.ok(v.label && v.icon && Number.isInteger(v.rank));
  }
});

// --- 営業時間 ---------------------------------------------------------------

test("実データの営業時間は「確認済み」", () => {
  const c = confidenceOf("hours",
    { category: "城", hours: { open: 9, close: 17, lastEntry: 16.5 } });
  assert.equal(c.level, "verified");
  assert.match(c.text, /収録|確認/);
});

test("分類ごとの目安しか無ければ「推定」", () => {
  const c = confidenceOf("hours", { category: "城" });
  assert.equal(c.level, "estimated");
  assert.match(c.text, /目安|分類/);
});

test("AIが調べたものは、値があっても「AI調査」", () => {
  const c = confidenceOf("hours", {
    category: "城", verified: false, source: "ai",
    hours: { open: 9, close: 17 },
  });
  assert.equal(c.level, "ai");
  assert.match(c.text, /AI/);
});

// --- 移動時間 ---------------------------------------------------------------

test("経路検索で取れた移動は「確認済み」", () => {
  const c = confidenceOf("travel", { routed: true, transit: { transfers: 1 } });
  assert.equal(c.level, "verified");
  assert.match(c.text, /経路/);
});

test("距離からの推定は「推定」", () => {
  const c = confidenceOf("travel", { routed: false });
  assert.equal(c.level, "estimated");
  assert.match(c.text, /推定|距離/);
});

// --- 取得した日 -------------------------------------------------------------

test("いつの情報かを添える", () => {
  const c = confidenceOf("hours", {
    category: "城", source: "ai", verified: false,
    fetchedAt: d("2026-09-02T10:00").getTime(),
  });
  assert.match(c.checkedAt, /2026/);
  assert.match(c.checkedAt, /9/);
});

test("日付が分からなければ、書かない（それらしい日付を作らない）", () => {
  const c = confidenceOf("hours", { category: "城" });
  assert.equal(c.checkedAt, "");
});

// --- 並べかた ---------------------------------------------------------------

test("いちばん弱い段階が、その旅程の確からしさになる", () => {
  const list = [
    confidenceOf("hours", { category: "城", hours: { open: 9, close: 17 } }),
    confidenceOf("hours", { category: "寺院" }),
    confidenceOf("travel", { routed: true }),
  ];
  const worst = describeSource(list);
  assert.equal(worst.level, "estimated");
  assert.match(worst.text, /目安|推定/);
});

test("何も無ければ、無いと言う", () => {
  const worst = describeSource([]);
  assert.equal(worst.level, "estimated");
});

// --- 情報の鮮度 -------------------------------------------------------------
// 営業時間は変わります。3か月前に調べた値を、今日確認したものと
// 同じ顔で出してはいけません。

test("古い情報には、古いと言う", () => {
  const now = d("2026-09-02T10:00");
  const fresh = confidenceOf("hours", { category: "城", source: "ai",
    verified: false, fetchedAt: d("2026-09-01T10:00").getTime() }, { now });
  const old = confidenceOf("hours", { category: "城", source: "ai",
    verified: false, fetchedAt: d("2026-03-01T10:00").getTime() }, { now });
  assert.equal(fresh.stale, false);
  assert.equal(old.stale, true);
  assert.match(old.ageText, /か月|日/);
});

test("取得日が分からないものは、古いとも新しいとも言わない", () => {
  const c = confidenceOf("hours", { category: "城" });
  assert.equal(c.stale, false);
  assert.equal(c.ageText, "");
});

test("何日前かを、そのまま読める言葉にする", () => {
  const now = d("2026-09-02T10:00");
  const day = (n) => confidenceOf("hours",
    { category: "城", source: "ai", verified: false,
      fetchedAt: new Date(+now - n * 86400000).getTime() }, { now }).ageText;
  assert.match(day(0), /今日/);
  assert.match(day(1), /昨日|1日/);
  assert.match(day(10), /10日/);
  assert.match(day(70), /2か月/);
});

// --- 予約 -------------------------------------------------------------------

test("予約が要る場所を見分ける", () => {
  const need = reservationOf({ name: "三千院", reservationRequired: true,
                               reservationUrl: "https://example.test/r" });
  assert.equal(need.required, true);
  assert.match(need.text, /予約/);
  assert.equal(need.url, "https://example.test/r");

  const free = reservationOf({ name: "公園" });
  assert.equal(free.required, false);
});

test("予約のURLは https だけ通す", () => {
  const r = reservationOf({ reservationRequired: true,
                            reservationUrl: "http://insecure.test" });
  assert.equal(r.url, "");
});

test("分類から「予約が要ることが多い」を出す（ただし断定しない）", () => {
  const r = reservationOf({ name: "テスト酒蔵", category: "酒蔵" });
  assert.equal(r.required, false);
  assert.equal(r.likely, true);
  assert.match(r.text, /多い|ことがあります/);
});

// --- 「確認済み」と「最新」は別のこと ---------------------------------------
// 3年前に確認した営業時間も「確認済み」ではあります。けれど、それを
// 最新と同じ顔で出せば、閉まっている店の前に立たせることになります。

const DAY = 86400000;
const NOW = new Date("2026-09-03T09:00:00+09:00");

test("いつ確認したかを、日付と「何日前」の両方で言う", () => {
  const f = freshnessOf(NOW.getTime() - 8 * DAY, NOW);
  assert.match(f.text, /最終確認/);
  assert.match(f.text, /8日前/);
  assert.equal(f.level, "fresh");
});

test("今日・昨日は、日数で言わない", () => {
  assert.match(freshnessOf(NOW.getTime(), NOW).text, /今日/);
  assert.match(freshnessOf(NOW.getTime() - DAY, NOW).text, /昨日/);
});

test("1か月を過ぎたら、そう見なす", () => {
  assert.equal(freshnessOf(NOW.getTime() - 35 * DAY, NOW).level, "aging");
  assert.match(freshnessOf(NOW.getTime() - 35 * DAY, NOW).text, /1か月前/);
});

test("古すぎるものは、はっきり古いと言う", () => {
  // 営業時間は季節で変わります。60日を境にしています。
  assert.equal(freshnessOf(NOW.getTime() - 90 * DAY, NOW).level, "stale");
});

test("確認日が分からないときは、それらしい日付を作らない", () => {
  assert.equal(freshnessOf(undefined, NOW).level, "unknown");
  assert.equal(freshnessOf(null, NOW).level, "unknown");
  assert.match(freshnessOf(undefined, NOW).text, /不明/);
  // 未来の日付も「分からない」に倒します（信じる根拠がありません）
  assert.equal(freshnessOf(NOW.getTime() + 10 * DAY, NOW).level, "unknown");
});

// --- 状態だけでなく、取るべき行動まで言う -----------------------------------

test("AI調査には、次にすることが添えられている", () => {
  assert.match(LEVELS.ai.tone, /確認できていません/);
  assert.match(LEVELS.ai.action, /公式/);
});

test("収録データでも、行く日のことまでは請け合わない", () => {
  // 「確認済み」と言い切ると、営業時間の変更や臨時休業の責任まで
  // 引き受けたことになります。確かめたのは**収録した時点の値**です。
  assert.equal(LEVELS.verified.label, "収録データ");
  assert.match(LEVELS.verified.action, /公式/);
});

test("まとめた結果にも、取るべき行動が付いてくる", () => {
  const mix = describeSource([
    confidenceOf("hours", { open: 9, close: 17 }),
    confidenceOf("hours", { source: "ai" }),
  ]);
  assert.equal(mix.level, "ai", "いちばん弱いものが全体の弱さになるはずです");
  assert.match(mix.action, /公式/);
});

// --- 印に、出どころの名前を重ねない -----------------------------------------
//
// 電車・バスの時刻はTransit APIからしか取らなくなりました。Googleの
// 経路と見分ける必要が無くなった以上、「時刻表・Transit API」と
// 並べても読む人の判断は変わりません。印は短いほうが読まれます。

test("時刻表の印に、提供元の名前は添えない", () => {
  const c = confidenceOf("travel", {
    kind: "transit", routed: true,
    yahoo: { departure: "09:02", arrival: "09:04" },
  });
  assert.equal(c.label, "時刻表");
  assert.equal(c.source, "", "「時刻表・Transit API」と並べています");
  // 中身（何を見て確かめたか）は残します。開けば読めます。
  assert.match(c.text, /Transit API/);
});

test("目安と徒歩は、これまでどおりの印", () => {
  const est = confidenceOf("travel", { kind: "transit", routed: false });
  assert.equal(est.level, "estimated");
  const walk = confidenceOf("travel",
    { kind: "transit", routed: false, walk: true });
  assert.equal(walk.label, "徒歩");
  assert.equal(walk.source, "");
});

test("駅もバス停も無い区間は、「目安」ではなくタクシーと出す", () => {
  // 「🟡 目安」とだけ書かれた行を見ても、調べそこねたのか、そもそも
  // 便が無いのかが分かりません。読む人の次の一手が変わります。
  const c = confidenceOf("travel", {
    kind: "transit", routed: false, noTransit: true,
  });
  assert.equal(c.label, "タクシー");
  assert.match(c.text, /タクシーで行くものとして/);
});

test("ふつうに引けなかった区間は、これまでどおり「目安」", () => {
  const c = confidenceOf("travel", { kind: "transit", routed: false });
  assert.equal(c.label, "目安");
});

// --- 当日行っても入れない場所 -----------------------------------------------
//
// 分類の目安（酒蔵・テーマパーク）とは別に、名指しで持ちます。
// ジブリ美術館は日時指定の予約券だけで、当日券はありません。旅程に
// 入った時点で言わないと、行ってから知ることになります。

test("予約券だけの場所を、名指しで「必要」と言う", () => {
  const ghibli = reservationOf({ name: "三鷹の森ジブリ美術館（三鷹市立アニメーション美術館）" });
  assert.equal(ghibli.required, true);
  assert.match(ghibli.text, /当日券はありません/);
  // いつ売り出されるかは、取りかたの型として書きます（値段は書きません）。
  assert.match(ghibli.text, /毎月10日/);
  assert.doesNotMatch(ghibli.text, /\d+円/);
});

test("公式サイトがあれば、そこへ渡す", () => {
  // 収録の url（Wikidata の公式サイト）をそのまま使います。
  const r = reservationOf({ name: "ジブリパーク", url: "https://ghibli-park.jp/" });
  assert.equal(r.url, "https://ghibli-park.jp/");
  // http のものは https に書き換えます（平文で開かせません）。
  const r2 = reservationOf({ name: "ジブリパーク", url: "http://ghibli-park.jp/" });
  assert.equal(r2.url, "https://ghibli-park.jp/");
  // 無ければ、公式で申し込むように書きます（リンクは出せません）。
  const r3 = reservationOf({ name: "ジブリパーク" });
  assert.equal(r3.url, "");
  assert.match(r3.text, /公式サイト/);
});

test("「混むから予約したほうがいい」程度の場所は、名指ししない", () => {
  // 載せると、要らない場所で予約を探させることになります。
  const r = reservationOf({ name: "出雲大社", category: "神社" });
  assert.equal(r.required, false);
  assert.equal(r.likely, false);
});
