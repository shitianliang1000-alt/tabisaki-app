// 旅程を、この端末の外へ出せるか。
//
// いま、作った旅程が残る場所はその端末の localStorage だけで、最大10件
// です。機種を変えたら消えます。Safari の追跡防止は、しばらく開かない
// サイトの保存を消します。共有のリンクは**条件だけ**を運ぶので、
// 受け取った人が開くとその場で組み直され、時刻が変わります。
// 同行者と同じ時刻で回れません。
//
// ここで確かめたいのは3つです。
//   ・凍結した旅程が、そのままファイルになること
//   ・読めないファイルを、**黙って読み違えない**こと
//   ・読み込んでも、手元の履歴が消えないこと

import assert from "node:assert/strict";
import test from "node:test";

import {
  FORMAT, VERSION, mergeTrips, readTripFile, toBackupFile, toTripFile,
  tripFilename,
} from "../js/transfer.js";

const entry = (over = {}) => ({
  id: "izumo-2026",
  title: "出雲",
  savedAt: 1_760_000_000_000,
  state: { note: "出雲大社へ" },
  trip: { origin: { name: "東京駅" } },
  itin: {
    title: "出雲",
    days: [{
      date: "2026-09-20T09:00:00.000Z",
      items: [{ kind: "spot", title: "出雲大社",
                start: "2026-09-20T10:00:00.000Z" }],
    }],
  },
  ...over,
});

test("凍結した旅程が、そのままファイルになる", () => {
  const doc = toTripFile(entry());
  assert.equal(doc.format, FORMAT);
  assert.equal(doc.version, VERSION);
  assert.equal(doc.kind, "trip");
  assert.equal(doc.trips.length, 1);
  // 本体は旅程そのものです（時刻が固まっているので、受け取った人の
  // 端末でも同じ時刻で開きます）。
  assert.equal(doc.trips[0].itin.days[0].items[0].title, "出雲大社");
  // JSON にできること（関数や循環が混ざっていないこと）。
  assert.doesNotThrow(() => JSON.stringify(doc));
});

test("設定やキーは、ファイルに入れない", () => {
  const doc = toTripFile(entry({ settings: { mapsKey: "AIza-secret" },
                                 mapsKey: "AIza-secret" }));
  const text = JSON.stringify(doc);
  assert.doesNotMatch(text, /AIza-secret/,
    "鍵がファイルに混ざっています（渡した相手に見えます）");
});

test("履歴ぜんぶも、控えにできる", () => {
  const doc = toBackupFile([entry(), entry({ id: "b", title: "松江" })]);
  assert.equal(doc.kind, "backup");
  assert.equal(doc.trips.length, 2);
});

test("読み込めば、同じ旅程が戻る", () => {
  const text = JSON.stringify(toTripFile(entry()));
  const out = readTripFile(text);
  assert.equal(out.ok, true);
  assert.equal(out.trips[0].title, "出雲");
  assert.equal(out.trips[0].itin.days[0].items[0].title, "出雲大社");
});

test("読めないファイルを、黙って読み違えない", () => {
  // 旅程のファイルは、日付・時刻・座標の集まりです。別のものを無理に
  // 読むと、ありもしない時刻の旅程が画面に出ます。
  assert.equal(readTripFile("これはJSONではありません").ok, false);
  assert.match(readTripFile("これはJSONではありません").error, /JSON/);

  assert.equal(readTripFile('{"format":"other","version":1}').ok, false);
  assert.match(readTripFile('{"format":"other","version":1}').error,
    /旅さきのファイルではない/);

  // 新しい形式。読めるふりをするより、そう言うほうが正しいです。
  const future = JSON.stringify({ format: FORMAT, version: VERSION + 1,
                                  trips: [entry()] });
  assert.equal(readTripFile(future).ok, false);
  assert.match(readTripFile(future).error, /新しい形式/);

  // 中身が空の旅程。開いたときに真っ白になります。
  const empty = JSON.stringify({ format: FORMAT, version: VERSION,
                                 trips: [{ id: "x", title: "空", itin: { days: [] } }] });
  assert.equal(readTripFile(empty).ok, false);
});

test("読み込んでも、手元の履歴は消えない", () => {
  // 控えを読み込んだら手元の旅程が消えた、はいちばん困ります。
  const mine = [entry({ id: "mine", title: "手元の旅" })];
  const { list, added, replaced } = mergeTrips(mine,
    [entry({ id: "new", title: "もらった旅" })]);
  assert.equal(added, 1);
  assert.equal(replaced, 0);
  assert.equal(list.length, 2);
  assert.ok(list.some((x) => x.id === "mine"), "手元の旅が消えました");
});

test("同じ旅程を2度読んでも、2つ並ばない", () => {
  const mine = [entry()];
  const { list, added, replaced } = mergeTrips(mine, [entry()]);
  assert.equal(added, 0);
  assert.equal(replaced, 1);
  assert.equal(list.length, 1);
});

test("id の無いファイルでも、一覧に出る", () => {
  // 履歴の側は id と title のあるものしか残しません。無いまま足すと
  // 「読み込めました」と言ったのに一覧に出ない、が起きます。
  const { list } = mergeTrips([], [{ ...entry(), id: null, title: "" }]);
  assert.equal(typeof list[0].id, "string");
  assert.ok(list[0].id.length > 0);
  assert.ok(list[0].title.length > 0);
});

test("ファイル名に、日本語を使わない", () => {
  // download 属性に日本語を渡すと、環境によっては名前ごと捨てられ、
  // 拡張子まで失われます（.ics で実際に起きました）。
  const name = tripFilename(toTripFile(entry()));
  assert.match(name, /^[\x20-\x7E]+$/, `日本語が入っています: ${name}`);
  assert.match(name, /\.json$/);
  assert.match(name, /2026-09-20/);
});

test("控えのファイルに、質問だけのチャットも入って戻せる", () => {
  const chat = { id: "chat-1", kind: "chat", title: "こんにちは", subtitle: "こんにちは！",
                 savedAt: 1, msgs: [{ q: "こんにちは", a: "こんにちは！" }] };
  const doc = toBackupFile([chat]);
  const back = readTripFile(JSON.stringify(doc));
  assert.equal(back.ok, true);
  assert.equal(back.trips[0].kind, "chat");
  assert.equal(back.trips[0].msgs[0].q, "こんにちは");
});
