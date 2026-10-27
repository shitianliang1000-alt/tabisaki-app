// 16日より先の旅に、その時期の「ふつう」を出す。
//
// 天気予報は16日先までです。ところが旅程は、宿を取る都合で1か月も
// 2か月も先に組みます。その旅について、画面は天気の話をいっさい
// しませんでした。正しいのですが、これだけでは持ち物も決められません。
//
// ここで確かめたいのは、**嘘の数字を出さないこと**です。
//
//   ・**予報ではないこと**が、必ず文に書いてある
//   ・形が少しでも違えば null。0 で埋めたり、片方の数字だけで
//     平均を出したりしない
//   ・予報の出る範囲では、そもそも呼ばない

import assert from "node:assert/strict";
import test from "node:test";

import {
  NORMALS_YEARS, RAIN_MM, WINDOW_DAYS, describeNormals, normalsFor,
  normalsUrl, parseNormals,
} from "../packages/core/src/normals.js";

const AT = { lat: 35.4020, lng: 132.6857 };
const NOW = new Date("2026-09-18T12:00:00");
const FAR = new Date("2026-11-20T09:00:00");

/**
 * 過去の観測の代わり。
 *
 * Open-Meteo の envelope（daily: { time, temperature_2m_max, … }）は、
 * 予報の側で実際の応答を見て確かめた形です。
 */
function archive({ years = NORMALS_YEARS, month = 11, day = 20,
                   tmax = (y, i) => 15 + i, tmin = () => 6,
                   rain = (y, i) => (i % 3 === 0 ? 4 : 0) } = {}) {
  const time = [];
  const a = [];
  const b = [];
  const r = [];
  for (let k = 0; k < years; k++) {
    const y = 2025 - k;
    // 前後5日ぶん置きます（窓は前後3日なので、外も混ぜて試します）。
    for (let i = -5; i <= 5; i++) {
      const d = new Date(y, month - 1, day + i);
      time.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
        + `-${String(d.getDate()).padStart(2, "0")}`);
      a.push(tmax(y, i));
      b.push(tmin(y, i));
      r.push(rain(y, i));
    }
  }
  return { daily: { time, temperature_2m_max: a, temperature_2m_min: b,
                    precipitation_sum: r } };
}

// --- 聞きにいく先 -----------------------------------------------------------

