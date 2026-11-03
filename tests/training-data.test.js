// 学習データの書き出し（tools/export_training_data.mjs）と採点（tools/model_eval.mjs）。
// 本物の kb/ は読まず、手で作った小さな収録で確かめます。通信もしません。

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDataset, isEval, licenseOf, spotAnswer, verifyLevel, UNKNOWN_ANSWER,
} from "../tools/export_training_data.mjs";
import { evaluate, knownFromKb, scoreRow } from "../tools/model_eval.mjs";

test("ライセンスの仕分け: 非商用・Yahoo! 由来・出どころ不明は既定で外す側", () => {
  assert.equal(licenseOf({ src: "kokudo" }).group, "kokudo-noncommercial");
  assert.equal(licenseOf({ dataSource: "国土数値情報 文化施設(P27-13)" }).group, "kokudo-noncommercial");
  assert.equal(licenseOf({ src: "tourlist-geocoded" }).group, "yahoo-unclear");
  assert.equal(licenseOf({ src: "osm-tourlist" }).group, "odbl");
  assert.equal(licenseOf({ src: "wikipedia-tourlist" }).group, "cc-by-sa");
  assert.equal(licenseOf({ src: "opendata" }).group, "unknown");
  assert.equal(licenseOf({ src: "overture-tourlist", license: "ODbL-1.0" }).group, "unknown");
  assert.equal(licenseOf({ src: "overture-tourlist", license: "CDLA-Permissive-2.0" }).group, "permissive");
  assert.equal(licenseOf({ src: "wikidata" }).group, "cc0");
  assert.equal(licenseOf({}).group, "project");
});

test("裏取りの段", () => {
  assert.equal(verifyLevel("verified_web"), "verified");
  assert.equal(verifyLevel("name_match_high"), "high");
  assert.equal(verifyLevel("not_found_web"), "low");
  assert.equal(verifyLevel(undefined), "none");
});

const region = { id: "r1", name: "東山", prefecture: "京都府", tagline: "古寺の町" };
const spot = (id, extra) => ({ id, regionId: "r1", name: id, category: "寺院", prefecture: "京都府", fame_tier: "known", ...extra });
const fakeKb = () => ({
  kbHash: "x",
  regions: new Map([["r1", region]]),
  spots: [
    spot("清水寺", { description: "Wikipedia の文", fee: 500, open: 6, close: 18 }),
    spot("八坂神社", { src: "wikidata", category: "神社" }),
    spot("高台寺", { src: "wikidata" }),
    spot("非商用寺", { src: "kokudo" }),
    spot("ヤフー寺", { src: "tourlist-geocoded" }),
    spot("未確認寺", { src: "wikidata" }),
  ],
  verify: new Map([
    ["清水寺", { status: "verified" }], ["八坂神社", { status: "verified_web" }], ["高台寺", { status: "verified_osm" }],
    ["非商用寺", { status: "verified" }], ["ヤフー寺", { status: "verified" }], ["未確認寺", { status: "name_match_low" }],
  ]),
});

test("書き出しは、外すべきものを入れず、出どころと裏取りを meta に残す", async () => {
  const ds = await buildDataset({ kb: fakeKb(), plans: false, evalRate: 0 });
  const all = JSON.stringify([...ds.train, ...ds.eval]);
  for (const bad of ["非商用寺", "ヤフー寺", "未確認寺", "Wikipedia の文"]) assert.ok(!all.includes(bad), bad);
  assert.equal(ds.manifest.excluded["license:kokudo-noncommercial"], 1);
  assert.equal(ds.manifest.excluded["license:yahoo-unclear"], 1);
  assert.equal(ds.manifest.excluded["verify:low"], 1);
  const fact = ds.train.find((r) => r.meta.task === "spot_fact" && r.meta.spotIds[0] === "八坂神社");
  assert.deepEqual(fact.meta.licenses, ["CC0-1.0"]);
  assert.deepEqual(fact.meta.verified, ["verified"]);
  assert.equal(fact.messages[0].role, "user");
  const area = ds.train.find((r) => r.meta.task === "area_list");
  assert.match(area.messages[1].content, /古寺の町/);
});

test("説明文（CC BY-SA）は、--with-cc-by-sa のときだけ入る", async () => {
  const ds = await buildDataset({ kb: fakeKb(), plans: false, evalRate: 0, groups: ["cc0", "project", "permissive", "cc-by-sa"], withText: true });
  assert.ok(JSON.stringify(ds.train).includes("Wikipedia の文"));
});

test("答えは収録の値だけで書く", () => {
  const a = spotAnswer(spot("清水寺", { fee: 500, open: 6, close: 18 }), region);
  assert.match(a, /京都府の「東山」エリアにある寺院/);
  assert.match(a, /500円/);
  assert.match(a, /6時〜18時/);
});

test("評価用への分けかたは毎回同じ", () => {
  assert.equal(isEval("abc"), isEval("abc"));
  const n = Array.from({ length: 2000 }, (_, i) => isEval(`k${i}`)).filter(Boolean).length;
  assert.ok(n > 50 && n < 160, String(n));
});

test("採点: 作り話の固有名・断れたか・挙げた名前", () => {
  const kb = fakeKb();
  const known = knownFromKb(kb.spots, [region]);
  const row = { meta: { task: "spot_fact", spotIds: ["清水寺"] }, messages: [] };
  const byId = new Map(kb.spots.map((s) => [s.id, s]));
  assert.deepEqual(
    { p: scoreRow(row, "清水寺は京都府にあります。", known, byId).prefecture, g: scoreRow(row, "清水寺は京都府にあります。", known, byId).grounded },
    { p: 1, g: 1 });
  assert.equal(scoreRow(row, "清水寺は京都府。近くの架空院もどうぞ。", known, byId).grounded, 0);
  assert.equal(scoreRow({ meta: { task: "unknown_place" } }, UNKNOWN_ANSWER("x"), known).refused, 1);
  assert.equal(scoreRow({ meta: { task: "unknown_place" } }, "x は滝のきれいな場所です。", known).refused, 0);
  assert.equal(scoreRow({ meta: { task: "area_list" } }, "・清水寺（寺院）\n・空想寺（寺院）", known).known, 0.5);
});

test("採点は OpenAI 互換の入口に聞く（偽の入口）", async () => {
  const kb = fakeKb();
  const known = knownFromKb(kb.spots, [region]);
  const rows = [{ meta: { task: "unknown_place" }, messages: [{ role: "user", content: "架空滝は？" }] }];
  const fetchImpl = async (url, init) => {
    assert.equal(url, "http://own.example/v1/chat/completions");
    assert.equal(JSON.parse(init.body).temperature, 0);
    return new Response(JSON.stringify({ choices: [{ message: { content: "収録には見つかりませんでした。" } }] }));
  };
  const { summary } = await evaluate(rows, { url: "http://own.example", model: "m", known, fetchImpl });
  assert.equal(summary["unknown.refused"], 1);
});
