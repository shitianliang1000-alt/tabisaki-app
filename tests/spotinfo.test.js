// スポットに足す情報（packages/core/spotinfo.mjs・enrich.mjs）の試験。外へは通信しません。

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyToSpot, emptyStore, findSpots, freshness, makeField, parseDays, parseHours,
  spotsInArea, validateStore, verifyField,
} from "../packages/core/spotinfo.mjs";
import { enrichSpot, generateCandidates } from "../packages/core/enrich.mjs";
import { hoursFor } from "../packages/core/src/hours.js";

const TODAY = "2026-10-27";
const src = { name: "公式サイト", url: "https://example.jp/" };

test("手で入れた値は確認済み、自動で取った値・AI の値は未確認で入る", () => {
  assert.equal(makeField("x", { origin: "manual", source: src, today: TODAY }).status, "verified");
  for (const origin of ["wikipedia", "wikidata", "commons", "llm"]) {
    const f = makeField("x", { origin, source: src, today: TODAY });
    assert.equal(f.status, "unverified", origin);
    assert.equal(f.checkedAt, undefined);
    assert.equal(f.source.retrievedAt, TODAY);
  }
  const v = verifyField(makeField("x", { origin: "wikidata", source: src, today: "2026-01-01" }), TODAY);
  assert.equal(v.status, "verified");
  assert.equal(v.checkedAt, TODAY);
});

test("営業時間の書きかたを src/hours.js の形にする", () => {
  assert.deepEqual(parseHours("9:00-17:00", { closed: "月,水", lastEntry: "16:30", closedSeason: "12-29..01-03" }),
    { open: 9, close: 17, lastEntry: 16.5, closedDays: [1, 3], closedSeasons: ["12-29..01-03"] });
  assert.deepEqual(parseHours("24h"), { open: 0, close: 24 });
  assert.deepEqual(parseDays("火曜・日"), [0, 2]);
  for (const bad of ["9-17", "17:00-9:00", "25:00-26:00"]) assert.throws(() => parseHours(bad), /./, bad);
  assert.throws(() => parseHours("9:00-17:00", { lastEntry: "18:00" }), /営業時間の外/);
  assert.throws(() => parseHours("9:00-17:00", { closed: "月曜とか" }), /曜日/);
  assert.throws(() => parseHours("9:00-17:00", { closedSeason: "冬" }), /MM-DD/);
});

test("ファイルの形を確かめる: 出典・取った日・写真のライセンスが無いと通らない", () => {
  const ok = emptyStore();
  ok.spots["a-1"] = {
    aliases: [makeField("別名", { origin: "manual", source: src, today: TODAY })],
    hours: makeField(parseHours("9:00-17:00"), { origin: "manual", source: src, today: TODAY }),
    seasonal: [makeField({ name: "紅葉", from: "10-20", to: "11-10" }, { origin: "manual", source: src, today: TODAY })],
    photos: [makeField({ url: "https://upload.wikimedia.org/x.jpg", author: "A" }, { origin: "commons", source: { name: "Wikimedia Commons", license: "CC BY-SA 4.0" }, today: TODAY })],
  };
  ok.areas["my-area"] = { name: "池", center: { lat: 36.35, lng: 138.63 }, radiusKm: 3 };
  assert.deepEqual(validateStore(ok, { spotIds: new Set(["a-1"]) }), []);

  const bad = structuredClone(ok);
  delete bad.spots["a-1"].aliases[0].source.name;
  delete bad.spots["a-1"].photos[0].source.license;
  bad.spots["a-1"].hours.value.close = 8;
  bad.spots["a-1"].seasonal[0].value.from = "秋";
  bad.spots["a-1"].photos[0].status = "verified"; // 自動で取った値を、確かめた日なしで verified に
  bad.spots["zzz"] = {};
  bad.areas["My Area"] = { name: "x", center: { lat: 1, lng: 1 }, spots: ["a-1"] };
  bad.candidates = [{ ...makeField({ name: "どこか" }, { origin: "llm", source: { name: "AI" }, today: TODAY }), status: "verified", checkedAt: TODAY }];
  const errors = validateStore(bad, { spotIds: new Set(["a-1"]) }).join("\n");
  for (const want of [/aliases\[0\]\.source\.name/, /ライセンス/, /close が後/, /from・to は MM-DD/, /checkedAt（確かめた日）/,
    /spots\.zzz: 収録に無い/, /id は英小文字/, /どちらか一方/, /AI の候補は verified にできません/]) {
    assert.match(errors, want);
  }
  assert.match(validateStore({ version: 2 }).join(), /version は 1/);
});

