// 旅の模擬実行（tabisaki simulate）と、天気での組み直し（tabisaki replan --weather-check）の試験。
// 外へは通信しません（天気は mock か、にせの fetch で確かめます）。

process.env.TZ = "Asia/Tokyo";

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulateOnce, simulateMany, slack, checkMoves, parseRatio, prng, hm } from "../packages/journey/simulate.mjs";
import { guardedFetch, fileStorage, decide, outPathFor, useWeather, weatherReplan, loadState, saveState, WEATHER_HOST } from "../packages/journey/replan.mjs";
import { parseJourney } from "../packages/journey/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "packages/cli/bin/tabisaki-plan.mjs");
const SAMPLE = path.join(ROOT, "examples/trips/hakone.yaml");
const tmp = mkdtempSync(path.join(tmpdir(), "tabisaki-simulate-"));
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], {
  encoding: "utf8", cwd: tmp, env: { ...process.env, TZ: "UTC", TABISAKI_HOME: path.join(tmp, "home"), TABISAKI_PLUGINS: "0" },
});
const write = (name, text) => { const f = path.join(tmp, name); writeFileSync(f, text); return f; };

// ---- 手で作った小さな旅程（2026-11-07 は土曜） ----

const t = (h, m = 0, day = 7) => new Date(`2026-11-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`);
const museum = { id: "m1", name: "試験の美術館", category: "美術館", lat: 35.24, lng: 139.02, hours: { open: 10, close: 17, lastEntry: 16.5, closedDays: [2] } };
const park = { id: "p1", name: "試験の公園", category: "公園", lat: 35.25, lng: 139.03, hours: { open: 0, close: 24 } };
const trip = () => ({
  days: [{
    date: t(0),
    items: [
      { id: "a", kind: "transit", title: "駅 → 美術館", start: t(9), end: t(10) },
      { id: "b", kind: "spot", title: museum.name, spotId: "m1", place: museum, start: t(10), end: t(11, 30) },
      { id: "c", kind: "meal", title: "昼食", start: t(11, 30), end: t(12, 30) },
      { id: "d", kind: "transit", title: "公園へ移動", start: t(12, 30), end: t(13) },
      { id: "e", kind: "spot", title: park.name, spotId: "p1", place: park, start: t(13), end: t(14) },
      { id: "f", kind: "free", title: "自由時間", start: t(14), end: t(14, 30) },
      { id: "g", kind: "transit", title: "公園 → 駅", start: t(14, 30), end: t(15, 30) },
    ],
  }],
});
const request = { arriveBy: t(16) };

test("simulate: 遅れなしなら、予定どおりにたどって成り立つ", () => {
  const r = simulateOnce(trip(), request);
  assert.equal(r.ok, true);
  assert.equal(hm(r.returnAt), "15:30");
  assert.equal(r.overMin, -30);
  assert.deepEqual(r.days[0].rows.map((x) => x.lateMin), [0, 0, 0, 0, 0, 0, 0]);
});

