// チャットに書いた条件を読み取るテスト（packages/core/src/chatread.js）。
//
// 書いたことが設定より勝つので、読み違えると「頼んでいない日・駅」で
// 組まれます。拾いすぎ（「明日から」を出発地と読むなど）を特に見ます。

import test from "node:test";
import assert from "node:assert/strict";
import { hasSubstance, readChat, stripOriginPhrase } from "../packages/core/src/chatread.js";

// 2026年10月11日（日）10時
const NOW = new Date(2026, 9, 11, 10, 0);
const ymd = (d) => d && `${d.getMonth() + 1}/${d.getDate()}`;

test("日付・日数・出発地・まわる場所をまとめて読む", () => {
  const r = readChat("明日から1泊2日で、大阪から。穴場多めで", NOW);
  assert.equal(ymd(r.start), "10/12");
  assert.equal(r.nights, 1);
  assert.equal(r.origin, "大阪");
  assert.equal(r.mix, 75);
});

test("「明日から」「朝から」は出発地にしない", () => {
  assert.equal(readChat("明日から箱根", NOW).origin, null);
  assert.equal(readChat("朝から晩まで遊ぶ", NOW).origin, null);
  assert.equal(readChat("9時から動きたい", NOW).origin, null);
});

test("駅名と「発」も出発地として読む", () => {
  assert.equal(readChat("新宿駅から日帰りで鎌倉", NOW).origin, "新宿駅");
  assert.equal(readChat("名古屋発 二泊三日", NOW).origin, "名古屋");
  assert.equal(readChat("東京駅を出発して", NOW).origin, "東京駅");
});

test("曜日・日付・日数の言いかた", () => {
  assert.equal(ymd(readChat("来週の土曜に箱根へ", NOW).start), "10/17");
  assert.equal(ymd(readChat("10月20日から3日間", NOW).start), "10/20");
  assert.equal(readChat("10月20日から3日間", NOW).nights, 2);
  assert.equal(readChat("二泊三日", NOW).nights, 2);
  assert.equal(readChat("日帰りで", NOW).nights, 0);
  // 過ぎた日付は来年
  assert.equal(readChat("1月5日", NOW).start.getFullYear(), 2027);
});

test("帰りの時刻と出発の時刻を取り違えない", () => {
  const r = readChat("9時に出発して、19時までに帰りたい", NOW);
  assert.equal(r.departHour, 9);
  assert.equal(r.returnHour, 19);
});

test("人数・予算・混雑", () => {
  const r = readChat("家族4人で予算3万円、混雑は避けたい", NOW);
  assert.equal(r.people, 4);
  assert.equal(r.budgetYen, 30000);
  assert.equal(r.avoidCrowds, true);
  assert.equal(readChat("ふたりで", NOW).people, 2);
});

test("条件の書いていない文は、何も読まない", () => {
  const r = readChat("温泉でゆっくりしたい", NOW);
  assert.equal(r.found, false);
  assert.deepEqual(r.labels, []);
});

test("条件だけの返信と、中身のある返信を分ける", () => {
  assert.equal(hasSubstance(readChat("明日にして", NOW).rest), false);
  assert.equal(hasSubstance(readChat("大阪からでお願い", NOW).rest), false);
  assert.equal(hasSubstance(readChat("明日、鎌倉で食べ歩き", NOW).rest), true);
});

test("「東京に近いところ」は、東京を出発地として読み、晴れ・近場も並べる", () => {
  const r = readChat("明日晴れている東京に近いところに行きたい(日帰り)", NOW);
  assert.equal(r.origin, "東京");
  assert.equal(r.nights, 0);
  assert.equal(r.sunny, true);
  assert.ok(r.labels.includes("晴れる所"));
  assert.ok(r.labels.includes("近場"));
});

test("「青森駅でスタート」は出発地。青春18きっぷ・日本縦断も札に出す", () => {
  const now = new Date(2026, 9, 11, 20, 0);
  const r = readChat("日本縦断をしたい。(青春18きっぷ5日間用で明日から青森駅でスタート)", now);
  assert.equal(r.origin, "青森駅");
  assert.equal(r.nights, 4);
  assert.equal(r.start.getDate(), 12);
  assert.ok(r.labels.includes("普通列車のみ"), r.labels.join(","));
  assert.ok(r.labels.includes("日本縦断（片道）"), r.labels.join(","));
  assert.equal(readChat("仙台駅スタートで3日間", now).origin, "仙台駅");
});

test("出発地の名前は、行き先を探す文から消す", () => {
  assert.ok(!stripOriginPhrase("明日から青森駅でスタート", "青森駅").includes("青森"));
  assert.ok(!stripOriginPhrase("東京駅から鎌倉へ", "東京駅").includes("東京"));
  // 出発地でない名前は残します。
  assert.ok(stripOriginPhrase("鎌倉で寺めぐり", "東京駅").includes("鎌倉"));
});
