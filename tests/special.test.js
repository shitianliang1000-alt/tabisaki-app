// 特殊な旅程（packages/core/src/special.js。Issue #442）の試験。
// 見分け（当たるべき・当たってはいけない書きかた）と、形ごとの処理。

import assert from "node:assert/strict";
import test from "node:test";

import { createCore } from "../packages/core/index.mjs";
import { createDefaultTools } from "../packages/core/src/tools.js";
import { runResearch } from "../packages/core/src/research.js";
import { CAPITALS, SPECIAL_MODES, WORLD_HERITAGE, detectSpecial, handleSpecial, seishunSeason }
  from "../packages/core/src/special.js";
import { findPlace } from "../packages/core/src/places.js";

const core = await createCore();
const kb = core.kb;
const tokyo = findPlace("東京駅");

// 当たるべき書きかた（形・一緒に読む乗り物の指定）。
const SHOULD_HIT = [
  ["最長片道切符で旅したい", "longest_ticket"],
  ["最長往復きっぷに挑戦", "longest_ticket"],
  ["日本一周がしたい", "japan_loop"],
  ["日本列島縦断の旅", "japan_loop"],
  ["本州横断してみたい", "japan_loop"],
  ["青春18きっぷで日本一周", "japan_loop", ["seishun18"]],
  ["青春１８きっぷで出かけたい", "seishun18"],
  ["18きっぷの旅", "seishun18"],
  ["寝台列車に乗りたい", "sleeper"],
  ["サンライズ瀬戸で高松へ", "sleeper"],
  ["夜行列車の旅", "sleeper"],
  ["船旅をしたい", "cruise"],
  ["長距離フェリーで北海道へ", "cruise"],
  ["クルーズ船の旅", "cruise"],
  ["廃線跡を歩きたい", "haisen"],
  ["廃駅めぐり", "haisen"],
  ["秘境駅に行ってみたい", "hikyo_station"],
  ["日本の最北端に立ちたい", "edges"],
  ["東西南北の端を制覇", "edges"],
  ["四極めぐり", "edges"],
  ["世界遺産を全部回りたい", "world_heritage"],
  ["日本の世界遺産を制覇したい", "world_heritage"],
  ["世界遺産全26件めぐり", "world_heritage"],
  ["県庁所在地を踏破したい", "capitals"],
  ["47都道府県を制覇したい", "capitals"],
  ["寝台列車で廃線跡へ", "haisen", ["sleeper"]],
];

// 当たってはいけない書きかた（誤検出）。いつもの流れで組めます。
const SHOULD_MISS = [
  "京都の世界遺産を見たい",          // 1つの土地の世界遺産（集めきる語が無い）
  "世界遺産の姫路城に行きたい",
  "横浜でナイトクルーズ",            // 湾内の遊覧はその土地の楽しみかた
  "保津川下りと遊覧船クルーズ",
  "夜行バスで大阪へ",
  "寝台バスで行きたい",
  "47都道府県の名物を食べたい",      // 集めきる旅ではない
  "四国一周したい",                 // 地方の一周は、いつもの流れ（四国に絞る）で組む
  "温泉と海をゆっくり",
  "端っこの席でのんびり列車旅",
  "東海道五十三次をたどりたい",      // 名のある旅（journeys.js）だが、専用の処理は要らない
  "",
];

test("当たるべき書きかたが、正しい形に振り分けられる", () => {
  for (const [text, mode, mods = []] of SHOULD_HIT) {
    const d = detectSpecial(text);
    assert.ok(d, `「${text}」が読み取れていません`);
    assert.equal(d.mode, mode, `「${text}」→ ${d.mode}（${mode} のはず）`);
    assert.deepEqual(d.modifiers, mods, `「${text}」の乗り物の指定`);
  }
});

test("当たってはいけない書きかたは、読み取らない（誤検出しない）", () => {
  for (const text of SHOULD_MISS) {
    assert.equal(detectSpecial(text), null, `「${text}」を ${detectSpecial(text)?.mode} と読んでいます`);
  }
});