test("simulate: 移動が遅れると後ろへずれ、自由時間が遅れを吸い、期限を過ぎたら成り立たない", () => {
  const r = simulateOnce(trip(), request, { delay: 0.2 });
  // 60分 → 72分、30分 → 36分。自由時間（30分）が 18分の遅れを吸います
  assert.equal(hm(r.days[0].rows[0].end), "10:12");
  assert.equal(hm(r.days[0].rows[4].end), "14:18");
  assert.equal(hm(r.days[0].rows[5].end), "14:30");
  assert.equal(hm(r.returnAt), "15:42");
  assert.equal(r.ok, true);
  const bad = simulateOnce(trip(), request, { delay: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.at(-1).kind, "late_return");
  assert.match(bad.problems.at(-1).message, /過ぎます/);
});

test("simulate: 予定より早くは動かない（短くなっても、次は予定の時刻から）", () => {
  const r = simulateOnce(trip(), request, { delay: -0.5 });
  assert.equal(hm(r.days[0].rows[0].end), "09:30");
  assert.equal(hm(r.days[0].rows[1].start), "10:00");
  assert.equal(hm(r.returnAt), "15:00");
});

test("simulate: 開く前は待ち、最終入場を過ぎたら入れず、閉まる時刻で切り上げる", () => {
  const early = trip();
  early.days[0].items[0] = { ...early.days[0].items[0], start: t(8), end: t(9) };
  early.days[0].items[1] = { ...early.days[0].items[1], start: t(9), end: t(10, 30) };
  const w = simulateOnce(early, request).days[0].rows[1];
  assert.equal(w.waitMin, 60);
  assert.equal(hm(w.enter), "10:00");

  const late = simulateOnce(trip(), request, { late: 400 });
  assert.equal(late.problems[0].kind, "missed");
  assert.match(late.problems[0].message, /最終入場 16:30/);

  const cut = trip();
  cut.days[0].items[1] = { ...cut.days[0].items[1], start: t(16), end: t(17, 30) };
  cut.days[0].items = cut.days[0].items.slice(0, 2);
  const c = simulateOnce(cut, { arriveBy: t(20) }).days[0].rows[1];
  assert.equal(hm(c.end), "17:00");
  assert.equal(c.status, "ok");
  assert.equal(c.cutMin, 30);
  const short = simulateOnce(cut, { arriveBy: t(20) }, { dwell: 3 });
  assert.equal(short.problems[0].kind, "short");
});

test("simulate: 定休日（別の日に行ったら）と、休みだったことにする指定", () => {
  // 3日ずらすと火曜（closedDays: [2]）
  const r = simulateOnce(trip(), request, { shiftDays: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].kind, "closed");
  assert.match(r.problems[0].message, /定休日/);
  const f = simulateOnce(trip(), request, { closed: ["試験の公園"] });
  assert.deepEqual(f.problems.map((p) => [p.kind, p.title]), [["closed", "試験の公園"]]);
});

test("simulate: 余裕は、成り立つ限りの いちばん大きい遅れ", () => {
  const s = slack(trip(), request);
  assert.equal(simulateOnce(trip(), request, { late: s.late }).ok, true);
  assert.equal(simulateOnce(trip(), request, { late: s.late + 1 }).ok, false);
  assert.equal(simulateOnce(trip(), request, { delay: s.delay }).ok, true);
  assert.equal(simulateOnce(trip(), request, { delay: s.delay + 0.02 }).ok, false);
  assert.deepEqual(slack(trip(), request, { closed: ["試験の公園"] }), { late: null, delay: null });
});

test("simulate: 何度もたどる結果は、同じ種なら同じ", () => {
  const a = simulateMany(trip(), request, { runs: 300, seed: 7, delay: 0.3 });
  const b = simulateMany(trip(), request, { runs: 300, seed: 7, delay: 0.3 });
  assert.deepEqual(a, b);
  assert.ok(a.okRate > 0 && a.okRate < 1, `okRate ${a.okRate}`);
  assert.ok(a.returnP90 >= a.returnP50);
  assert.equal(a.trouble[0].kind, "late_return");
  const r = prng(1);
  const xs = Array.from({ length: 2000 }, () => r.normal());
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean) < 0.1, `mean ${mean}`);
});

test("simulate: 動く前の点検（重なり・速すぎる移動・移動の上限）", () => {
  assert.ok(checkMoves(trip()).every((c) => c.ok));
  const bad = trip();
  bad.days[0].items[2] = { ...bad.days[0].items[2], start: t(11) };
  assert.equal(checkMoves(bad).find((c) => c.name === "時刻の並び").ok, false);
  const far = trip();
  far.days[0].items.splice(2, 1);
  far.days[0].items[3] = { ...far.days[0].items[3], place: { ...park, lat: 43.06, lng: 141.35 } };
  assert.match(checkMoves(far).find((c) => c.name === "移動の速さ").detail, /速すぎます/);
  assert.equal(checkMoves(trip(), { maxLegMinutes: 45 }).find((c) => c.name === "移動の長さ").ok, false);
  assert.equal(parseRatio("20%", "delay"), 0.2);
  assert.equal(parseRatio("0.2", "delay"), 0.2);
  assert.throws(() => parseRatio("たくさん", "delay"), /20% か 0.2/);
});

