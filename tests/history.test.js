// つくった旅程を覚えておく仕組みのテスト。
//
// 旅行サイトでいちばん使われるのは「前に作った旅程をもう一度開く」です。
// ここが壊れると、ブラウザを閉じた時点で全部消えます。

import assert from "node:assert/strict";
import test from "node:test";

import { MAX, addChat, httpsSources, addHistory, clearHistory, isChat, loadHistory, removeHistory, savedLabel,
         thawItinerary } from "../js/history.js";

/** localStorage の代わり。テストのあいだだけ持ちます。 */
function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    _map: map,
  };
}

const entry = (title, extra = {}) => ({
  title, subtitle: "神奈川県", when: "日帰り",
  // 名前は js/app.js の formState() と同じにしておきます
  state: { dep: "2026-09-05T09:00", arr: "2026-09-05T19:00",
           from: "東京", to: "", ...extra },
});

test("何も無いところから始まる", () => {
  assert.deepEqual(loadHistory(fakeStore()), []);
});

test("足したものが、いちばん上に来る", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("箱根"), s);
  assert.deepEqual(loadHistory(s).map((x) => x.title), ["箱根", "鎌倉"]);
});

test("同じ旅は、増やさずに上書きする", () => {
  // 同じ旅を何度も作り直すのはふつうのことです。
  // そのたびに一覧が埋まると、探せなくなります。
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("箱根"), s);
  addHistory(entry("鎌倉"), s);
  assert.deepEqual(loadHistory(s).map((x) => x.title), ["鎌倉", "箱根"]);
});

test("日程が違えば、別の旅として持つ", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("鎌倉", { dep: "2026-10-01T09:00" }), s);
  assert.equal(loadHistory(s).length, 2);
});

test("出発地が違えば、別の旅として持つ", () => {
  // 同じ鎌倉でも、東京発と大阪発ではまったく別の旅程になります。
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("鎌倉", { from: "大阪" }), s);
  assert.equal(loadHistory(s).length, 2);
});

test("覚える件数には上限がある", () => {
  const s = fakeStore();
  for (let i = 0; i < MAX + 5; i++) addHistory(entry(`旅${i}`), s);
  const list = loadHistory(s);
  assert.equal(list.length, MAX);
  assert.equal(list[0].title, `旅${MAX + 4}`, "新しいものが残るはずです");
});

test("1件だけ消せる", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addHistory(entry("箱根"), s);
  const id = loadHistory(s)[0].id;
  removeHistory(id, s);
  assert.deepEqual(loadHistory(s).map((x) => x.title), ["鎌倉"]);
});

test("全部消せる", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  clearHistory(s);
  assert.deepEqual(loadHistory(s), []);
});

test("壊れていても、落ちない", () => {
  // localStorage は、別のタブや拡張機能に書き換えられることがあります。
  const s = fakeStore();
  s.setItem("tabisaki.history", "{ こわれた");
  assert.deepEqual(loadHistory(s), []);
  s.setItem("tabisaki.history", '[{"no":"id"}]');
  assert.deepEqual(loadHistory(s), []);
});

test("題も条件も無いものは、覚えない", () => {
  const s = fakeStore();
  addHistory({ title: "", state: {} }, s);
  addHistory({ title: "鎌倉" }, s);
  assert.deepEqual(loadHistory(s), []);
});

test("いつ作ったかを、読める言葉にする", () => {
  const now = new Date("2026-09-10T12:00");
  const ago = (d) => now.getTime() - d * 86400000;
  assert.equal(savedLabel(ago(0), now), "今日");
  assert.equal(savedLabel(ago(1), now), "昨日");
  assert.equal(savedLabel(ago(3), now), "3日前");
  assert.match(savedLabel(ago(30), now), /月.*日/);
  assert.equal(savedLabel(undefined, now), "");
});

// --------------------------------------------------- 旅程そのものの保存 --
//
// 条件だけを覚えて、開くたびに組み直していました。同じ条件でも組み直せば
// 別の旅程が出るので（AIの選び方も、調べた便もそのときのもの）、保存した
// つもりの旅程が知らない場所に入れ替わります。旅程そのものを持ちます。

test("旅程そのものが保存され、日時も戻る", () => {
  const store = fakeStore();
  const itin = {
    title: "大阪",
    days: [{ key: 1, items: [{ kind: "spot", title: "通天閣",
                               start: new Date("2026-09-15T10:00"),
                               end: new Date("2026-09-15T11:00") }] }],
  };
  addHistory({ ...entry("大阪"), itin }, store);
  const saved = loadHistory(store)[0];
  assert.ok(saved.itin, "旅程が保存されていません");

  const back = thawItinerary(saved.itin);
  const item = back.days[0].items[0];
  assert.equal(item.title, "通天閣");
  assert.ok(item.start instanceof Date, `日時が戻っていません: ${item.start}`);
  assert.equal(item.start.getHours(), 10);
});

