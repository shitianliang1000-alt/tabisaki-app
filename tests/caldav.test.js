// カレンダー連携（tabisaki sync・packages/core/caldav.mjs）と、声からの入力
// （tabisaki voice-plan・packages/core/voice.mjs）の試験。
//
// CalDAV は手元に小さな偽のサーバーを立てて確かめます（外へは出ません）。

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  splitEvents, hrefFor, checkCalendarUrl, credentialsFrom, tripSeed,
  syncEvents, removeEvents, loadState, saveState,
} from "../packages/core/caldav.mjs";
import { cleanTranscript, transcribe } from "../packages/core/voice.mjs";

const BIN = fileURLToPath(new URL("../packages/cli/bin/tabisaki-plan.mjs", import.meta.url));

const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//tabisaki//itinerary//JA", "METHOD:PUBLISH",
  "X-WR-CALNAME:箱根", "X-WR-TIMEZONE:Asia/Tokyo",
  "BEGIN:VEVENT", "UID:trip-a-eve@tabisaki", "DTSTART:20261106T200000", "SUMMARY:明日から 箱根", "END:VEVENT",
  "BEGIN:VEVENT", "UID:trip-a-0-s1@tabisaki", "DTSTART:20261107T100000",
  "SUMMARY:大涌谷\\, 黒たまご", "DESCRIPTION:長い説明を", " 折り返した行", "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n");

