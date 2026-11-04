// 未知の要望への汎用の流れ（packages/core/src/quest.js。Issue #443）の試験。
// ネット検索は手元の関数で置き換えます（外へは通信しません）。

import assert from "node:assert/strict";
import test from "node:test";

import { createCore } from "../packages/core/index.mjs";
import { createDefaultTools } from "../packages/core/src/tools.js";
import { PACE, ROAD_FACTOR, cutStages, locateTown, readMode, readQuest, runQuest }
  from "../packages/core/src/quest.js";

const core = await createCore();
const kb = core.kb;
const TOKYO = { name: "東京駅", lat: 35.681236, lng: 139.767125 };

// 「日本100名城」の一覧の検索結果（抜粋の形）。
const CASTLES = [
  { title: "日本100名城 一覧", url: "https://example.com/100",
    snippet: "五稜郭 松前城 弘前城 若松城 水戸城 箕輪城 金山城 鉢形城 川越城 佐倉城 江戸城 八王子城 小田原城 甲府城 松代城 上田城 小諸城 松本城 高遠城" },
  { title: "100名城 中部", url: "https://example.com/chubu",
    snippet: "犬山城、名古屋城、岩村城、金沢城、高田城。松本駅から歩いて松本城へ。" },
];
const WEST = [{ title: "100名城 西日本", url: "https://example.com/west",
  snippet: "彦根城、姫路城、竹田城、大阪城、備中松山城、丸亀城、高知城、熊本城" }];
const fakeSearch = (pick) => {
  const asked = [];
  const fn = async (q) => { asked.push(q); return pick(q, asked.length); };
  fn.asked = asked;
  return fn;
};

test("要望の形を読む（一覧・道・どちらでもない）", () => {
  assert.deepEqual(
    (({ kind, target, category }) => ({ kind, target, category }))(readQuest("日本100名城を回りたい")),
    { kind: "list", target: "日本100名城", category: "城" });
  assert.equal(readQuest("続日本１００名城をめぐる").target, "続日本100名城");
  assert.equal(readQuest("日本百名山に登りたい").category, "山");
  assert.equal(readQuest("日本の滝百選を見て回る").category, "滝");
  assert.equal(readQuest("全国の道の駅を全部回りたい").category, "道の駅");

  const r = readQuest("中山道を自転車で走破したい");
  assert.equal(r.kind, "route");
  assert.equal(r.target, "中山道");
  assert.equal(r.mode, "bicycle");
  assert.ok(r.known.along.length >= 5, "中山道の沿う街は手元にある");
  assert.equal(readQuest("日光街道を歩いて踏破").kind, "route");
  assert.equal(readQuest("日光街道を歩いて踏破").mode, "walk");

  // いつもの流れで足りるものは、ここでは拾いません。
  assert.equal(readQuest("東海道五十三次をたどりたい"), null, "走破・自転車などが無ければ journeys の流れ");
  assert.equal(readQuest("京都で紅葉を見たい"), null);
  assert.equal(readQuest("夏目友人帳の舞台をめぐりたい"), null);
  assert.equal(readQuest("温泉のおすすめ3選"), null, "数の小さい「◯選」は一覧と読まない");
  assert.equal(readMode("電車で回りたい"), "transit", "「電車で」の「車で」を車と読まない");
});

test("距離から日程へ（自転車は1日50km）", () => {
  assert.equal(PACE.bicycle.perDayKm, 50);
  const towns = ["東京", "大宮", "高崎", "軽井沢"].map((n) => locateTown(n, kb));
  assert.ok(towns.every(Boolean), "沿う街の座標が引ける");
  const stages = cutStages(towns, 50, kb);
  for (const s of stages) assert.ok(s.km <= 50 * 1.2 + 0.1, `1日が長すぎます: ${s.from}→${s.to} ${s.km}km`);
  assert.equal(stages[0].from, "東京");
  assert.equal(stages.at(-1).to, "軽井沢");
  // つながっている（前の日の終わり＝次の日の始まり）
  for (let i = 1; i < stages.length; i++) assert.equal(stages[i].from, stages[i - 1].to);
  const total = stages.reduce((a, s) => a + s.km, 0);
  assert.ok(total > 100 && total < 200, `東京→軽井沢の道のりの目安: ${total}`);
  assert.ok(ROAD_FACTOR > 1);
  // 長い区間は、途中の街で泊まる
  assert.ok(stages.some((s) => s.midway), "大宮→高崎は1日では走れないので途中泊");
});