// ---- 天気の取り口 ----

test("replan: 天気の fetch は api.open-meteo.com だけに出て、混んでいたら取り直す", async () => {
  const calls = [];
  const answers = [{ ok: false, status: 503 }, { ok: true, status: 200 }];
  const f = guardedFetch({ realFetch: async (u) => { calls.push(u); return answers[calls.length - 1]; }, sleep: async () => {} });
  assert.equal((await f(`https://${WEATHER_HOST}/v1/forecast?latitude=35`)).status, 200);
  assert.equal(calls.length, 2);
  await assert.rejects(f("https://example.com/v1/forecast"), /だけです/);
  await assert.rejects(f(`http://${WEATHER_HOST}/v1/forecast`), /だけです/);
  await assert.rejects(f(`https://${WEATHER_HOST}.example.com/`), /だけです/);

  let n = 0;
  const down = guardedFetch({ realFetch: async () => { n++; throw new Error("ECONNRESET"); }, sleep: async () => {} });
  await assert.rejects(down(`https://${WEATHER_HOST}/`), /ECONNRESET/);
  assert.equal(n, 3);
  n = 0;
  const gone = guardedFetch({ realFetch: async () => { n++; return { ok: false, status: 404 }; }, sleep: async () => {} });
  assert.equal((await gone(`https://${WEATHER_HOST}/`)).status, 404);
  assert.equal(n, 1, "404 は取り直さない");
});

test("replan: 控えのファイルと、書き出す先（元のファイルには書かない）", async () => {
  const file = path.join(tmp, "cache", "w.json");
  const s = fileStorage(file);
  assert.equal(s.getItem("k"), null);
  s.setItem("k", "v");
  assert.equal(fileStorage(file).getItem("k"), "v");
  assert.equal(outPathFor("/x/trip.yaml"), "/x/trip.replanned.yaml");
  assert.throws(() => outPathFor("/x/trip.yaml", "/x/trip.yaml"), /元のファイル/);
  const st = path.join(tmp, "state", "s.json");
  assert.equal((await loadState(st)).failures, 0);
  await saveState(st, { version: 1, fingerprint: "abc", failures: 2 });
  assert.equal((await loadState(st)).fingerprint, "abc");
  writeFileSync(st, "{こわれた");
  assert.equal((await loadState(st)).fingerprint, "");
});

test("replan: 知らせるかどうか（同じ内容は1度だけ、取れないのが続いたら知らせる）", () => {
  const proposal = { status: "proposal", fingerprint: "f1", swaps: [{}] };
  const opt = { useState: true, maxFailures: 3 };
  let d = decide(proposal, { fingerprint: "", failures: 0 }, opt);
  assert.deepEqual([d.code, d.notify], [1, true]);
  d = decide(proposal, d.state, opt);
  assert.deepEqual([d.code, d.notify], [0, false], "同じ内容は2度知らせない");
  d = decide({ ...proposal, fingerprint: "f2" }, d.state, opt);
  assert.deepEqual([d.code, d.notify], [1, true], "内容が変われば知らせる");
  d = decide({ status: "ok", fingerprint: "" }, d.state, opt);
  assert.deepEqual([d.code, d.notify], [0, true]);
  assert.match(d.headline, /なくなりました/);

  const fail = { status: "unavailable", fingerprint: "" };
  let s = d.state;
  const codes = [];
  for (let i = 0; i < 6; i++) { const x = decide(fail, s, opt); codes.push([x.code, x.notify]); s = x.state; }
  assert.deepEqual(codes, [[0, false], [0, false], [3, true], [0, false], [0, false], [3, true]]);
  assert.equal(decide({ status: "ok", fingerprint: "" }, s, opt).state.failures, 0);
  assert.equal(decide(fail, { failures: 0 }, { strict: true }).code, 3);
  assert.deepEqual([decide(fail, { failures: 0 }, {}).code, decide(fail, { failures: 0 }, {}).notify], [0, true]);
  assert.equal(decide({ status: "not_yet", fingerprint: "" }, { failures: 2 }, opt).code, 0);
});