test("日ごとの「その日」も、Date に戻る", () => {
  // planner.js は days[].date に Date を置きます。保存すると文字列になり、
  // 戻さないまま開くと、日付の見出し（toLocaleDateString）で落ちます。
  const store = fakeStore();
  const itin = {
    title: "京都",
    days: [{ key: 1, date: new Date("2026-09-15T09:00"),
             items: [{ kind: "spot", title: "清水寺",
                       start: new Date("2026-09-15T10:00"),
                       end: new Date("2026-09-15T11:00") }] }],
  };
  addHistory({ ...entry("京都"), itin }, store);
  const back = thawItinerary(loadHistory(store)[0].itin);
  assert.ok(back.days[0].date instanceof Date,
    `その日が戻っていません: ${back.days[0].date}`);
  assert.equal(back.days[0].date.getDate(), 15);
});

test("説明文の中の日付を、日時に変えてしまわない", () => {
  const back = thawItinerary({
    days: [{ items: [{ detail: "2026-09-15 に改装しました",
                       start: "2026-09-15T10:00" }] }],
  });
  assert.equal(typeof back.days[0].items[0].detail, "string");
  assert.ok(back.days[0].items[0].start instanceof Date);
});

test("端末の空きが足りないときは、古いものから落として新しいぶんを残す", () => {
  let calls = 0;
  const store = {
    getItem: () => null,
    setItem: (k, v) => {
      // 2件ぶんは入らない、という端末のふり。
      if (++calls === 1 && v.length > 200) throw new Error("QuotaExceeded");
    },
  };
  const big = { days: [{ items: Array.from({ length: 50 }, (_, i) => ({
    kind: "spot", title: `場所${i}`, detail: "x".repeat(50) })) }] };
  // 落ちずに戻ってくれば十分です（保存できなくても旅程は作れます）。
  assert.doesNotThrow(() => addHistory({ ...entry("大阪"), itin: big }, store));
});

// 「些細なチャットでも履歴に残して」（2026-10-13）。旅程を組まなかった
// やりとり（あいさつ・ちょっとした質問）も、「最近のチャット」に残します。
test("質問だけのチャットも一覧に残る", () => {
  const s = fakeStore();
  addHistory(entry("鎌倉"), s);
  addChat({ id: "chat-1", msgs: [{ q: "こんにちは", a: "こんにちは！どこへ行きたいですか？" }] }, s);
  const list = loadHistory(s);
  assert.equal(list.length, 2);
  assert.equal(list[0].title, "こんにちは");
  assert.ok(isChat(list[0]));
  assert.ok(!isChat(list[1]), "旅程はチャット扱いしないはずです");
  assert.match(list[0].subtitle, /どこへ行きたい/);
});

test("同じチャットの続きは、1件のまま上書きされる", () => {
  const s = fakeStore();
  const msgs = [{ q: "東京タワーの高さは？", a: "333mです。" }];
  addChat({ id: "chat-1", msgs }, s);
  addHistory(entry("箱根"), s);
  msgs.push({ q: "スカイツリーは？", a: "634mです。", sources: [{ title: "公式", url: "https://example.com" }] });
  addChat({ id: "chat-1", msgs }, s);
  const list = loadHistory(s);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "chat-1", "続きを話したら、いちばん上に来るはずです");
  assert.equal(list[0].title, "東京タワーの高さは？", "題は最初の質問のままのはずです");
  assert.equal(list[0].msgs.length, 2);
  assert.equal(list[0].msgs[1].sources[0].url, "https://example.com");
});

test("やりとりが空のチャットは残さない", () => {
  const s = fakeStore();
  addChat({ id: "chat-1", msgs: [] }, s);
  addChat({ msgs: [{ q: "a", a: "b" }] }, s);
  assert.deepEqual(loadHistory(s), []);
});

test("調べた先は https のものだけを残す（読み込んだ控えに javascript: が混ざっていても）", () => {
  assert.deepEqual(httpsSources([
    { title: "公式", url: "https://example.com" },
    { title: "悪い", url: "javascript:alert(1)" },
    { title: "平文", url: "http://example.com" },
    { title: "空", url: "" },
    null,
  ]), [{ title: "公式", url: "https://example.com" }]);
  assert.deepEqual(httpsSources(undefined), []);
  const s = fakeStore();
  addChat({ id: "chat-x", msgs: [{ q: "q", a: "a", sources: [{ title: "x", url: "javascript:alert(1)" }] }] }, s);
  assert.equal(loadHistory(s)[0].msgs[0].sources, undefined);
});
