// 駄目だったときの代わりを、1か所だけ決めておくテスト。
//
// 現地で困るのは「雨だった」「休館だった」そのものより、**その場で
// 代わりを探すことになる**ほうです。電波の弱い場所で地図を開き、
// 開いているかも分からない店を見比べることになります。
//
// なので出発前に1つだけ決めます。ここで確かめたいのは3つです。
//   ・近いものしか出さない（40km先の美術館は代わりになりません）
//   ・心当たりのない場所には、何も付けない（言わないほうが親切です）
//   ・休館の代わりには、休館のない場所を選ぶ

import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKUP_MAX_KM, attachBackups, distanceText, pickBackup, risksOf,
} from "../packages/core/src/backup.js";

const d = (s) => new Date(s);

/** 緯度をずらして距離を作ります（緯度1度 ≒ 111km）。 */
const at = (km) => 33.84 + km / 111;

const spot = (id, name, category, over = {}) => ({
  id, name, category, lat: 33.84, lng: 132.76,
  genres: [], description: `${name}です。`, fame_tier: "known", ...over,
});

// 2026-09-12 は土曜。美術館の「月曜休館が多い」には当たりません。
const SAT = d("2026-09-12T10:00");
// 2026-09-14 は月曜。
const MON = d("2026-09-14T10:00");

test("屋外のスポットは、雨で行けなくなる心当たりがある", () => {
  assert.equal(risksOf(spot("s", "桂浜", "海岸"), SAT).rain, true);
  assert.equal(risksOf(spot("s", "県立美術館", "美術館"), SAT).rain, false);
});

test("いつでも入れる場所に、休館の心当たりは付けない", () => {
  // 海岸は 0-24 時。閉まることがないので、休館の話をしません。
  assert.equal(risksOf(spot("s", "桂浜", "海岸"), SAT).closed, false);
  // 美術館は分類の目安時間しか分かっていないので、心当たりありです。
  assert.equal(risksOf(spot("s", "県立美術館", "美術館"), SAT).closed, true);
});

test("月曜の美術館は、休館の心当たりが強い", () => {
  assert.equal(risksOf(spot("s", "県立美術館", "美術館"), MON).closed, true);
});

test("雨の代わりには、近くの屋内を選ぶ", () => {
  const near = spot("in", "県立美術館", "美術館", { lat: at(1.5) });
  const far = spot("far", "市立博物館", "博物館", { lat: at(40) });
  const alt = pickBackup(spot("s", "桂浜", "海岸"), [far, near], { date: SAT });
  assert.equal(alt.id, "in");
  assert.match(alt.text, /雨なら/);
  assert.match(alt.text, /県立美術館/);
});

test("遠すぎる代わりは出さない", () => {
  const far = spot("far", "市立博物館", "博物館", { lat: at(BACKUP_MAX_KM + 3) });
  assert.equal(pickBackup(spot("s", "桂浜", "海岸"), [far], { date: SAT }), null);
});

test("車なら、もう少し広く見る", () => {
  const far = spot("far", "市立博物館", "博物館", { lat: at(BACKUP_MAX_KM + 3) });
  const alt = pickBackup(spot("s", "桂浜", "海岸"), [far],
                         { date: SAT, maxKm: 15 });
  assert.equal(alt.id, "far");
});

test("休館の代わりには、休館のない場所を選ぶ", () => {
  // 美術館の代わりに別の美術館を出しても、そちらも休みかもしれません。
  const museum = spot("m2", "市立美術館", "美術館", { lat: at(0.5) });
  const shrine = spot("j", "伊佐爾波神社", "神社", { lat: at(1.2) });
  const alt = pickBackup(spot("s", "県立美術館", "美術館"),
                         [museum, shrine], { date: MON });
  assert.equal(alt.id, "j");
  assert.match(alt.text, /閉まっていたら/);
});

test("その日が休みの場所は、代わりにならない", () => {
  const closed = spot("c", "休みの館", "美術館", {
    lat: at(0.3), hours: { closedDays: [1] },
  });
  const shrine = spot("j", "神社", "神社", { lat: at(2) });
  const alt = pickBackup(spot("s", "県立美術館", "美術館"),
                         [closed, shrine], { date: MON });
  assert.equal(alt.id, "j");
});

test("心当たりのない場所には、何も付けない", () => {
  // 飲食店は屋内で、いつでも入れる扱いでもないが……
  const s = spot("s", "道後温泉本館", "温泉");
  const risks = risksOf(s, SAT);
  if (!risks.rain && !risks.closed) {
    assert.equal(pickBackup(s, [spot("o", "他", "美術館", { lat: at(1) })],
                            { date: SAT }), null);
  }
});

test("距離の書き方は、歩けるかどうかが分かる形", () => {
  assert.equal(distanceText(0.4), "約400m");
  assert.equal(distanceText(1.25), "約1.3km");
  assert.equal(distanceText(12.4), "約12km");
  assert.equal(distanceText(NaN), "");
});

test("旅程の各スポットに、代わりを1つずつ付ける", () => {
  const itin = {
    transport: "any",
    days: [{ date: SAT, items: [
      { id: "a", kind: "spot", spotId: "s1", start: SAT,
        title: "桂浜", place: spot("s1", "桂浜", "海岸") },
      { id: "b", kind: "spot", spotId: "s2", start: SAT,
        title: "五色浜", place: spot("s2", "五色浜", "海岸", { lat: at(1) }) },
      { id: "t", kind: "transit", start: SAT },
    ] }],
  };
  const pool = [
    spot("in1", "県立美術館", "美術館", { lat: at(0.8) }),
    spot("in2", "市立博物館", "博物館", { lat: at(1.4) }),
    // 旅程に入っている場所は、代わりにしません
    itin.days[0].items[0].place,
  ];
  const n = attachBackups(itin, pool);
  assert.equal(n, 2);
  const [a, b] = itin.days[0].items;
  assert.ok(a.backup && b.backup);
  // 同じ日のなかで同じ代わりを使い回しません
  assert.notEqual(a.backup.id, b.backup.id);
  // 移動には何も付きません
  assert.equal(itin.days[0].items[2].backup, undefined);
});

test("候補が無ければ、何も起きない", () => {
  const itin = { days: [{ date: SAT, items: [
    { id: "a", kind: "spot", start: SAT, place: spot("s1", "桂浜", "海岸") },
  ] }] };
  assert.equal(attachBackups(itin, []), 0);
  assert.equal(itin.days[0].items[0].backup, undefined);
});

test("代わりは、画面に出すぶんだけを持つ（保存した旅程を太らせない）", () => {
  const alt = pickBackup(spot("s", "桂浜", "海岸"),
    [spot("in", "県立美術館", "美術館", { lat: at(1) })], { date: SAT });
  assert.deepEqual(Object.keys(alt).sort(),
    ["category", "id", "km", "lat", "lng", "name", "text", "why"]);
});
