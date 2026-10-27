// 複数の地名をひとまとめに言う呼び名（「さん都心」「京阪神」）を読む。
//
// 辞書にある言い方はそのまま、無い言い方はAIが具体的な地名に直したものを
// 使う。読みが人によって分かれる呼び名は、最も多い読みで組み、そう言う。

import assert from "node:assert/strict";
import test from "node:test";

import { areaNote, areaScope, detectAreas, phraseAreas } from "../packages/core/src/areas.js";
import { understandRequest } from "../packages/core/src/ai.js";
import { loadKnowledgeBase } from "../packages/core/src/kb.js";
import { planTrip } from "../packages/core/src/pipeline.js";
import { findPlace } from "../packages/core/src/places.js";
import { makeTrip } from "../packages/core/src/trip.js";

const kb = await loadKnowledgeBase();
const trip = (note, from = "東京駅") => makeTrip({
  origin: findPlace(from), note, budgetYen: 999999,
  departAt: new Date("2026-09-01T07:00"),
  arriveBy: new Date("2026-09-05T21:00"),
});
const namesOf = (itin) => itin.regionIds.map((id) => kb.regionsById.get(id).name);

test("「さん都心」「3都心」「三都心」は同じ呼び名として読む", () => {
  for (const text of ["さん都心を回りたい", "3都心で食べ歩き", "三都心の旅"]) {
    const [a] = detectAreas(text, kb);
    assert.equal(a?.term, "三都心", text);
    assert.ok(a.groups && new Set(a.groups.values()).size === 3,
      "東京・大阪・名古屋の内訳がありません");
  }
  assert.deepEqual(detectAreas("さん都心", kb)[0].reading.slice(0, 5), "「三都心」");
});

test("読みが分かれる呼び名は、組んだ読みを説明に出す", () => {
  const scope = areaScope(detectAreas("三都心", kb));
  assert.ok(areaNote(scope, {}).some((n) => /三大都市として読みました/.test(n)));
  // 読みが決まっている呼び名（京阪神）には出さない
  const k = areaScope(detectAreas("京阪神", kb));
  assert.deepEqual(areaNote(k, {}), []);
});

test("AIが直した呼び名は、収録のエリアに当てる（収録に無い名前は捨てる）", () => {
  const [a] = phraseAreas([{ phrase: "西の三大都市", meaning: "関西の主要都市",
    names: ["大阪", "京都", "神戸", "ヒミツ島"], ambiguous: true }], kb);
  assert.equal(a.term, "西の三大都市");
  assert.equal(a.fromAi, true);
  assert.ok(a.regionIds.length >= 3);
  assert.ok(new Set(a.groups.values()).size === 3, [...a.groups.values()].join());
  assert.match(a.reading, /AIの読み取りです/);
  // 地名が2つ未満・収録に無いものは作らない
  assert.deepEqual(phraseAreas([{ phrase: "x", names: ["大阪"] }], kb), []);
  assert.deepEqual(phraseAreas([{ phrase: "あの辺", names: ["ヒミツ島", "ナイ村"] }], kb), []);
  assert.deepEqual(phraseAreas(undefined, kb), []);
});

test("さん都心の旅は、東京・大阪・名古屋を1つずつ回り、「都心」を探さない", async () => {
  // 出発地が東京以外なら、いちばん多い読み（三大都市）
  const itin = await planTrip({ kb, trip: trip("さん都心を回りたい", "大阪駅") });
  const names = namesOf(itin).join("|");
  assert.match(names, /東京/);
  assert.match(names, /大阪/);
  assert.match(names, /名古屋/);
  assert.ok(!/都心/.test(itin.coverage?.text ?? ""), itin.coverage?.text);
  assert.ok(itin.warnings.some((w) => /「三都心」は/.test(w)));
});

test("辞書に無い呼び名も、AIの読み取りがあれば地名に直して組む", async () => {
  const note = "西の三大都市をめぐりたい";
  const query = await understandRequest(note, [], 100);
  query.phrases = [{ phrase: "西の三大都市", meaning: "関西の主要都市",
                     names: ["大阪", "京都", "神戸"], ambiguous: true }];
  const itin = await planTrip({ kb, trip: trip(note), query });
  const names = namesOf(itin).join("|");
  assert.match(names, /大阪/);
  assert.match(names, /京都/);
  assert.match(names, /神戸/);
  assert.ok(itin.warnings.some((w) => /「西の三大都市」は.*AIの読み取りです/.test(w)));
});