test("replan: Open-Meteo の取り口は、丸めた座標と日付だけを送り、取れなければ旅程を変えない", async () => {
  const core = await import("../packages/core/index.mjs");
  const c = await core.createCore({ userData: false });
  const format = { toJson: core.toJson };
  // 予報は16日先までなので、あさっての旅程で確かめます
  const day = new Date(Date.now() + 2 * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
  const journey = { ...parseJourney(readFileSync(SAMPLE, "utf8").replace("2026-11-07", day), "trip.yaml"), file: "trip.yaml" };
  journey.text = "";
  const home = path.join(tmp, "home-live");
  const urls = [];
  const rainy = async (u) => {
    urls.push(String(u));
    const d = new URL(u).searchParams.get("start_date");
    const hours = Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, "0")}:00`);
    return { ok: true, status: 200, json: async () => ({ hourly: { time: hours, precipitation_probability: hours.map(() => 90), temperature_2m: hours.map(() => 12), weather_code: hours.map(() => 61) } }) };
  };
  try {
    await useWeather({ env: { TABISAKI_HOME: home }, fetchImpl: guardedFetch({ realFetch: rainy, sleep: async () => {} }) });
    const r = await weatherReplan(c, journey, { format });
    assert.equal(r.status, "proposal");
    assert.ok(r.swaps.length >= 1);
    assert.ok(r.diff.length > 2);
    // must_visit のポーラ美術館は、組み直した後も入っています
    const after = r.after.result.itinerary.days.flatMap((d) => d.items).filter((i) => i.kind === "spot").map((i) => i.title);
    assert.ok(after.includes("ポーラ美術館"));
    for (const s of r.swaps) assert.ok(!after.includes(s.title), `${s.title} が残っています`);
    assert.ok(urls.length >= 1);
    for (const u of urls) {
      const q = new URL(u);
      assert.equal(q.hostname, WEATHER_HOST);
      assert.deepEqual([...q.searchParams.keys()].sort(), ["end_date", "hourly", "latitude", "longitude", "start_date", "timezone"]);
      assert.match(q.searchParams.get("latitude"), /^\d+\.\d{4}$/);
    }
    assert.ok(existsSync(path.join(home, "cache", "weather.json")), "予報の控えを置く");

    await useWeather({ env: { TABISAKI_HOME: path.join(tmp, "home-down") }, fetchImpl: guardedFetch({ realFetch: async () => { throw new Error("offline"); }, sleep: async () => {} }) });
    const down = await weatherReplan(c, journey, { format });
    assert.equal(down.status, "unavailable");
    assert.equal(down.after, null);
    assert.deepEqual(down.swaps, []);
  } finally {
    await useWeather({ provider: "off" });
  }
});

// ---- コマンド ----

test("tabisaki simulate: 見本は成り立ち（0）、遅れを足すと成り立たない（1）", () => {
  const ok = run("simulate", SAMPLE);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /結果: 成り立ちます/);
  assert.match(ok.stdout, /余裕: 出発は/);
  const bad = run("simulate", SAMPLE, "--delay=30%", "--late=20", "--runs=50", "--seed=3", "--output=json");
  assert.equal(bad.status, 1, bad.stderr);
  const j = JSON.parse(bad.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.conditions.delay, 0.3);
  assert.equal(j.monteCarlo.runs, 50);
  assert.ok(j.problems.some((p) => p.kind === "late_return"));
  assert.deepEqual(JSON.parse(run("simulate", SAMPLE, "--delay=30%", "--late=20", "--runs=50", "--seed=3", "--output=json").stdout), j);
});

test("tabisaki simulate: 休みの指定と、書きかたのまちがい（2）", () => {
  const closed = run("simulate", SAMPLE, "--closed=ポーラ美術館");
  assert.equal(closed.status, 1);
  assert.match(closed.stdout, /✗ 立ち寄り: 「ポーラ美術館」休み/);
  for (const args of [["--closed=どこにもない場所"], ["--delay=たくさん"], ["--seed=3"], ["--late=-5"], ["--on=来週"], ["--style=blog"]]) {
    const r = run("simulate", SAMPLE, ...args);
    assert.equal(r.status, 2, `${args}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /tabisaki/);
  }
  assert.equal(run("simulate", path.join(tmp, "無い.yaml")).status, 2);
});

