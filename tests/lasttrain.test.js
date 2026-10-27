// 終電の線。
//
// 旅程の帰りには「18:40発」としか書いてありませんでした。当日に知り
// たいのは、その隣にある数です——その駅の終電は何時で、あと何分
// 粘れるのか。無いと2つのことが起きます。
//
//   ・夕暮れがきれいでも、何分まで待てるか分からないので1本前で帰る
//   ・立ち寄りを足して帰りが終電より後になっても、誰も何も言わない
//
// ここで確かめたいのは、**数えかたが正しいこと**と、**分からないときに
// 何も言わないこと**の2つです。

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  TIGHT_MIN, attachLastTrain, clockMinutes, lastRideOf, lastTrainNote,
  lateMinutes, marginMinutes, stationsOf,
} from "../packages/core/src/lasttrain.js";
import { parseRouteDetail, parseSummary, routeBlocks }
  from "../server/worker.js";

// --- 数えかた -------------------------------------------------------------

test("日をまたぐ発車を、いちばん遅い便として数える", () => {
  // 終電は1時ごろまで、始発は4時半ごろから。あいだに発車はありません。
  // 00:10発を「10分」と数えると、22:58発より早いことになってしまいます。
  assert.equal(lateMinutes("22:58"), 22 * 60 + 58);
  assert.equal(lateMinutes("00:10"), 24 * 60 + 10);
  assert.equal(lateMinutes("03:59"), 27 * 60 + 59);
  // 4時を過ぎたら、その日の始発の側です。
  assert.equal(lateMinutes("04:00"), 4 * 60);
  assert.ok(lateMinutes("00:10") > lateMinutes("22:58"));
});

test("読めない時刻は null（0分にしない）", () => {
  // 0分にすると「終電は00:00です」という、いかにもありそうな嘘になります。
  for (const bad of ["", null, undefined, "25:99", "あとで", "1840", "8:5"]) {
    assert.equal(clockMinutes(bad), null, `${bad} が読めてしまいます`);
    assert.equal(lateMinutes(bad), null);
  }
  assert.equal(clockMinutes("9:05"), 9 * 60 + 5);
});

test("余裕を、分で数える", () => {
  assert.equal(marginMinutes("18:40", "22:58"), 4 * 60 + 18);
  // 予定が終電より後なら、負になります。
  assert.equal(marginMinutes("23:40", "22:58"), -42);
  // 終電が日をまたぐとき。
  assert.equal(marginMinutes("23:40", "00:10"), 30);
  // どちらかが読めなければ、数えません。
  assert.equal(marginMinutes("18:40", ""), null);
});

// --- 書きかた -------------------------------------------------------------

const LAST = { departure: "22:58", arrival: "00:39" };

test("余裕があるときは、あと何時間粘れるかを書く", () => {
  const n = lastTrainNote(LAST, { departure: "18:40", station: "小田原",
                                  to: "東京" });
  assert.equal(n.level, "ok");
  assert.equal(n.marginMin, 258);
  assert.match(n.text, /小田原 22:58 発/);
  assert.match(n.text, /4時間18分/);
  // 出どころを必ず添えます。ダイヤそのものを持っているわけではありません。
  assert.match(n.text, /Yahoo!路線情報/);
  assert.match(n.text, /遅延は含みません/);
});

test("余裕が少ないときは、少ないと書く", () => {
  const n = lastTrainNote(LAST, { departure: "22:40", station: "小田原" });
  assert.equal(n.level, "tight");
  assert.equal(n.marginMin, 18);
  assert.ok(n.marginMin <= TIGHT_MIN);
  assert.match(n.text, /18分 しかありません/);
});

test("予定が終電より後なら、帰れないと書く", () => {
  // これがいちばん大事です。黙って出すと、当日に駅で分かります。
  const n = lastTrainNote(LAST, { departure: "23:40", station: "小田原" });
  assert.equal(n.level, "over");
  assert.equal(n.marginMin, -42);
  assert.match(n.text, /42分 後/);
  assert.match(n.text, /帰れません/);
  // 勝手に直したことにはしません。何をすればいいかだけ書きます。
  assert.match(n.text, /立ち寄りを減らすか、泊まる/);
});

test("終電が読めなければ、何も書かない", () => {
  // 「終電は分かりません」とだけ出しても、現地では役に立ちません。
  for (const bad of [null, {}, { departure: "" }, { departure: "なんとか" }]) {
    assert.equal(lastTrainNote(bad, { departure: "18:40" }), null);
  }
});

test("予定の発車が分からなくても、終電だけは書く", () => {
  const n = lastTrainNote(LAST, { station: "小田原" });
  assert.equal(n.level, "ok");
  assert.equal(n.marginMin, null);
  assert.match(n.text, /小田原 22:58 発/);
  // 数えていないものを、数えたように書きません。
  assert.ok(!/分 しかありません/.test(n.text));
  assert.ok(!/粘れます/.test(n.text));
});

// --- どの移動に付けるか -----------------------------------------------------

const ride = (o) => ({ kind: "transit", id: o.id, start: o.start ?? new Date(),
  yahoo: o.yahoo, walk: o.walk, drive: o.drive });

test("その日の最後の「乗る」移動だけに付ける", () => {
  const day = { items: [
    ride({ id: "a", yahoo: { departure: "09:00", legs: [{ from: "東京", to: "小田原" }] } }),
    { kind: "spot", id: "s" },
    ride({ id: "b", yahoo: { departure: "18:40", legs: [{ from: "小田原", to: "東京" }] } }),
  ] };
  assert.equal(lastRideOf(day).id, "b");
});

