// 天気を取ってくるテスト。
//
// 「雨なら屋内へ」をやるには、まず雨が降るかどうかを知る必要があります。
// Open-Meteo（キー不要・CORS可・非商用無料）から、時間ごとの降水確率と
// 気温だけをもらいます。
//
// 気をつけたのは3つ。
//   ・取れなくても旅程は出す（天気は旅程の本体ではない）
//   ・予報の効く範囲を超えたら、その旨を返して呼ばない
//   ・同じ日・同じ場所を何度も取りに行かない

import assert from "node:assert/strict";
import test from "node:test";

import { forecastFor, hourly, rainAt, summarizeDay } from "../packages/core/src/weather.js";

function store() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v),
           removeItem: (k) => m.delete(k) };
}

/** 1日ぶんの応答を作ります（09時から18時まで）。 */
function body(rainByHour = {}, tempByHour = {}) {
  const time = [], precipitation_probability = [], temperature_2m = [],
        weather_code = [];
  for (let h = 0; h < 24; h++) {
    time.push(`2026-09-12T${String(h).padStart(2, "0")}:00`);
    precipitation_probability.push(rainByHour[h] ?? 0);
    temperature_2m.push(tempByHour[h] ?? 22);
    weather_code.push((rainByHour[h] ?? 0) >= 60 ? 61 : 1);
  }
  return { hourly: { time, precipitation_probability, temperature_2m,
                     weather_code } };
}

function fakeFetch(doc, status = 200) {
  const calls = [];
  return { calls, fn: async (url) => {
    calls.push(url);
    return { ok: status < 400, status, json: async () => doc };
  } };
}

const AT = { lat: 33.8416, lng: 132.7657 };
const DAY = new Date("2026-09-12T09:00");
const NOW = new Date("2026-09-10T08:00");

test("時間ごとの降水確率と気温を取れる", async () => {
  const f = fakeFetch(body({ 14: 80, 15: 90 }));
  const w = await forecastFor(AT, DAY,
    { fetchImpl: f.fn, storage: store(), now: NOW });
  assert.equal(w.ok, true);
  assert.equal(rainAt(w, new Date("2026-09-12T14:30")), 80);
  assert.equal(rainAt(w, new Date("2026-09-12T09:00")), 0);
  assert.match(f.calls[0], /api\.open-meteo\.com/);
  assert.match(f.calls[0], /latitude=33\.84/);
  assert.match(f.calls[0], /precipitation_probability/);
});

test("同じ日・同じ場所は、二度取りに行かない", async () => {
  const f = fakeFetch(body());
  const st = store();
  const opts = { fetchImpl: f.fn, storage: st, now: NOW };
  await forecastFor(AT, DAY, opts);
  await forecastFor(AT, DAY, opts);
  await forecastFor({ lat: 33.8417, lng: 132.7658 }, DAY, opts);  // ほぼ同じ場所
  assert.equal(f.calls.length, 1, `${f.calls.length}回 取りに行っています`);
});

test("予報の効かない先の日付は、呼ばずに「分からない」と返す", async () => {
  const f = fakeFetch(body());
  const w = await forecastFor(AT, new Date("2027-06-01T09:00"),
    { fetchImpl: f.fn, storage: store(), now: NOW });
  assert.equal(w.ok, false);
  assert.equal(f.calls.length, 0, "予報の無い日付に問い合わせています");
  assert.match(w.reason, /先/);
});

test("通信が失敗しても、旅程は出せる（例外を投げない）", async () => {
  const boom = async () => { throw new Error("つながりません"); };
  const w = await forecastFor(AT, DAY,
    { fetchImpl: boom, storage: store(), now: NOW });
  assert.equal(w.ok, false);
  assert.ok(w.reason);
});

test("応答が壊れていても、落ちない", async () => {
  for (const doc of [null, {}, { hourly: null }, { hourly: { time: null } }]) {
    const f = fakeFetch(doc);
    const w = await forecastFor(AT, DAY,
      { fetchImpl: f.fn, storage: store(), now: NOW });
    assert.equal(w.ok, false);
  }
});

test("その日の見どころを一文にする", async () => {
  const f = fakeFetch(body({ 13: 70, 14: 85, 15: 80 }, { 13: 26 }));
  const w = await forecastFor(AT, DAY,
    { fetchImpl: f.fn, storage: store(), now: NOW });
  const s = summarizeDay(w);
  assert.match(s, /雨/);
  assert.match(s, /13|14/);
});

test("降らない日は、雨の話をしない", async () => {
  const f = fakeFetch(body());
  const w = await forecastFor(AT, DAY,
    { fetchImpl: f.fn, storage: store(), now: NOW });
  assert.ok(!/雨/.test(summarizeDay(w)));
});

test("時間の一覧を、そのまま取り出せる", async () => {
  const f = fakeFetch(body({ 10: 30 }));
  const w = await forecastFor(AT, DAY,
    { fetchImpl: f.fn, storage: store(), now: NOW });
  const rows = hourly(w);
  assert.equal(rows.length, 24);
  assert.equal(rows[10].rain, 30);
  assert.ok(rows[10].at instanceof Date);
});