test("tabisaki replan: --weather-check が無ければ通信せずに断り、雨なら案を出して別のファイルに書く", () => {
  const src = readFileSync(SAMPLE, "utf8");
  const file = write("trip.yaml", src);
  const no = run("replan");
  assert.equal(no.status, 2);
  assert.match(no.stderr, /--weather-check/);

  const r = run("replan", "--weather-check", "--provider=mock", "--rain=80", "--apply");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /屋内の「.+」に入れ替え/);
  assert.match(r.stdout, /書き出しました: trip\.replanned\.yaml/);
  assert.equal(readFileSync(file, "utf8"), src, "元のファイルは変えない");
  const out = path.join(tmp, "trip.replanned.yaml");
  assert.match(readFileSync(out, "utf8"), /avoid: \[/);
  const t2 = run("test", out);
  assert.equal(t2.status, 0, t2.stdout);

  assert.equal(run("replan", "trip.yaml", "--weather-check", "--provider=mock", "--rain=80", "--apply", `--out=${file}`).status, 2);
  assert.equal(run("replan", "trip.yaml", "--weather-check", "--rain=80").status, 2, "--rain は mock だけ");
});

test("tabisaki replan: 雨でなければ 0、must_visit は入れ替えない、取れなければ変えない", () => {
  const dry = run("replan", SAMPLE, "--weather-check", "--provider=mock", "--rain=10");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /雨の心配はありません/);

  const must = write("must.yaml", readFileSync(SAMPLE, "utf8").replace("must_visit: [ポーラ美術館]", "must_visit: [ポーラ美術館, 芦ノ湖]"));
  const m = run("replan", must, "--weather-check", "--provider=mock", "--rain=80", "--output=json");
  const j = JSON.parse(m.stdout);
  const lake = j.concerns.find((c) => c.title === "芦ノ湖");
  assert.equal(lake.action, "keep");
  assert.match(lake.why, /must_visit/);

  const off = run("replan", SAMPLE, "--weather-check", "--provider=off");
  assert.equal(off.status, 0);
  assert.match(off.stdout, /天気を取れませんでした。旅程は変えていません/);
  assert.equal(run("replan", SAMPLE, "--weather-check", "--provider=off", "--strict").status, 3);
});

test("tabisaki replan: cron 向け（--quiet --state）。同じ内容は黙り、取れないのが3回続いたら知らせる", () => {
  const state = path.join(tmp, "cron-state.json");
  const args = ["replan", SAMPLE, "--weather-check", "--quiet", `--state=${state}`];
  const first = run(...args, "--provider=mock", "--rain=80");
  assert.equal(first.status, 1);
  assert.match(first.stdout, /入れ替える案があります/);
  const second = run(...args, "--provider=mock", "--rain=80");
  assert.deepEqual([second.status, second.stdout], [0, ""]);
  const outs = [1, 2, 3].map(() => run(...args, "--provider=off"));
  assert.deepEqual(outs.map((o) => o.status), [0, 0, 3]);
  assert.deepEqual(outs.slice(0, 2).map((o) => o.stdout), ["", ""]);
  assert.match(outs[2].stdout, /3回つづけて取れていません/);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).failures, 3);
});