test("100名城: 一覧を調べて照らし、県ごとにまとめ、近くから現実的な1回目を出す", async () => {
  const search = fakeSearch((q) => (/近畿/.test(q) ? WEST : /宿|レンタ/.test(q) ? [] : CASTLES));
  const r = await core.research({ wish: "日本100名城を回りたい", from: "東京駅", days: 2, date: "2026-11-07" }, { search });
  const q = r.research.quest;
  assert.equal(r.research.status, "quest");
  assert.equal(q.kind, "list");
  assert.equal(q.verified, true);
  assert.ok(search.asked.slice(0, 3).every((x) => x.startsWith("日本100名城 一覧")), search.asked.join(" / "));
  const names = q.matched.map((s) => s.name);
  for (const n of ["松本城", "姫路城", "熊本城", "江戸城"]) assert.ok(names.includes(n), `${n} が照らせていません`);
  assert.ok(!names.includes("松本駅") && !names.some((n) => /通り|駅$/.test(n)), `城でないものが混ざっています: ${names}`);
  // 都道府県ごと。出発地（東京）に近い県が先。
  assert.equal(q.groups[0].prefecture, "東京都");
  assert.ok(q.groups.length >= 15);
  // 全部回る目安は、地方ごとに分かれる
  assert.ok(q.rounds.some((x) => x.block === "九州") && q.rounds.some((x) => x.block === "関東"));
  assert.equal(q.totalDays, q.rounds.reduce((a, x) => a + x.days, 0));
  // 1回目は東京の近く（60km 以内）にまとまり、旅程になる
  for (const s of q.plan.order) assert.ok(["東京都", "埼玉県", "神奈川県"].includes(s.prefecture), `${s.name} ${s.prefecture}`);
  assert.ok(q.plan.order.length >= 2 && q.plan.order.length <= 2 * PACE.transit.perDaySpots);
  const visited = r.itinerary.days.flatMap((d) => d.items).filter((i) => i.kind === "spot").map((i) => i.title);
  assert.ok(visited.includes("江戸城"), visited.join(","));
  for (const n of q.plan.dropped ?? []) assert.match(r.research.message, new RegExp(n));
  assert.match(r.research.message, /日本100名城/);
  assert.equal(r.request.wish, "日本100名城を回りたい");
  assert.ok(r.research.sources.some((s) => s.url === "https://example.com/west"));
});

test("100名城: 検索が使えないときは、確かめていないと書いて収録の城から出す", async () => {
  const tools = createDefaultTools({ kb });
  const q = await runQuest({ wish: "日本100名城を回りたい", tools, origin: TOKYO, days: 1 });
  assert.equal(q.status, "answered");
  assert.equal(q.verified, false);
  assert.equal(q.searches, 0);
  assert.match(q.message, /確かめていません/);
  assert.ok(q.plan.order.length >= 1);
});

test("中山道を自転車で: 道のりを1日50kmで区切り、宿とレンタサイクルを検索で補う", async () => {
  const search = fakeSearch((q) => (/レンタサイクル/.test(q)
    ? [{ title: "東京 日本橋のレンタサイクル", url: "https://example.com/bike", snippet: "東京駅・日本橋のそば。乗り捨てできます" }]
    : /宿/.test(q) ? [{ title: "大宮の宿", url: "https://example.com/omiya", snippet: "大宮駅前。自転車を部屋に置けます" }] : []));
  const r = await core.research({ wish: "中山道を自転車で走破したい", from: "東京駅", date: "2026-11-07" }, { search });
  const q = r.research.quest;
  assert.equal(r.research.status, "quest");
  assert.equal(q.kind, "route");
  assert.equal(q.mode, "bicycle");
  assert.deepEqual([q.along[0], q.along.at(-1)], ["東京", "京都"], "東京から近い端（日本橋側）から");
  assert.ok(q.totalKm > 450 && q.totalKm < 700, `中山道は約530km: ${q.totalKm}`);
  assert.equal(q.totalDays, q.stages.length);
  assert.ok(q.totalDays >= 10 && q.totalDays <= 16, `${q.totalDays}日`);
  for (const s of q.stages) assert.ok(s.km <= 60.1, `${s.day}日目が長すぎます: ${s.km}km`);
  assert.ok(q.stages.some((s) => s.to === "軽井沢"));
  assert.match(r.research.message, /1日50km/);
  // 足りない情報（レンタサイクル・宿）を補う。条件は先方で確かめる、と書く。
  const rental = q.supplements.find((x) => x.need === "rental");
  assert.ok(rental?.found);
  assert.equal(rental.sources[0].url, "https://example.com/bike");
  assert.match(rental.note, /確かめて/);
  assert.ok(q.supplements.find((x) => x.need === "lodging")?.found);
  assert.ok(search.asked.length <= 2, "補う検索は2回まで");
  // 自転車で数百km は1つの旅程にしない
  assert.equal(r.itinerary, undefined);
  // 道具の記録
  const tools = q.trace.map((t) => t.action?.tool).filter(Boolean);
  assert.ok(tools.includes("web_search"));
});

test("中山道を3日ずつ: 分けて走る回の案を出す", async () => {
  const r = await core.research({ wish: "中山道を自転車で走破したい", from: "東京駅", days: 3 }, { search: null });
  const q = r.research.quest;
  assert.equal(r.research.status, "quest");
  assert.ok(q.rounds.length >= 4);
  assert.ok(q.rounds.every((x) => x.days <= 3));
  assert.equal(q.rounds[0].from, "東京");
  assert.equal(q.rounds.at(-1).to, "京都");
  assert.match(r.research.message, /3日ずつなら\d+回に分ける/);
  assert.deepEqual(q.supplements, [], "検索が使えなければ補わない");
});

test("道筋の分からない道は、正直に聞く", async () => {
  const tools = createDefaultTools({ kb });
  const q = await runQuest({ wish: "ほげほげ街道を歩いて踏破したい", tools, origin: TOKYO });
  assert.equal(q.status, "out_of_scope");
  assert.ok(q.question?.question);
});
