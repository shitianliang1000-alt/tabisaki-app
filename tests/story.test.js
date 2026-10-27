// 旅程に「意味づけ」の一文を付けるテスト。
//
//   09:30 鎌倉大仏 / 11:00 長谷寺 / 13:00 昼食 / 14:30 江ノ島
//
// だけでは、時刻表であって旅の説明ではありません。
//
//   朝は鎌倉の歴史から始まり、午後は海へ抜ける旅です。
//
// と書けると、この並びに意味があることが伝わります。
//
// **決まった文しか出しません。** 同じ旅程なら毎回同じ文になります。
// AIに書かせると、聞くたびに違う旅の説明が出てきます。

import assert from "node:assert/strict";
import test from "node:test";

import { storyFor } from "../packages/core/src/story.js";

const d = (s) => new Date(s);
const spot = (name, category, genres, over = {}) => ({
  id: name, name, category, genres, lat: 35.3, lng: 139.5,
  fame_tier: "known", ...over,
});
const at = (h, kind, place, over = {}) => ({
  kind, place, title: place?.name ?? kind,
  start: d(`2026-09-12T${h}:00`), end: d(`2026-09-12T${h}:50`), ...over,
});

test("朝と午後の性格が違えば、その流れを書く", () => {
  const itin = { days: [{ date: d("2026-09-12T09:00"), items: [
    at("09", "spot", spot("鎌倉大仏", "寺院", ["history"])),
    at("11", "spot", spot("長谷寺", "寺院", ["history"])),
    at("13", "meal", null, { title: "昼食" }),
    at("15", "spot", spot("江ノ島", "海岸", ["sea"])),
  ] }] };
  const s = storyFor(itin);
  assert.equal(s.length, 1);
  assert.match(s[0], /朝|午前/);
  assert.match(s[0], /午後/);
  assert.match(s[0], /歴史|寺/);
  assert.match(s[0], /海/);
});

test("同じ旅程なら、いつ呼んでも同じ文になる", () => {
  const itin = { days: [{ date: d("2026-09-12T09:00"), items: [
    at("09", "spot", spot("寺", "寺院", ["history"])),
    at("15", "spot", spot("海", "海岸", ["sea"])),
  ] }] };
  const a = storyFor(itin);
  for (let i = 0; i < 5; i++) assert.deepEqual(storyFor(itin), a);
});

test("夕方に眺めの場所があれば、そこで締める", () => {
  const itin = { days: [{ date: d("2026-09-12T09:00"), items: [
    at("10", "spot", spot("寺", "寺院", ["history"])),
    at("16", "spot", spot("展望台", "展望台", ["view"])),
  ] }] };
  assert.match(storyFor(itin)[0], /夕|最後|締め/);
});

test("1か所しかない日には、無理に流れを作らない", () => {
  const itin = { days: [{ date: d("2026-09-12T09:00"), items: [
    at("10", "spot", spot("寺", "寺院", ["history"])),
  ] }] };
  const s = storyFor(itin);
  assert.equal(s.length, 1);
  assert.match(s[0], /寺/);
  assert.ok(!/午後/.test(s[0]), `流れを作っています: ${s[0]}`);
});

test("日ごとに1文ずつ返す", () => {
  const day = (date, items) => ({ date: d(date), items });
  const itin = { days: [
    day("2026-09-12T09:00", [at("10", "spot", spot("寺", "寺院", ["history"]))]),
    day("2026-09-13T09:00", [at("10", "spot", spot("海", "海岸", ["sea"]))]),
  ] };
  assert.equal(storyFor(itin).length, 2);
});

test("立ち寄りが無い日は、飛ばす（空の文を作らない）", () => {
  const itin = { days: [
    { date: d("2026-09-12T09:00"), items: [] },
    { date: d("2026-09-13T09:00"),
      items: [at("10", "spot", spot("海", "海岸", ["sea"]))] },
  ] };
  const s = storyFor(itin);
  assert.equal(s.length, 1);
  assert.match(s[0], /海/);
});

test("空でも壊れない", () => {
  for (const bad of [null, undefined, {}, { days: [] }]) {
    assert.deepEqual(storyFor(bad), []);
  }
});
