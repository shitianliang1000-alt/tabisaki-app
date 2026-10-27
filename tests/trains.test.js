// 夜行列車を、旅程の区間として組み立てる。
//
// 「サンライズに乗って山陰へ」と書かれても、これまでは注意書きを添える
// だけでした。旅程そのものは朝いちの新幹線で組まれ、書いた人の希望が
// どこにも入りません。
//
// 夜行はふつうの区間とは違います。前の日の夜に乗って翌朝に着き、
// その晩の宿は要りません。そして毎日同じ時刻で走るので、表に書けます。
// Yahoo!路線情報は「いま出たら」で答えるので、夜行を狙うのには
// 向きません（朝10時に聞けば、新幹線が返ります）。

import assert from "node:assert/strict";
import test from "node:test";

import { NAMED_ROUTES, TIMETABLED, findTrains, nightTrainLeg }
  from "../packages/core/src/trains.js";

const TOKYO = { lat: 35.6812, lng: 139.7671, name: "東京駅" };
const IZUMO = { lat: 35.3661, lng: 132.7549, name: "出雲市" };
const TAKAMATSU = { lat: 34.3499, lng: 134.0466, name: "高松" };
const SAPPORO = { lat: 43.0686, lng: 141.3508, name: "札幌" };
const day = () => new Date("2026-09-12T10:00");

test("東京から出雲へは、サンライズ出雲で組む", () => {
  const leg = nightTrainLeg(TOKYO, IZUMO, day());
  assert.ok(leg, "夜行が組めていません");
  assert.equal(leg.train, "サンライズ出雲");
  assert.equal(leg.departure, "21:50");
  assert.equal(leg.arrival, "09:58");
  assert.equal(leg.overnight, true);
  assert.equal(leg.routed, true);
});

test("東京から高松へは、サンライズ瀬戸で組む", () => {
  const leg = nightTrainLeg(TOKYO, TAKAMATSU, day());
  assert.equal(leg?.train, "サンライズ瀬戸");
  assert.equal(leg.arrival, "07:27");
});

test("乗る時刻と着く時刻を、そのまま持つ", () => {
  // 夜行は「出発できる時刻＋所要時間」では着きません。
  // 10時に家を出ても、21:50発の列車は21:50発です。
  const leg = nightTrainLeg(TOKYO, IZUMO, day());
  assert.equal(leg.boardAt_.getHours(), 21);
  assert.equal(leg.boardAt_.getMinutes(), 50);
  assert.equal(leg.arriveAt.getHours(), 9);
  assert.equal(leg.arriveAt.getMinutes(), 58);
  // 着くのは翌日です。
  assert.equal(leg.arriveAt.getDate(), leg.boardAt_.getDate() + 1);
});

test("走っていない区間では、組まない", () => {
  assert.equal(nightTrainLeg(TOKYO, SAPPORO, day()), null,
    "北海道へ夜行があることにしています");
  // 逆向き（出雲から東京）は、この表には入れていません。
  assert.equal(nightTrainLeg(IZUMO, TOKYO, day()), null);
});

test("列車を名指しされたら、それだけを見る", () => {
  assert.equal(nightTrainLeg(TOKYO, IZUMO, day(), "sunrise-seto"), null,
    "瀬戸を指定されたのに出雲で組んでいます");
  assert.equal(
    nightTrainLeg(TOKYO, TAKAMATSU, day(), "sunrise-seto")?.train,
    "サンライズ瀬戸");
});

test("時刻まで収録するのは、いま定期で走っている夜行だけ", () => {
  // 臨時列車を混ぜると、走らない日に「乗れる」旅程が出ます。
  assert.equal(TIMETABLED.length, 2);
  for (const t of TIMETABLED) {
    assert.ok(t.stops.length >= 2);
    assert.ok(t.stops[0].depart, `${t.name} の始発に発時刻がありません`);
    assert.ok(t.stops.at(-1).arrive, `${t.name} の終着に着時刻がありません`);
  }
});

// --- 区間だけ収録している列車 -----------------------------------------------
//
// 「サフィール踊り子に乗りたい」と書かれても、列車の名前はどのエリア名とも
// 一致しないので、地名の指定が無いことになり、点の高い順に返っていました。
// 時刻は知らなくても、**どこへ向かう列車かは分かります。**

test("名前のある列車を、文から拾う", () => {
  assert.equal(findTrains("サフィールに乗りたい").named[0].name,
    "サフィール踊り子");
  assert.equal(findTrains("ゆふいんの森で由布院へ").named[0].id, "yufuin");
  assert.equal(findTrains("サンライズ出雲").timetabled, "sunrise-izumo");
  assert.deepEqual(findTrains("温泉でゆっくり"), { timetabled: null, named: [] });
});

test("時刻を書かない列車には、時刻を書かない", () => {
  // 運転日が限られるもの・季節運転のものに時刻を書くと、走らない日に
  // 「乗れる」旅程が出ます。書かなければ、少なくとも嘘は出ません。
  for (const t of NAMED_ROUTES) {
    assert.equal(t.stops, undefined,
      `${t.name} に時刻が書かれています`);
    assert.ok(t.note, `${t.name} に確かめかたが書かれていません`);
    assert.match(t.note, /ご確認ください/,
      `${t.name} の注意書きが、確かめかたになっていません`);
  }
});

test("乗ること自体が目的の列車は、行き先を寄せない", () => {
  // ななつ星・四季島・瑞風は数日かけて回るクルーズトレインで、
  // 数か月前の抽選申し込みが要ります。旅程に組み込めるものではないので、
  // 行き先だけ寄せると「九州へ行く旅」になってしまいます。
  const cruise = NAMED_ROUTES.filter((t) => t.bookable === false);
  assert.ok(cruise.length >= 3);
  for (const t of cruise) {
    assert.match(t.note, /抽選|申し込み/, `${t.name} に申し込みの話がありません`);
  }
});

test("向かう先は、収録のエリア名で書く", () => {
  // 「伊豆」ではなく「下田市」のように、収録と突き合う名前でないと
  // 行き先を寄せられません。
  for (const t of NAMED_ROUTES) {
    if (t.bookable === false) continue;
    assert.ok((t.toward ?? []).length >= 2,
      `${t.name} の行き先が足りません（1つだと収録に無いとき外します）`);
  }
});