/** 偽の CalDAV。PUT・DELETE を覚えておきます。 */
function fakeCaldav({ user = "ryo", password = "app-pass", failPut = null } = {}) {
  const store = new Map();
  const log = [];
  const server = http.createServer((req, res) => {
    const want = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    if (req.headers.authorization !== want) { res.writeHead(401).end(); return; }
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      log.push(`${req.method} ${req.url}`);
      if (req.method === "PUT") {
        if (failPut && req.url.endsWith(failPut)) { res.writeHead(507).end(); return; }
        const existed = store.has(req.url);
        store.set(req.url, body);
        res.writeHead(existed ? 204 : 201).end();
      } else if (req.method === "DELETE") {
        res.writeHead(store.delete(req.url) ? 204 : 404).end();
      } else res.writeHead(405).end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}/cal/ryo/travel/`;
    resolve({ url, store, log, close: () => new Promise((r) => server.close(r)) });
  }));
}

test("1つの .ics を、予定1つずつの VCALENDAR に分ける", () => {
  const evs = splitEvents(ICS);
  assert.equal(evs.length, 2);
  assert.equal(evs[1].uid, "trip-a-0-s1@tabisaki");
  assert.equal(evs[1].summary, "大涌谷, 黒たまご");
  assert.equal(evs[1].start, "20261107T100000");
  for (const e of evs) {
    assert.match(e.body, /^BEGIN:VCALENDAR\r\nVERSION:2.0\r\n/);
    assert.match(e.body, /END:VEVENT\r\nEND:VCALENDAR\r\n$/);
    assert.equal(e.body.match(/BEGIN:VEVENT/g).length, 1);
    // CalDAV の予定ファイルに METHOD を付けると断るサーバーがあります（RFC 4791 §4.1）。
    assert.doesNotMatch(e.body, /METHOD:/);
  }
  assert.match(evs[1].body, /DESCRIPTION:長い説明を\r\n 折り返した行/);
  assert.deepEqual(splitEvents(""), []);
});

test("ファイル名は UID から決まり、記号を含まない", () => {
  assert.equal(hrefFor("trip-a-0-s1@tabisaki"), hrefFor("trip-a-0-s1@tabisaki"));
  assert.notEqual(hrefFor("a"), hrefFor("b"));
  assert.match(hrefFor("a/../b@c"), /^tabisaki-[0-9a-f]{24}\.ics$/);
});

test("カレンダーの URL: https か手元だけ・合言葉を URL に入れない", () => {
  assert.equal(checkCalendarUrl("https://dav.example.com/cal/me").href, "https://dav.example.com/cal/me/");
  assert.equal(checkCalendarUrl("http://127.0.0.1:5232/me/travel/").protocol, "http:");
  for (const bad of ["http://dav.example.com/cal/", "https://ryo:pw@dav.example.com/cal/", "ftp://x/", "nope", "",
    "https://dav.example.com/cal/?x=1"]) {
    assert.throws(() => checkCalendarUrl(bad), { code: "invalid_input" }, bad);
  }
});

test("合言葉は環境変数か、合言葉を出すコマンドから", async () => {
  assert.deepEqual(await credentialsFrom({ TABISAKI_CALDAV_USER: "u", TABISAKI_CALDAV_PASSWORD: "p" }), { user: "u", password: "p" });
  assert.deepEqual(
    await credentialsFrom({ TABISAKI_CALDAV_USER: "u", TABISAKI_CALDAV_PASSWORD_CMD: "pass show x" }, async () => "secret\n"),
    { user: "u", password: "secret" });
  await assert.rejects(credentialsFrom({ TABISAKI_CALDAV_USER: "u" }), { code: "auth" });
});

test("同じ旅を2度送っても増えない。無くなった予定は消し、ほかの予定には触れない", async () => {
  const dav = await fakeCaldav();
  try {
    dav.store.set("/cal/ryo/travel/someone-else.ics", "BEGIN:VCALENDAR…");
    const calendar = checkCalendarUrl(dav.url);
    const credentials = { user: "ryo", password: "app-pass" };
    const state = { version: 1, calendars: {} };
    const events = splitEvents(ICS);

    const first = await syncEvents({ calendar, credentials, events, seed: "trip-a", state });
    assert.equal(first.put.length, 2);
    assert.equal(dav.store.size, 3);
    await syncEvents({ calendar, credentials, events, seed: "trip-a", state });
    assert.equal(dav.store.size, 3, "2度目は上書き（重複しない）");

    // 予定が1つ減った旅を送ると、減った分を消します。
    const fewer = await syncEvents({ calendar, credentials, events: events.slice(0, 1), seed: "trip-a", state });
    assert.equal(fewer.removed.length, 1);
    assert.equal(dav.store.size, 2);
    assert.ok(dav.store.has("/cal/ryo/travel/someone-else.ics"));
    assert.ok(dav.log.every((l) => /\/tabisaki-[0-9a-f]{24}\.ics$/.test(l)), "旅さきのファイルにしか触れない");

    // 合言葉は、送った一覧に残りません。
    assert.doesNotMatch(JSON.stringify(state), /app-pass/);

    const gone = await removeEvents({ calendar, credentials, state });
    assert.equal(gone.removed.length, 1);
    assert.deepEqual([...dav.store.keys()], ["/cal/ryo/travel/someone-else.ics"]);
    assert.deepEqual(state.calendars, {});
  } finally {
    await dav.close();
  }
});

test("断られたら auth、途中で失敗しても書けた分は一覧に残る", async () => {
  const dav = await fakeCaldav({ failPut: hrefFor("trip-a-0-s1@tabisaki") });
  try {
    const calendar = checkCalendarUrl(dav.url);
    const state = { version: 1, calendars: {} };
    await assert.rejects(
      syncEvents({ calendar, credentials: { user: "ryo", password: "wrong" }, events: splitEvents(ICS), seed: "s", state }),
      { code: "auth" });
    await assert.rejects(
      syncEvents({ calendar, credentials: { user: "ryo", password: "app-pass" }, events: splitEvents(ICS), seed: "s", state }),
      { code: "http" });
    assert.deepEqual(state.calendars[calendar.href].s.hrefs, [hrefFor("trip-a-eve@tabisaki")]);
  } finally {
    await dav.close();
  }
});

test("dry-run は何も送らない", async () => {
  const calls = [];
  const r = await syncEvents({
    calendar: checkCalendarUrl("https://dav.example.com/c/"), events: splitEvents(ICS), seed: "s",
    state: { version: 1, calendars: {} }, dryRun: true, fetch: async (...a) => { calls.push(a); },
  });
  assert.equal(r.put.length, 2);
  assert.equal(calls.length, 0);
});

test("送った一覧は自分だけが読める形で保存する", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tabisaki-state-"));
  const file = path.join(dir, "tabisaki", "caldav-sync.json");
  await saveState(file, { version: 1, calendars: { "https://x/": { s: { hrefs: ["a.ics"] } } } });
  assert.deepEqual((await loadState(file)).calendars["https://x/"].s.hrefs, ["a.ics"]);
  if (process.platform !== "win32") assert.equal((await import("node:fs")).statSync(file).mode & 0o077, 0);
  assert.deepEqual(await loadState(path.join(dir, "none.json")), { version: 1, calendars: {} });
});

test("同じ条件の旅は同じ種になる", () => {
  const r = { wish: "温泉", origin: { name: "東京駅" }, days: 1, departAt: new Date("2026-11-07T08:00:00+09:00") };
  assert.equal(tripSeed(r), tripSeed({ ...r }));
  assert.notEqual(tripSeed(r), tripSeed({ ...r, wish: "海" }));
  assert.match(tripSeed(r), /^trip-[0-9a-f]{12}$/);
});

/** CLI を子プロセスで動かします（偽のサーバーと同じ process では動かせないため、非同期で）。 */
function cli(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, TZ: "UTC", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("tabisaki sync: 確かめてから書き、--remove で消す", async () => {
  const dav = await fakeCaldav();
  const state = mkdtempSync(path.join(os.tmpdir(), "tabisaki-sync-"));
  const env = { XDG_STATE_HOME: state, TABISAKI_CALDAV_USER: "ryo", TABISAKI_CALDAV_PASSWORD: "app-pass" };
  const trip = ["温泉と海", "--date=2026-11-07", `--caldav-url=${dav.url}`];
  try {
    // 端末でないときに --yes が無ければ、何も送りません。
    const no = await cli(["sync", ...trip], env);
    assert.equal(no.status, 2, no.stderr);
    assert.match(no.stderr, /--yes/);
    assert.equal(dav.store.size, 0);

    const dry = await cli(["sync", ...trip, "--dry-run"], {});
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /まだ何も送っていません/);
    assert.equal(dav.log.length, 0);

    const ok = await cli(["sync", ...trip, "--yes"], env);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^書き込みました: \d+件/);
    const n = dav.store.size;
    assert.ok(n >= 3);
    for (const body of dav.store.values()) assert.match(body, /^BEGIN:VCALENDAR\r\n[\s\S]*UID:trip-[0-9a-f]{12}-/);
    assert.doesNotMatch(readFileSync(path.join(state, "tabisaki", "caldav-sync.json"), "utf8"), /app-pass|Basic /);

    const again = await cli(["sync", ...trip, "--yes"], env);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(dav.store.size, n, "同じ旅は上書き");

    const rm = await cli(["sync", "--remove", `--caldav-url=${dav.url}`, "--yes"], env);
    assert.equal(rm.status, 0, rm.stderr);
    assert.equal(dav.store.size, 0);
    assert.equal(existsSync(path.join(state, "tabisaki", "caldav-sync.json")), true);
  } finally {
    await dav.close();
  }
});

test("tabisaki sync の使いかたのまちがい", async () => {
  for (const args of [["sync", "温泉"], ["sync", "温泉", "--caldav-url=http://dav.example.com/"],
    ["plan", "温泉", "--caldav-url=https://x/"], ["plan", "温泉", "--dry-run"], ["plan", "温泉", "--yes=1"]]) {
    const r = await cli(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^tabisaki: /);
  }
  const noCred = await cli(["sync", "温泉", "--date=2026-11-07", "--caldav-url=https://dav.example.com/c/", "--yes"],
    { TABISAKI_CALDAV_USER: "", TABISAKI_CALDAV_PASSWORD: "", XDG_STATE_HOME: mkdtempSync(path.join(os.tmpdir(), "t-")) });
  assert.equal(noCred.status, 2);
  assert.match(noCred.stderr, /TABISAKI_CALDAV_USER/);
});

test("--output=ics はカレンダーの形で出る", async () => {
  const r = await cli(["plan", "京都の寺", "--from=新大阪駅", "--date=2026-11-03", "--output=ics"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^BEGIN:VCALENDAR\r\n/);
  assert.match(r.stdout, /END:VCALENDAR\r\n$/);
});

test("whisper.cpp の出力から文だけを取り出す", () => {
  assert.equal(cleanTranscript("[00:00:00.000 --> 00:00:03.000]  箱根で温泉に入りたい\n[音楽]\n 2日で\n"), "箱根で温泉に入りたい 2日で");
  assert.equal(cleanTranscript(""), "");
});

/** 偽の whisper.cpp（引数を確かめて、決まった文を出す）。 */
function fakeWhisper(text, code = 0) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tabisaki-whisper-"));
  const bin = path.join(dir, "whisper-cli");
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args"\necho "${text}"\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  const wav = path.join(dir, "wish.wav");
  writeFileSync(wav, "RIFF");
  return { bin, wav, dir };
}

test("transcribe: 手元の whisper.cpp を、日本語で呼ぶ", { skip: process.platform === "win32" }, async () => {
  const w = fakeWhisper("温泉でゆっくりしたい");
  const env = { TABISAKI_WHISPER: w.bin, TABISAKI_WHISPER_MODEL: "/models/ggml-small.bin" };
  assert.equal(await transcribe(w.wav, { env }), "温泉でゆっくりしたい");
  assert.match(readFileSync(path.join(w.dir, "args"), "utf8"), /-m \/models\/ggml-small.bin -f .*wish.wav -l ja -nt/);
  await assert.rejects(transcribe(w.wav, { env: { TABISAKI_WHISPER: w.bin } }), { code: "setup" });
  await assert.rejects(transcribe(path.join(w.dir, "none.wav"), { env }), { code: "invalid_input" });
  await assert.rejects(transcribe(w.wav, { env: { ...env, TABISAKI_WHISPER: path.join(w.dir, "nope") } }), { code: "setup" });
  const bad = fakeWhisper("", 3);
  await assert.rejects(transcribe(bad.wav, { env: { ...env, TABISAKI_WHISPER: bad.bin } }), { code: "failed" });
});

test("tabisaki voice-plan: 聞き取った文を見せ、確かめてから組む", { skip: process.platform === "win32" }, async () => {
  const w = fakeWhisper("温泉と海をゆっくり楽しみたい");
  const env = { TABISAKI_WHISPER: w.bin, TABISAKI_WHISPER_MODEL: "/m.bin" };
  const no = await cli(["voice-plan", w.wav, "--date=2026-11-07"], env);
  assert.equal(no.status, 2);
  assert.match(no.stderr, /聞き取った文: 温泉と海をゆっくり楽しみたい/);
  assert.equal(no.stdout, "");
  const ok = await cli(["voice-plan", w.wav, "--date=2026-11-07", "--yes"], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^# /);
});