test("鮮度: 確認日からの日数と、古いかどうか", () => {
  const f = makeField({ open: 9, close: 17 }, { origin: "manual", source: src, today: "2026-01-01" });
  const fr = freshness(f, "hours", TODAY);
  assert.equal(fr.verified, true);
  assert.equal(fr.ageDays, 299);
  assert.equal(fr.stale, true); // 営業時間は 180 日で古いとみなす
  assert.match(fr.label, /確認済み 2026-01-01（299日前）・古いかもしれません/);
  const u = freshness(makeField("x", { origin: "wikidata", source: { name: "Wikidata" }, today: TODAY }), "aliases", TODAY);
  assert.equal(u.verified, false);
  assert.match(u.label, /^未確認・Wikidataから 2026-10-27（今日）/);
});

test("旅程に効くのは確認済みの値だけ（未確認の定休日で行き先を消さない）", () => {
  const spot = { id: "a-1", name: "池", category: "公園", open: 0, close: 24 };
  const hours = makeField(parseHours("9:00-17:00", { closed: "水" }), { origin: "wikidata", source: src, today: TODAY });
  const entry = { hours, aliases: [makeField("白鳥湖", { origin: "wikidata", source: src, today: TODAY })] };
  const wed = new Date("2026-11-04T10:00:00+09:00");

  const before = applyToSpot(spot, entry);
  assert.equal(before.hours, undefined);
  assert.deepEqual(before.aliases, ["白鳥湖"]); // 別名は探すためだけなので付ける
  assert.equal(hoursFor(before, wed).closed, false);

  const after = applyToSpot(spot, { ...entry, hours: verifyField(hours, TODAY) });
  assert.equal(hoursFor(after, wed).closed, true);
  assert.equal(hoursFor(after, new Date("2026-11-05T10:00:00+09:00")).estimated, false);
  assert.equal(spot.hours, undefined, "元のスポットは書き換えない");
});

test("名前・別名・id で探し、エリアに入るスポットを数える", () => {
  const kb = { spots: [
    { id: "a-1", name: "雲場池", lat: 36.348, lng: 138.624 },
    { id: "a-2", name: "神明社", lat: 35, lng: 139 },
    { id: "a-3", name: "神明社", lat: 36, lng: 140 },
  ] };
  const store = { spots: { "a-1": { aliases: [makeField("白鳥湖", { origin: "manual", source: src, today: TODAY })] } } };
  assert.deepEqual(findSpots(kb, "白鳥湖", store).map((s) => s.id), ["a-1"]);
  assert.deepEqual(findSpots(kb, "ｸﾓﾊﾞｲｹ", store), []);
  assert.equal(findSpots(kb, "神明社").length, 2);
  assert.deepEqual(findSpots(kb, "a-3").map((s) => s.id), ["a-3"]);
  assert.deepEqual(spotsInArea(kb, { center: { lat: 36.35, lng: 138.63 }, radiusKm: 3 }).map((s) => s.id), ["a-1"]);
  assert.deepEqual(spotsInArea(kb, { spots: ["a-2", "a-3"] }).map((s) => s.id), ["a-2", "a-3"]);
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const hit = routes.find(([re]) => re.test(String(url)));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1] };
  };
  fn.calls = calls;
  return fn;
}

