// 移動そのものを、旅の一部にできているか。
//
// これまで移動は「目的地と目的地のあいだの時間」でした。所要時間と
// 乗換回数は出ますが、その道が・その路線がどんなところを走るのかは
// どこにも出ません。車で来ている人は、走ること自体を目的にしています。
//
// ここで確かめたいのは、**確かさの違いを保っていること**です。
//
//   路線  Yahoo!が実際の路線名を返します → 言い切ってよい
//   道    どの道を通るかは分かりません   → 寄り道の候補として出す
//
// そして、通れるかどうか（冬期閉鎖・通行止め）は**言いません**。
// 毎年変わるので、確かめ先へ渡します。

import assert from "node:assert/strict";
import test from "node:test";

import {
  SCENIC_LINES, SCENIC_ROADS, attachScenic, roadsNear, scenicLine,
} from "../packages/core/src/scenic.js";

test("乗る路線の名前から、その路線だと分かる", () => {
  // 調べた結果に書いてある名前に当てるだけです。推し量りません。
  assert.equal(scenicLine("ＪＲ五能線").name, "五能線");
  assert.equal(scenicLine("五能線（リゾートしらかみ）").name, "五能線");
  assert.equal(scenicLine("江ノ島電鉄線").name, "由比ヶ浜・江ノ電");
  assert.equal(scenicLine("ＪＲ山手線"), null);
  assert.equal(scenicLine(""), null);
  assert.equal(scenicLine(null), null);
});

test("路線の説明に、通れるかどうかを書いていない", () => {
  // 運休・災害・工事は毎年変わります。書けば、いつか嘘になります。
  for (const l of SCENIC_LINES) {
    assert.doesNotMatch(l.what, /必ず|確実に|いつでも乗れ/,
      `${l.name}: 言い切りすぎです`);
  }
});

test("近くの道は、区間の近くにあるものだけ", () => {
  // 角島大橋（山口県）の近く
  const a = { lat: 34.30, lng: 130.95 };
  const b = { lat: 34.20, lng: 131.10 };
  const near = roadsNear(a, b);
  assert.ok(near.some((r) => r.name.includes("角島")),
    `角島大橋が出ていません: ${near.map((r) => r.name).join("/")}`);
  // 北海道の道は出てこないこと。
  assert.ok(!near.some((r) => r.name.includes("知床")),
    "遠すぎる道が出ています");
});

test("街なかの短い移動では、寄り道の話をしない", () => {
  // 2kmの移動に「40km先に名前のある道があります」は、邪魔なだけです。
  const a = { lat: 34.30, lng: 130.95 };
  const b = { lat: 34.31, lng: 130.96 };
  assert.deepEqual(roadsNear(a, b), []);
});

test("1区間に、いくつも並べない", () => {
  // 3つも4つも並ぶと、どれも読まれません。
  const a = { lat: 33.0, lng: 131.1 };
  const b = { lat: 32.8, lng: 131.0 };
  assert.ok(roadsNear(a, b).length <= 2);
});

test("閉まりやすい時期は、そう書く。閉まっているとは言わない", () => {
  // 知床横断道路は冬期閉鎖です。ただし開通日は年ごとに違います。
  const a = { lat: 44.05, lng: 145.00 };
  const b = { lat: 44.15, lng: 145.20 };
  const winter = roadsNear(a, b, { month: 1 });
  const shiretoko = winter.find((r) => r.name.includes("知床"));
  assert.ok(shiretoko, "知床横断道路が出ていません");
  assert.match(shiretoko.note, /冬期閉鎖/);
  assert.match(shiretoko.note, /ご確認/);
  assert.doesNotMatch(shiretoko.note, /通れません|閉まっています/);
  // 夏はその断り書きが出ないこと。
  const summer = roadsNear(a, b, { month: 8 });
  assert.equal(summer.find((r) => r.name.includes("知床")).note, "");
});

test("道の説明に、走行時間や料金を書いていない", () => {
  // 実際の経路を引いていないので、出せません。
  for (const r of SCENIC_ROADS) {
    assert.doesNotMatch(r.what, /\d+\s*分|\d+\s*円|無料|有料道路料金/,
      `${r.name}: 持っていない数字を書いています`);
  }
});

test("旅程に書き足すのは、説明だけ", () => {
  const itin = {
    days: [{
      date: new Date("2026-01-15T09:00"),
      items: [
        { kind: "transit", detail: "ＪＲ五能線・約40分", walk: false,
          start: new Date("2026-01-15T09:00"),
          end: new Date("2026-01-15T09:40") },
        { kind: "spot", title: "どこか" },
        // 歩く区間には付けません。
        { kind: "transit", walk: true, detail: "徒歩約8分" },
      ],
    }],
  };
  const before = JSON.stringify(itin.days[0].items[0].start);
  const n = attachScenic(itin, { transport: "transit" });
  assert.equal(n, 1);
  assert.equal(itin.days[0].items[0].scenic.kind, "line");
  assert.equal(itin.days[0].items[0].scenic.name, "五能線");
  assert.equal(itin.days[0].items[2].scenic, undefined, "歩く区間に付いています");
  // 時刻は動かしません。
  assert.equal(JSON.stringify(itin.days[0].items[0].start), before);
});

test("車の区間には、近くの道を候補として付ける", () => {
  const itin = {
    days: [{
      date: new Date("2026-08-10T09:00"),
      items: [{
        kind: "transit", drive: true, walk: false, detail: "移動約90分",
        from: { lat: 34.30, lng: 130.95 }, to: { lat: 34.20, lng: 131.10 },
        start: new Date("2026-08-10T09:00"),
        end: new Date("2026-08-10T10:30"),
      }],
    }],
  };
  assert.equal(attachScenic(itin, { transport: "car" }), 1);
  const sc = itin.days[0].items[0].scenic;
  assert.equal(sc.kind, "road");
  assert.ok(sc.roads.length > 0);
  assert.ok(Number.isFinite(sc.roads[0].km));
});
