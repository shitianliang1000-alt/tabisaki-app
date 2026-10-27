// 拠点を移す区間が、いつも「目安」になっていた。
//
// 3日の旅の3日目に、こう出ていました。
//
//   9:00  京都駅 → 祇園四条駅    拠点を移します・約16分 ［目安］
//
// ほかの区間には「時刻表」の印が付いているのに、拠点を移す行だけが
// 必ず目安です。区間ごとに Yahoo!へ聞いているのに、です。
//
// 原因は、**聞いた組と、出す組が違っていた**ことでした。
// 調べる連なり（chainOf）は、こう並んでいました。
//
//   … → 前日最後の立ち寄り → 新しい拠点の駅 → …
//
// 聞いたのは「立ち寄り → 駅」です。ところが旅程に出る行は
// 「駅 → 駅」です。引くときの鍵が合わないので、必ず空振りしました。
//
// 連なりに**前の拠点の駅**を挟みます。

import assert from "node:assert/strict";
import test from "node:test";

import { chainOf } from "../packages/core/src/pipeline.js";

const at = (n, lat) => ({ name: n, lat, lng: 135 });
const KYOTO = at("京都駅", 35.0);
const GION = at("祇園四条駅", 35.1);
const TOKYO = at("東京駅", 35.68);

function visit(day, name, lat, d) {
  return { day, spot: at(name, lat),
           arrive: new Date(`${d}T10:00`), travel: 20, wait: 0,
           end: new Date(`${d}T11:00`) };
}

const trip = { origin: TOKYO, departAt: new Date("2026-09-16T09:00") };
const ctx = { end: TOKYO };

test("拠点を移す区間が、駅から駅として連なりに入る", () => {
  const stays = [{ station: KYOTO, dayFrom: 0 },
                 { station: GION, dayFrom: 2 }];
  const visits = [
    visit(0, "清水寺", 35.01, "2026-09-16"),
    visit(1, "金閣寺", 35.02, "2026-09-17"),
    visit(2, "祇園白川", 35.11, "2026-09-18"),
  ];
  const { points } = chainOf(visits, ctx, trip, stays);
  const names = points.map((p) => p.name);
  const at2 = names.findIndex((n, i) =>
    n === "京都駅" && names[i + 1] === "祇園四条駅");
  assert.ok(at2 >= 0,
    `拠点の移動が駅から駅になっていません: ${names.join(" → ")}`);
});

test("時刻の数は、区間の数と合っている", () => {
  // times は「その区間に出発する時刻」なので、点より1つ少ないはずです。
  // ここがずれると、調べる時刻が1区間ぶん後ろへずれます。
  const stays = [{ station: KYOTO, dayFrom: 0 }, { station: GION, dayFrom: 2 }];
  const visits = [
    visit(0, "清水寺", 35.01, "2026-09-16"),
    visit(2, "祇園白川", 35.11, "2026-09-18"),
  ];
  const { points, times, kinds } = chainOf(visits, ctx, trip, stays);
  assert.equal(times.length, points.length - 1);
  assert.equal(kinds.length, points.length);
});

test("拠点を移す2つの点は、どちらも駅として印が付く", () => {
  // 電車＋現地の車の旅では、この印で「電車で聞く区間」を決めます。
  // 立ち寄り扱いのままだと、拠点の移動を車で聞くことになります。
  const stays = [{ station: KYOTO, dayFrom: 0 }, { station: GION, dayFrom: 2 }];
  const visits = [
    visit(0, "清水寺", 35.01, "2026-09-16"),
    visit(2, "祇園白川", 35.11, "2026-09-18"),
  ];
  const { points, kinds } = chainOf(visits, ctx, trip, stays);
  const i = points.map((p) => p.name).indexOf("祇園四条駅");
  assert.equal(kinds[i], "station");
  assert.equal(kinds[i - 1], "station");
});

test("立ち寄りの無い日をまたいでも、二重に挟まない", () => {
  // 前の点がすでにその駅なら、同じ駅を2つ並べません
  //（「京都駅 → 京都駅」の区間ができます）。
  const stays = [{ station: KYOTO, dayFrom: 0 }, { station: GION, dayFrom: 1 }];
  const visits = [visit(1, "祇園白川", 35.11, "2026-09-17")];
  const { points } = chainOf(visits, ctx, trip, stays);
  const names = points.map((p) => p.name);
  assert.deepEqual(names, ["東京駅", "京都駅", "祇園四条駅", "祇園白川", "東京駅"],
    names.join(" → "));
});

test("拠点が変わらない旅では、連なりは増えない", () => {
  const stays = [{ station: KYOTO, dayFrom: 0 }];
  const visits = [
    visit(0, "清水寺", 35.01, "2026-09-16"),
    visit(1, "金閣寺", 35.02, "2026-09-17"),
  ];
  const { points } = chainOf(visits, ctx, trip, stays);
  assert.deepEqual(points.map((p) => p.name),
    ["東京駅", "京都駅", "清水寺", "金閣寺", "東京駅"]);
});

test("拠点が3つでも、それぞれ駅から駅で入る", () => {
  const NARA = at("奈良駅", 34.7);
  const stays = [{ station: KYOTO, dayFrom: 0 }, { station: GION, dayFrom: 1 },
                 { station: NARA, dayFrom: 2 }];
  const visits = [
    visit(0, "清水寺", 35.01, "2026-09-16"),
    visit(1, "祇園白川", 35.11, "2026-09-17"),
    visit(2, "東大寺", 34.71, "2026-09-18"),
  ];
  const names = chainOf(visits, ctx, trip, stays).points.map((p) => p.name);
  // 駅は連なりに2度出てくるので（泊まって、翌朝そこから移る）、
  // 「どこかに隣り合わせで出てくるか」で見ます。
  const pair = (a, b) => names.some((n, i) => n === a && names[i + 1] === b);
  assert.ok(pair("京都駅", "祇園四条駅"), names.join(" → "));
  assert.ok(pair("祇園四条駅", "奈良駅"), names.join(" → "));
});