test("enrich: Wikidata の別名と Commons の写真を、出典・ライセンスつきの未確認で返す", async () => {
  const fetchImpl = fakeFetch([
    [/wikidata\.org/, { entities: { Q1: { id: "Q1", labels: { ja: { value: "雲場池" } },
      aliases: { ja: [{ value: "白鳥湖" }, { value: "ｽﾜﾝﾚｲｸ" }] },
      claims: { P18: [{ mainsnak: { datavalue: { value: "Kumoba Pond.jpg" } } }] } } } }],
    [/commons\.wikimedia\.org/, { query: { pages: { "-1": { imageinfo: [{
      url: "https://upload.wikimedia.org/a.jpg", thumburl: "https://upload.wikimedia.org/a-1280.jpg",
      descriptionurl: "https://commons.wikimedia.org/wiki/File:Kumoba_Pond.jpg",
      extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "<a href='x'>Taro</a>" } } }] } } } }],
  ]);
  const r = await enrichSpot({ name: "雲場池", wikipedia: "雲場池" }, { fetchImpl, today: TODAY });
  assert.deepEqual(r.aliases.map((f) => f.value), ["白鳥湖", "スワンレイク"]);
  assert.ok(r.aliases.every((f) => f.status === "unverified" && f.source.license === "CC0 1.0" && f.source.url === "https://www.wikidata.org/wiki/Q1"));
  assert.equal(r.photos.length, 1);
  assert.deepEqual(r.photos[0].value, { url: "https://upload.wikimedia.org/a-1280.jpg", page: "https://commons.wikimedia.org/wiki/File:Kumoba_Pond.jpg", author: "Taro", title: "Kumoba Pond.jpg" });
  assert.equal(r.photos[0].source.license, "CC BY-SA 4.0");
  assert.ok(fetchImpl.calls.every((c) => /tabisaki-cli/.test(c.init.headers["User-Agent"])));
  assert.ok(fetchImpl.calls.every((c) => !/yahoo/i.test(c.url)));
  const store = emptyStore();
  store.spots.x = { aliases: r.aliases, photos: r.photos };
  assert.deepEqual(validateStore(store), []);
});

test("enrich: ライセンスが読めない写真は入れない・記事名が無ければ外へ出ない", async () => {
  const fetchImpl = fakeFetch([
    [/wikidata\.org/, { entities: { Q2: { id: "Q2", claims: { P18: [{ mainsnak: { datavalue: { value: "x.jpg" } } }] } } } }],
    [/commons\.wikimedia\.org/, { query: { pages: { 1: { imageinfo: [{ url: "https://u/x.jpg", extmetadata: {} }] } } } }],
  ]);
  const r = await enrichSpot({ name: "某所", wikipedia: "某所" }, { fetchImpl, today: TODAY });
  assert.equal(r.photos.length, 0);
  assert.match(r.notes.join(), /ライセンスが読めない/);
  const none = fakeFetch([]);
  const r2 = await enrichSpot({ name: "某所" }, { fetchImpl: none, today: TODAY });
  assert.equal(none.calls.length, 0);
  assert.match(r2.notes[0], /Wikipedia の記事名が収録に無い/);
});

test("generate: AI の候補は未確認で、出典は AI と書く", async () => {
  const fetchImpl = fakeFetch([[/\/v1\/chat\/completions$/, { choices: [{ message: { content:
    "はい。\n```json\n[{\"name\":\"雲場池\",\"category\":\"池\",\"why\":\"紅葉\"},{\"name\":\"\"},{\"name\":\"白糸の滝\"}]\n```" } }] }]]);
  const list = await generateCandidates({ area: "軽井沢", count: 5, url: "http://127.0.0.1:11434", model: "gemma", fetchImpl, today: TODAY });
  assert.deepEqual(list.map((f) => f.value.name), ["雲場池", "白糸の滝"]);
  assert.ok(list.every((f) => f.origin === "llm" && f.status === "unverified" && /AI/.test(f.source.name)));
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  await assert.rejects(generateCandidates({ area: "x", url: "", model: "" }), /TABISAKI_LLM_URL/);
  const junk = fakeFetch([[/./, { choices: [{ message: { content: "わかりません" } }] }]]);
  await assert.rejects(generateCandidates({ area: "x", url: "http://h", model: "m", fetchImpl: junk }), /JSON の配列/);
});