test("形の一覧と、データの数", () => {
  assert.deepEqual(SPECIAL_MODES.map((m) => m.id).sort(), ["capitals", "cruise", "edges", "haisen", "hikyo_station",
    "japan_loop", "longest_ticket", "seishun18", "sleeper", "world_heritage"]);
  assert.equal(WORLD_HERITAGE.length, 26);
  assert.equal(CAPITALS.length, 47);
  assert.equal(new Set(CAPITALS.map((c) => c.prefecture)).size, 47);
  for (const c of CAPITALS) assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lng), `${c.city} の座標がありません`);
});

const run = (text, opts = {}) => handleSpecial({ text, kb, origin: tokyo, days: 3, date: "2026-11-07", ...opts });

test("最長片道切符: ソルバーが無ければ、そう言って全国を回る旅にする", async () => {
  const r = await run("最長片道切符で旅したい");
  assert.equal(r.status, "needs_solver");
  assert.match(r.notes.join(), /#431/);
  assert.equal(r.request.wish, "最長片道切符で旅したい");
});

test("最長片道切符: 専用ソルバー（#431）につなぐと、その経路から組む", async () => {
  const asked = [];
  const longestTicket = async (kind, { from }) => {
    asked.push([kind, from]);
    return { route: ["稚内駅", "旭川駅", "函館駅", "青森駅", "仙台駅", "東京駅", "名古屋駅", "大阪駅", "広島駅", "博多駅", "肥前山口駅"], km: 10900 };
  };
  const r = await run("最長片道切符で旅したい", { solvers: { longestTicket } });
  assert.deepEqual(asked, [["oneway", "東京駅"]]);
  assert.equal(r.status, "handled");
  assert.equal(r.route.stations[0], "稚内駅");
  assert.equal(r.route.km, 10900);
  assert.match(r.request.wish, /^稚内・.*肥前山口をめぐる鉄道の旅$/);
  const round = await run("最長往復切符", { solvers: { longestTicket } });
  assert.equal(asked.at(-1)[0], "round");
  assert.equal(round.name, "最長往復切符");
  // ソルバーが失敗しても止まらない
  const broken = await run("最長片道切符", { solvers: { longestTicket: async () => { throw new Error("timeout"); } } });
  assert.equal(broken.status, "needs_solver");
  assert.match(broken.notes.join(), /失敗しました（timeout）/);
});

test("日本一周: 日数が足りなければ、そう言う。青春18きっぷなら普通列車だけ", async () => {
  const r = await run("青春18きっぷで日本一周したい");
  assert.equal(r.mode, "japan_loop");
  assert.equal(r.request.transport, "local");
  assert.ok(r.rules.some((x) => /普通列車/.test(x)));
  assert.match(r.notes.join(), /14日ほど/);
  const v = await run("日本縦断");
  assert.ok(v.journey.oneWay);
  assert.equal(v.stops[0].name, "青森");
});

test("青春18きっぷ: 使える時期と、3日・5日の連続", async () => {
  assert.equal(seishunSeason("2026-08-01").name, "夏");
  assert.equal(seishunSeason("2026-12-31").name, "冬");
  assert.equal(seishunSeason("2027-01-05").name, "冬");
  assert.equal(seishunSeason("2026-03-15").name, "春");
  assert.equal(seishunSeason("2026-11-07"), null);
  const off = await run("青春18きっぷで出かけたい", { days: 2 });
  assert.equal(off.request.transport, "local");
  assert.match(off.notes.join(), /外れています/);
  assert.match(off.notes.join(), /3日間用か5日間用/);
  const ok = await run("青春18きっぷで出かけたい", { days: 5, date: "2026-08-01" });
  assert.equal(ok.season, "夏");
  assert.ok(!/外れています|3日間用/.test(ok.notes.join()));
});

test("寝台列車: サンライズで着いた朝から組む（瀬戸か出雲かは書きかたで）", async () => {
  const seto = await run("サンライズ瀬戸でうどんを食べに");
  assert.equal(seto.train.name, "サンライズ瀬戸");
  assert.equal(seto.request.from, "高松駅");
  assert.equal(seto.request.date, "2026-11-08", "一晩乗るので翌日から");
  assert.equal(seto.request.days, 2);
  const izumo = await run("寝台列車で出雲大社へ");
  assert.equal(izumo.train.name, "サンライズ出雲");
  assert.equal(izumo.request.from, "松江駅");
  assert.deepEqual(izumo.question.choices, ["サンライズ出雲のまま", "サンライズ瀬戸にする"]);
  const far = await handleSpecial({ text: "寝台列車に乗りたい", kb, origin: findPlace("博多駅"), days: 3, date: "2026-11-07" });
  assert.match(far.notes.join(), /まず東京駅/);
});

test("船旅: 出発地に近い乗り場の長距離フェリーで、着いた先から組む", async () => {
  const north = await run("船旅で北海道へ");
  assert.equal(north.ferry.port, "大洗港");
  assert.equal(north.request.from, "札幌駅");
  assert.doesNotMatch(north.request.wish, /苫小牧/, "「小牧」（愛知）と読まれないように");
  const osaka = await handleSpecial({ text: "フェリーで旅したい", kb, origin: findPlace("大阪駅"), days: 2, date: "2026-11-07" });
  assert.equal(osaka.ferry.port, "大阪南港");
  assert.equal(osaka.request.date, "2026-11-08");
  const short = await run("長距離フェリーで北海道へ", { days: 1 });
  assert.equal(short.status, "partial");
  assert.equal(short.request, null);
});

test("廃線跡: 届く範囲の収録の廃線跡を、必ず立ち寄るにする", async () => {
  const r = await run("廃線跡を歩きたい", { days: 1 });
  const names = r.stops.map((s) => s.name);
  assert.ok(names.includes("アプトの道"), names.join(","));
  assert.ok(!names.includes("品川インターシティ"), "操車場の跡地の再開発は廃線跡ではない");
  assert.deepEqual(r.request.must, r.stops.map((s) => s.id));
  const hk = await handleSpecial({ text: "廃線跡", kb, origin: findPlace("札幌駅"), days: 2, date: "2026-11-07" });
  assert.ok(hk.stops.some((s) => s.name === "タウシュベツ川橋梁"));
});

test("秘境駅: 書かれた駅か、出発地に近い県の駅と、近くの名所", async () => {
  const named = await run("坪尻駅に行きたい、秘境駅が好き");
  assert.equal(named.station.name, "坪尻駅");
  assert.equal(named.stops[1].name, "大歩危峡");
  const near = await handleSpecial({ text: "秘境駅", kb, origin: findPlace("札幌駅"), days: 2, date: "2026-11-07" });
  assert.equal(near.station.name, "小幌駅");
  assert.match(near.notes.join(), /帰りの列車/);
});

test("日本の端: 1つなら岬を必ず立ち寄るに、四極なら旅を分ける", async () => {
  const n = await handleSpecial({ text: "日本の最北端に行きたい", kb, origin: findPlace("札幌駅"), days: 2, date: "2026-11-07" });
  assert.deepEqual(n.stops.map((s) => s.name), ["宗谷岬"]);
  assert.equal(n.request.must.length, 1);
  const all = await run("東西南北の端を制覇したい");
  assert.equal(all.stops.length, 4);
  assert.equal(all.legs.length, 2, "北海道と九州で2回の旅");
  const island = await run("日本最南端の有人島へ");
  assert.equal(island.stops[0].name, "波照間島");
});

test("世界遺産全制覇: 26件を地方ごとの旅に分け、近い地方から組む", async () => {
  const r = await run("世界遺産を全部回りたい");
  assert.equal(r.total, 26);
  assert.equal(r.legs.flatMap((l) => l.sites).length, 26);
  assert.equal(r.legs[0].block, "関東", "東京から出るなら関東から");
  const first = r.legs[0].sites.map((s) => s.name);
  assert.ok(first.includes("日光の社寺") && first.includes("富岡製糸場と絹産業遺産群"), first.join(","));
  assert.ok(!r.request.must.length || r.request.must.length <= 6);
  assert.match(r.notes.join(), /小笠原諸島/);
  const fromFukuoka = await handleSpecial({ text: "世界遺産を制覇したい", kb, origin: findPlace("博多駅"), days: 2, date: "2026-11-07" });
  assert.equal(fromFukuoka.legs[0].block, "九州・沖縄");
  const munakata = fromFukuoka.legs[0].sites.find((s) => s.name.includes("宗像"));
  assert.match(munakata.note, /上陸できません/);
});

test("県庁所在地踏破: 47都市を回る順に並べ、日ごとに区切る", async () => {
  const r = await run("県庁所在地を踏破したい");
  assert.equal(r.order.length, 47);
  assert.equal(r.order[0].city, "東京（新宿）");
  assert.equal(r.schedule.length, 3);
  const cities = r.schedule.flatMap((d) => d.stops);
  assert.ok(cities.length >= 3);
  for (const s of cities) assert.ok(s.moveMinutes >= 0 && s.spot?.name, `${s.city} に立ち寄る場所がありません`);
  assert.equal(r.legs.reduce((a, l) => a + l.days.flat().length, 0), 47, "全部の都市がどこかの旅に入る");
  assert.equal(r.request, null, "この形は、日ごとの予定をここで出す");
  const pref = await run("47都道府県を制覇したい");
  assert.match(pref.notes[0], /県庁所在地を訪ねる旅として読んでいます/);
});

test("core.special: 形ごとの条件で旅程まで組む", async () => {
  const base = { from: "東京駅", days: 2, date: "2026-11-07" };
  const none = await core.special({ ...base, wish: "温泉と海をゆっくり" });
  assert.equal(none.special, null);

  const heritage = await core.special({ ...base, wish: "世界遺産を全部回りたい" });
  assert.equal(heritage.special.mode, "world_heritage");
  const visited = heritage.itinerary.days.flatMap((d) => d.items).filter((i) => i.kind === "spot").map((i) => i.title);
  assert.ok(["日光東照宮", "富岡製糸場", "国立西洋美術館"].some((n) => visited.includes(n)), visited.join(","));
  assert.equal(heritage.request.wish, "世界遺産を全部回りたい", "希望文は書いたまま返す");

  const sleeper = await core.special({ ...base, wish: "サンライズ瀬戸に乗りたい" });
  assert.equal(sleeper.request.origin.name, "高松駅");

  const s18 = await core.special({ ...base, wish: "青春18きっぷで出かけたい" });
  assert.equal(s18.request.transport, "local");

  const caps = await core.special({ ...base, wish: "県庁所在地を踏破したい" });
  assert.ok(caps.special.schedule.length === 2 && !caps.itinerary);
});

test("Research Agent: 特殊な旅はネットで調べずに、専用の処理へ回す", async () => {
  const asked = [];
  const search = async (q) => { asked.push(q); return []; };
  const r = await core.research({ wish: "秘境駅に行ってみたい", from: "名古屋駅", days: 2, date: "2026-11-07" }, { search });
  assert.equal(r.research.status, "special");
  assert.equal(r.research.special.mode, "hikyo_station");
  assert.equal(r.special.station.prefecture.length > 0, true);
  assert.ok(r.itinerary.days.length >= 1);
  assert.equal(asked.length, 0, "ネットでは調べない");

  const tools = createDefaultTools({ kb, search });
  const j = await tools.call("search_special_journey", { text: "青春18きっぷで日本一周" });
  assert.equal(j.data.journey.name, "日本一周");
  assert.deepEqual(j.data.special, { mode: "japan_loop", name: "日本一周", modifiers: ["seishun18"] });
  const plain = await runResearch({ wish: "東海道五十三次をたどりたい", tools });
  assert.equal(plain.status, "kb", "専用の処理が要らない名のある旅は、これまでどおり");
});
