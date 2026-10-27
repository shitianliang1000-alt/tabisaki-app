// 誰と行くかで、行ける場所は変わる。
//
// 旅程は「ふつうに歩ける大人ひとり」を前提に組まれていました。同じ
// 「城」でも、ベビーカーでは石段を上がれず、車椅子では天守に入れない
// ことがあります。それでも旅程には同じ「松江城 80分」と書かれ、当日に
// 現地で分かります。
//
// ここで確かめたいのは、**持っていないものを「対応しています」と
// 言わない**ことです。収録に段差も手すりも多目的トイレもありません。
// 持っているのは分類だけなので、できるのは3つです。
//
//   ① 分類から「歩くのがつらい場所」を見分ける
//   ② 選ぶときに後ろへ回す（外しはしません）
//   ③ 何がつらいかと、確かめ先を書く

import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPANIONS, accessAppeal, accessNote, attachAccess, hardnessOf,
  normalizeCompanions, walkLoadNote,
} from "../packages/core/src/access.js";

const spot = (name, category) => ({ id: name, name, category });

test("同行者は、足の話だけを持つ", () => {
  // 「子連れ」は食事の条件（meals.js の diet）が持ちます。
  assert.deepEqual(COMPANIONS.map((c) => c.id),
    ["stroller", "wheelchair", "senior"]);
  assert.deepEqual(normalizeCompanions(["stroller", "nope", "stroller"]),
    ["stroller"]);
  assert.deepEqual(normalizeCompanions(null), []);
});

test("分類から、足のつらさが分かる", () => {
  // 登る場所・砂の上・石段は高く、平らな屋内は低く。
  assert.ok(hardnessOf(spot("高尾山", "山")) > hardnessOf(spot("県立美術館", "美術館")));
  assert.ok(hardnessOf(spot("稲佐の浜", "海岸")) > 0.7);
  assert.ok(hardnessOf(spot("博物館", "博物館")) < 0.3);
  // 表に無い分類は、ふつう扱い。
  assert.equal(hardnessOf(spot("なにか", "知らない分類")), 0.45);
});

test("同行者がいなければ、何も書かない", () => {
  // 「歩きやすいです」とは言いません（確かめていないので）。
  assert.equal(accessNote(spot("松江城", "城"), []).hard, false);
  assert.equal(accessNote(spot("松江城", "城"), []).why, "");
});

test("つらい場所には、何がつらいかを書く", () => {
  const n = accessNote(spot("松江城", "城"), ["stroller"]);
  assert.equal(n.hard, true);
  assert.match(n.why, /石段/);
  assert.match(n.why, /ベビーカー/);
  // **確かめ先を必ず添えます。**
  assert.match(n.why, /公式サイトか電話/);
});

test("「行けません」とは言わない", () => {
  // 分類から分かるのは「そういう場所が多い」までで、その施設がどうかは
  // 知りません。断定すると、行けたはずの場所をあきらめさせます。
  for (const c of ["stroller", "wheelchair", "senior"]) {
    const n = accessNote(spot("松江城", "城"), [c]);
    assert.doesNotMatch(n.why, /行けません|入れません|不可/);
  }
});

test("平らな場所には、同行者がいても何も書かない", () => {
  assert.equal(accessNote(spot("県立美術館", "美術館"), ["wheelchair"]).hard,
    false);
});

test("選ぶときは、後ろへ回すだけ。消さない", () => {
  // 0 にすると、山のエリアで候補が全部消えます。
  const hard = accessAppeal(spot("高尾山", "山"), ["wheelchair"]);
  const flat = accessAppeal(spot("県立美術館", "美術館"), ["wheelchair"]);
  assert.ok(hard < flat, "つらい場所が後ろに回っていません");
  assert.ok(hard > 0, "消しています");
  // 同行者がいなければ、重みは動きません。
  assert.equal(accessAppeal(spot("高尾山", "山"), []), 0.5);
});

test("1日の歩行が長ければ、そう書く", () => {
  // 数えるのは移動での徒歩だけです（着いた先を歩く距離は誰も測って
  // いません）。だから「これだけしか歩きません」とは言いません。
  const note = walkLoadNote(3.2, ["wheelchair"]);
  assert.match(note, /3\.2km/);
  assert.match(note, /含まれていません/);
  // 短ければ、何も書きません。
  assert.equal(walkLoadNote(0.8, ["wheelchair"]), "");
  assert.equal(walkLoadNote(3.2, []), "");
});

test("旅程に書き足すのは、説明だけ", () => {
  const itin = {
    days: [{
      items: [
        { kind: "spot", place: spot("松江城", "城"),
          start: "2026-09-20T10:00", end: "2026-09-20T11:20" },
        { kind: "spot", place: spot("県立美術館", "美術館") },
        { kind: "transit", walk: true, km: 2.4 },
      ],
    }],
  };
  const before = itin.days[0].items[0].start;
  assert.equal(attachAccess(itin, ["stroller"]), 1);
  assert.match(itin.days[0].items[0].access.why, /石段/);
  assert.equal(itin.days[0].items[1].access, undefined);
  assert.match(itin.days[0].walkLoad, /2\.4km/);
  // 時刻は動かしません。
  assert.equal(itin.days[0].items[0].start, before);
  // 同行者がいなければ、何も足しません。
  const plain = { days: [{ items: [{ kind: "spot", place: spot("松江城", "城") }] }] };
  assert.equal(attachAccess(plain, []), 0);
  assert.equal(plain.days[0].items[0].access, undefined);
});