test("歩きと運転には終電がないので、選ばない", () => {
  const day = { items: [
    ride({ id: "a", yahoo: { departure: "09:00", legs: [{ from: "東京", to: "小田原" }] } }),
    ride({ id: "w", walk: true, yahoo: { departure: "18:40", legs: [] } }),
    ride({ id: "c", drive: true, yahoo: { departure: "19:00", legs: [] } }),
  ] };
  assert.equal(lastRideOf(day).id, "a");
});

test("調べた便が付いていない移動は選ばない", () => {
  // 目安だけで組んだ区間は、どの駅から乗るのかが分かりません。
  // 「出雲大社」の終電はありません。乗るのは「出雲大社前駅」です。
  const day = { items: [ride({ id: "x", yahoo: null })] };
  assert.equal(lastRideOf(day), null);
});

test("聞く相手は、場所ではなく駅", () => {
  const item = ride({ id: "b", yahoo: { departure: "18:40",
    legs: [{ from: "出雲大社前", to: "川跡" }, { from: "川跡", to: "電鉄出雲市" }] } });
  assert.deepEqual(stationsOf(item), { from: "出雲大社前", to: "電鉄出雲市" });
  assert.equal(stationsOf(ride({ yahoo: { legs: [] } })), null);
});

// --- 旅程に足す -------------------------------------------------------------

function itinOf() {
  return { days: [{ items: [
    ride({ id: "a", start: new Date("2026-09-19T09:00:00+09:00"),
           yahoo: { departure: "09:00", legs: [{ from: "東京", to: "小田原" }] } }),
    ride({ id: "b", start: new Date("2026-09-19T18:40:00+09:00"),
           yahoo: { departure: "18:40", legs: [{ from: "小田原", to: "東京" }] } }),
  ] }] };
}

test("旅程の帰りに、終電の一言が付く", async () => {
  const asked = [];
  const itin = itinOf();
  const n = await attachLastTrain(itin, async (from, to, when) => {
    asked.push({ from, to, day: when.toISOString().slice(0, 10) });
    return { routed: true, meta: { departure: "22:58", arrival: "00:39" } };
  });
  assert.equal(n, 1);
  assert.deepEqual(asked, [{ from: "小田原", to: "東京", day: "2026-09-19" }]);
  const items = itin.days[0].items;
  assert.equal(items[0].lastTrain, undefined, "行きに終電は要りません");
  assert.equal(items[1].lastTrain.departure, "22:58");
  assert.match(items[1].lastTrain.text, /4時間18分/);
});

test("聞けなかったときは、黙って空ける", async () => {
  const itin = itinOf();
  const n = await attachLastTrain(itin, async () => {
    throw new Error("429 断られました");
  });
  assert.equal(n, 0);
  for (const i of itin.days[0].items) assert.equal(i.lastTrain, undefined);
});

test("答えが空でも、黙って空ける", async () => {
  const itin = itinOf();
  assert.equal(await attachLastTrain(itin, async () => null), 0);
  assert.equal(await attachLastTrain(itin, async () => ({ routed: false })), 0);
  // 経路は返ったが時刻が読めない、も同じです。
  assert.equal(await attachLastTrain(itin, async () => ({ routed: true, meta: {} })), 0);
});

test("聞く回数に上限がある", async () => {
  // 旅程1本で Yahoo!へは何十回も聞きます。終電のために際限なく
  // 増やすと、肝心の経路のほうが回数制限に当たります。
  const days = Array.from({ length: 6 }, () => itinOf().days[0]);
  let n = 0;
  await attachLastTrain({ days }, async () => {
    n += 1;
    return { routed: true, meta: { departure: "22:58" } };
  }, { limit: 3 });
  assert.equal(n, 3);
});

test("聞く関数を渡さなければ、何もしない", async () => {
  assert.equal(await attachLastTrain(itinOf(), null), 0);
  assert.equal(await attachLastTrain(null, async () => ({})), 0);
});

// --- 中継が読む、本物の終電の画面 -------------------------------------------

const lastHtml = await readFile(
  new URL("./fixtures/yahoo-odawara-tokyo-last.html", import.meta.url), "utf8");

test("終電の画面から、候補を全部読める", () => {
  const rows = routeBlocks(lastHtml).map((b) => {
    const s = parseSummary(b);
    const d = parseRouteDetail(b);
    return { departure: s.departure, arrival: s.arrival,
             from: d.legs[0]?.from, to: d.legs.at(-1)?.to };
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.departure), ["22:58", "22:58", "22:56"]);
  assert.deepEqual(rows.map((r) => r.arrival), ["00:39", "00:43", "23:29"]);
  for (const r of rows) {
    assert.equal(r.from, "小田原");
    assert.equal(r.to, "東京");
  }
});

test("終電は「いちばん早く着く便」ではなく「いちばん遅く出る便」", () => {
  // 小田原→東京では 22:56 の新幹線が 23:29 に着き、いちばん早いです。
  // でも最後まで粘れるのは 22:58 のほうです。ここを取り違えると、
  // 「23:29に着けるから22:56が終電」という、2分早い嘘になります。
  const rows = routeBlocks(lastHtml).map((b) => parseSummary(b));
  const latest = rows.reduce((a, b) =>
    (lateMinutes(a.departure) >= lateMinutes(b.departure) ? a : b));
  const earliestArrival = rows.reduce((a, b) =>
    (lateMinutes(a.arrival) <= lateMinutes(b.arrival) ? a : b));
  assert.equal(latest.departure, "22:58");
  assert.equal(earliestArrival.departure, "22:56");
  assert.notEqual(latest.departure, earliestArrival.departure);
});