test("10年ぶんを、1回で聞く", () => {
  // 年ごとに10回聞くと、相手の1日の上限をこちらだけで使い切ります。
  const u = normalsUrl(AT, FAR, { now: NOW });
  assert.match(u, /^https:\/\/archive-api\.open-meteo\.com\//);
  const q = new URL(u).searchParams;
  // 今年は途中までしか無いので、去年まで。
  assert.equal(q.get("end_date"), "2025-12-31");
  assert.equal(q.get("start_date"), `${2025 - NORMALS_YEARS + 1}-01-01`);
  assert.equal(q.get("daily"),
    "temperature_2m_max,temperature_2m_min,precipitation_sum");
  assert.equal(q.get("timezone"), "Asia/Tokyo");
});

// --- 読み取り ---------------------------------------------------------------

test("同じころの日だけを集めて、平均する", () => {
  const n = parseNormals(archive(), FAR);
  // 前後3日 × 7日 × 10年 = 70日
  assert.equal(n.samples, (WINDOW_DAYS * 2 + 1) * NORMALS_YEARS);
  assert.equal(n.years, NORMALS_YEARS);
  // tmax は 15 + i（i は -3〜3）なので、平均は 15。
  assert.equal(n.tmaxMean, 15);
  assert.equal(n.tmaxLo, 12);
  assert.equal(n.tmaxHi, 18);
  assert.equal(n.tminMean, 6);
});

test("窓の外の日は、混ぜない", () => {
  // 前後5日ぶん置いた見本のうち、±4, ±5 は入りません。入っていると、
  // 平均も幅もずれます。
  const n = parseNormals(archive(), FAR);
  assert.equal(n.tmaxLo, 12, "窓の外（15-5=10）が混ざっています");
  assert.equal(n.tmaxHi, 18, "窓の外（15+5=20）が混ざっています");
});

test("雨は、降った日の数と割合で出す", () => {
  // 3日に1度 4mm 降る見本。
  const n = parseNormals(archive(), FAR);
  assert.ok(n.rainDays > 0);
  assert.equal(n.rainRate, Math.round((n.rainDays / n.samples) * 100));
  // 1mm 未満は「降った日」に数えません。
  const dry = parseNormals(archive({ rain: () => RAIN_MM - 0.1 }), FAR);
  assert.equal(dry.rainDays, 0);
  assert.equal(dry.rainRate, 0);
});

test("欠測の日は、0℃として数えない", () => {
  // null を 0 として混ぜると、平均が下がります。実際の観測には
  // 欠測があります。
  const doc = archive();
  // 見本は i = -5 から並べているので、窓の中（i = 0）は 6 番目です。
  doc.daily.temperature_2m_max[5] = null;
  doc.daily.temperature_2m_min[5] = null;
  const n = parseNormals(doc, FAR);
  assert.ok(n.tmaxMean > 10, `欠測に引きずられています: ${n.tmaxMean}`);
  assert.equal(n.samples, (WINDOW_DAYS * 2 + 1) * NORMALS_YEARS - 1);
});

test("形が違えば、null（0 で埋めない）", () => {
  const good = archive();
  for (const bad of [
    null, {}, { daily: {} },
    { daily: { time: [], temperature_2m_max: [], temperature_2m_min: [],
               precipitation_sum: [] } },
    // 列の長さが合わない（読み違えると、別の日の数字を混ぜます）
    { daily: { ...good.daily,
               temperature_2m_max: good.daily.temperature_2m_max.slice(1) } },
    // 列が足りない
    { daily: { time: good.daily.time,
               temperature_2m_max: good.daily.temperature_2m_max } },
  ]) {
    assert.equal(parseNormals(bad, FAR), null,
      `読めてしまいます: ${JSON.stringify(bad).slice(0, 60)}`);
  }
});

test("数えられた日が少なすぎるときは、平均と呼ばない", () => {
  // 2年ぶんしか無ければ、窓に入るのは14日です。
  const n = parseNormals(archive({ years: 1 }), FAR);
  assert.equal(n, null, "7日で平年値を名乗っています");
  assert.ok(parseNormals(archive({ years: 2 }), FAR));
});

test("年末年始でも、前後がつながる", () => {
  // 1月2日の旅に、前の年の12月30日を混ぜられること。
  const doc = archive({ month: 1, day: 2 });
  const n = parseNormals(doc, new Date("2027-01-02T09:00:00"));
  assert.ok(n, "年をまたぐと数えられません");
  assert.equal(n.samples, (WINDOW_DAYS * 2 + 1) * NORMALS_YEARS);
});

// --- 書きかた ---------------------------------------------------------------

test("予報ではないことが、必ず書いてある", () => {
  // ここを落とすと「11月20日は15℃」と読まれます。そう読まれたら、
  // この機能は無いほうがましです。
  const t = describeNormals(parseNormals(archive(), FAR), FAR);
  assert.match(t, /予報ではなく/);
  assert.match(t, /過去の観測の平均/);
  assert.match(t, /16日先までしか出ません/);
  assert.match(t, /その年によって上下します/);
});

test("幅も書く。平均だけでは持ち物が決まらない", () => {
  const t = describeNormals(parseNormals(archive(), FAR), FAR);
  assert.match(t, /最高 15℃/);
  assert.match(t, /最低 6℃/);
  assert.match(t, /12〜18℃ の幅/);
  assert.match(t, /11月20日ごろ/);
  assert.match(t, /過去10年/);
});

test("何も無ければ、何も書かない", () => {
  assert.equal(describeNormals(null, FAR), "");
});

// --- 取りにいく -------------------------------------------------------------

function fakeStore(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

const okFetch = (doc = archive()) => async () => ({ ok: true,
  json: async () => doc });

test("予報の出る範囲では、そもそも聞かない", async () => {
  // 予報があるのに平均を出すのは、粗いほうの数字を見せることです。
  let called = 0;
  const near = new Date("2026-09-25T09:00:00");
  const r = await normalsFor(AT, near, {
    now: NOW, storage: fakeStore(),
    fetchImpl: async () => { called += 1; return { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(called, 0);
  assert.match(r.reason, /予報/);
});

test("先の日付なら、聞いて文を返す", async () => {
  const store = fakeStore();
  const r = await normalsFor(AT, FAR, { now: NOW, storage: store,
                                        fetchImpl: okFetch() });
  assert.equal(r.ok, true);
  assert.match(r.text, /予報ではなく/);
  assert.equal(r.value.years, NORMALS_YEARS);
  assert.ok(store.size() > 0, "保存されていません");
});

test("二度目は、聞きにいかない", async () => {
  // 平年値は変わりません（去年までの観測です）。取り直しても同じ
  // 答えなのに毎回聞くのは、相手にも失礼です。
  const store = fakeStore();
  let called = 0;
  const send = async () => { called += 1; return { ok: true,
    json: async () => archive() }; };
  await normalsFor(AT, FAR, { now: NOW, storage: store, fetchImpl: send });
  await normalsFor(AT, FAR, { now: NOW, storage: store, fetchImpl: send });
  assert.equal(called, 1);
});

test("取れなくても、旅程は止めない", async () => {
  for (const send of [
    async () => ({ ok: false, status: 429 }),
    async () => { throw new Error("つながりません"); },
    async () => ({ ok: true, json: async () => ({ daily: {} }) }),
  ]) {
    const r = await normalsFor(AT, FAR, { now: NOW, storage: fakeStore(),
                                          fetchImpl: send });
    assert.equal(r.ok, false);
    assert.ok(r.reason, "理由が空です");
    // **数字は返しません。**
    assert.equal(r.value, undefined);
    assert.equal(r.text, undefined);
  }
});

test("場所や日付が壊れていても、落ちない", async () => {
  for (const [at, date] of [[null, FAR], [{ lat: "あ", lng: 1 }, FAR],
                            [AT, null], [AT, new Date("なんとか")]]) {
    const r = await normalsFor(at, date, { now: NOW, storage: fakeStore(),
                                           fetchImpl: okFetch() });
    assert.equal(r.ok, false);
  }
});
