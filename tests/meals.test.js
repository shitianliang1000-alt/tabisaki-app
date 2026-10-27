// 昼食・夕食を、その土地のものにするテスト。
//
// これまで食事の欄は「昼食 / 出雲で。お店は地図から選べます」でした。
// 時刻は正しいのに、旅程として何も言っていません。
//
// ただしこのアプリは店を持っていません。だから確かめたいのは、
// **持っていない情報を、持っているふりで埋めていないか**です。
//   ・知らない土地では、名物の話をしない
//   ・指定された向きに合う名物が無ければ、料理を作らない
//   ・店の名前は、収録にあるものだけ（しかも開いている時間だけ）

import assert from "node:assert/strict";
import test from "node:test";

import {
  DIETS, FOOD_GENRES, attachMeals, dietNote, dietQuery, isFoodSpot, localFoodsFor, mealDetail, nearbyFoodSpot, normalizeDiet, pickDish,
} from "../packages/core/src/meals.js";
import { makeTrip } from "../packages/core/src/trip.js";

const d = (s) => new Date(s);
const at = (km) => 34.348 + km / 111;

const spot = (id, name, category, over = {}) => ({
  id, name, category, lat: 34.348, lng: 134.047,
  genres: [], description: `${name}です。`, fame_tier: "known", ...over,
});

test("名物は都道府県で決まる", () => {
  assert.ok(localFoodsFor("香川県").some((f) => f.name === "讃岐うどん"));
  assert.ok(localFoodsFor("島根県").some((f) => f.name === "出雲そば"));
});

test("知らない土地では、名物を作らない", () => {
  assert.deepEqual(localFoodsFor("架空県"), []);
  assert.deepEqual(localFoodsFor(null), []);
  assert.equal(pickDish("架空県"), null);
});

test("すべての名物に、選べる向きが付いている", () => {
  const ids = new Set(FOOD_GENRES.map((g) => g.id));
  for (const pref of ["北海道", "東京都", "香川県", "沖縄県"]) {
    for (const f of localFoodsFor(pref)) {
      assert.ok(ids.has(f.genre), `${f.name} の ${f.genre}`);
      assert.notEqual(f.genre, "any");
    }
  }
});

test("向きを指定すると、その向きの名物になる", () => {
  assert.equal(pickDish("香川県", { genre: "noodle" }).name, "讃岐うどん");
  assert.equal(pickDish("香川県", { genre: "meat" }).name, "骨付鳥");
});

test("向きに合う名物が無ければ、料理を作らない", () => {
  // 香川県の表に「海鮮」はありません。無いものを出すより、出しません。
  assert.equal(pickDish("香川県", { genre: "seafood" }), null);
});

test("選び方は毎回同じ（組み直して食べるものが変わらない）", () => {
  const a = pickDish("島根県", { seed: 3 });
  const b = pickDish("島根県", { seed: 3 });
  assert.equal(a.name, b.name);
  assert.notEqual(pickDish("島根県", { seed: 0 }).name,
                  pickDish("島根県", { seed: 1 }).name);
});

test("収録の食事どころだけを、食事どころとして扱う", () => {
  assert.equal(isFoodSpot(spot("a", "中村藤吉本店", "グルメ")), true);
  assert.equal(isFoodSpot(spot("b", "ウオッセ21", "市場")), true);
  assert.equal(isFoodSpot(spot("c", "松山城", "城")), false);
  assert.equal(isFoodSpot(spot("d", "何か", "城", { genres: ["food"] })), true);
});

test("歩ける距離にある食事どころだけを出す", () => {
  const near = spot("n", "うどん屋", "グルメ", { lat: at(0.5), open: 10, close: 15 });
  const far = spot("f", "遠い市場", "市場", { lat: at(9), open: 9, close: 17 });
  const got = nearbyFoodSpot([far, near], { lat: 34.348, lng: 134.047 },
                             d("2026-09-12T12:00"));
  assert.equal(got.id, "n");
});

test("その時間に閉まっている店は出さない", () => {
  // 15時閉店のうどん屋を、19時の夕食に出してはいけません。
  const s = spot("n", "うどん屋", "グルメ", { open: 10, close: 15 });
  assert.equal(nearbyFoodSpot([s], { lat: 34.348, lng: 134.047 },
                              d("2026-09-12T19:00")), null);
  assert.ok(nearbyFoodSpot([s], { lat: 34.348, lng: 134.047 },
                           d("2026-09-12T12:00")));
});

test("説明は、持っている情報だけで書く", () => {
  assert.match(mealDetail({ regionName: "高松", dish: { name: "讃岐うどん" } }),
               /讃岐うどん/);
  assert.match(mealDetail({ regionName: "高松", spot: { name: "中村藤吉本店" } }),
               /中村藤吉本店/);
  // 名物も店も分からないときは、名物の話をしません
  const bare = mealDetail({ regionName: "高松" });
  assert.doesNotMatch(bare, /名物/);
  assert.match(bare, /地図/);
});

/** 高松（香川県）の1日。昼と夕の2食。 */
const itinFor = () => ({
  days: [{ date: d("2026-09-12T09:00"), items: [
    { id: "s1", kind: "spot", spotId: "s1", start: d("2026-09-12T10:00"),
      title: "栗林公園", place: spot("s1", "栗林公園", "庭園",
                                     { prefecture: "香川県" }) },
    { id: "m1", kind: "meal", title: "昼食", start: d("2026-09-12T12:00"),
      end: d("2026-09-12T13:00"),
      near: { lat: 34.348, lng: 134.047, regionName: "高松" } },
    { id: "m2", kind: "meal", title: "夕食", start: d("2026-09-12T18:30"),
      end: d("2026-09-12T19:30"),
      near: { lat: 34.348, lng: 134.047, regionName: "高松" } },
  ] }],
});

test("食事に、その土地の名物を当てる", () => {
  const itin = itinFor();
  const n = attachMeals(itin, { spots: [] });
  assert.equal(n, 2);
  const [, m1, m2] = itin.days[0].items;
  assert.equal(m1.food.dish, "讃岐うどん");
  // 同じ名物が続きません
  assert.notEqual(m2.food.dish, m1.food.dish);
  assert.match(m1.detail, /讃岐うどん/);
  // 地図に渡す言葉も、その料理になります
  assert.equal(m1.food.query, "讃岐うどん");
});

test("収録に食事どころがあれば、そちらの名前を出す", () => {
  const itin = itinFor();
  const udon = spot("u", "さぬきうどん巡り", "グルメ",
                    { lat: at(0.3), open: 10, close: 15 });
  attachMeals(itin, { spots: [udon] });
  const [, m1, m2] = itin.days[0].items;
  assert.equal(m1.food.spotName, "さぬきうどん巡り");
  // 15時閉店なので、夕食には出しません（名物のほうに落ちます）
  assert.equal(m2.food.spotName, null);
  assert.ok(m2.food.dish);
});

test("向きを指定すると、その向きだけになる", () => {
  const itin = itinFor();
  attachMeals(itin, { spots: [], genre: "meat" });
  const [, m1] = itin.days[0].items;
  assert.equal(m1.food.dish, "骨付鳥");
});

test("向きに合う名物が無い土地では、検索語だけを渡す", () => {
  const itin = itinFor();
  attachMeals(itin, { spots: [], genre: "seafood" });
  const [, m1] = itin.days[0].items;
  assert.equal(m1.food.dish, null);
  assert.equal(m1.food.query, "海鮮");
  assert.match(m1.detail, /海鮮/);
});

test("知らない土地では、食事の欄を変えない", () => {
  const itin = itinFor();
  itin.days[0].items[0].place.prefecture = "架空県";
  const n = attachMeals(itin, { spots: [] });
  assert.equal(n, 0);
  assert.equal(itin.days[0].items[1].food.dish, null);
});

test("条件に、食べたいものの向きが入る", () => {
  assert.equal(makeTrip({}).foodGenre, "any");
  assert.equal(makeTrip({ foodGenre: "noodle" }).foodGenre, "noodle");
  // 知らない値は、おまかせに丸めます
  assert.equal(makeTrip({ foodGenre: "raw" }).foodGenre, "any");
});

test("おまかせの食事に、甘いものは選ばない", () => {
  // 「夕食 / ぜんざい」が出ていました。名物ではありますが、夕食では
  // ありません。選んで指定されたときだけ出します。
  for (let seed = 0; seed < 6; seed += 1) {
    assert.notEqual(pickDish("島根県", { seed }).name, "ぜんざい");
  }
  assert.equal(pickDish("島根県", { genre: "sweets" }).name, "ぜんざい");
});

// --- 食べられないもの -------------------------------------------------------
//
// 海鮮・麺・肉までは選べるのに、ベジタリアン・アレルギー・ハラール・
// 子ども向けがどこにも入りませんでした。食べられないものがある人に
// とっては、名物より先に決まる条件です。「出雲そば」と書かれても、
// 小麦を避けている人には使えません。
//
// 店は持っていないので、変えられるのは**地図へ渡す言葉**と、名物の
// 選びかたまでです。対応店かどうかは確かめられないので、そう書きます。

test("食べられないものは、正しいものだけを通す", () => {
  assert.deepEqual(normalizeDiet(["vegetarian", "halal"]),
    ["vegetarian", "halal"]);
  // 知らない値・重複は落とします（画面の外から来ることがあります）。
  assert.deepEqual(normalizeDiet(["vegetarian", "vegetarian", "nope"]),
    ["vegetarian"]);
  assert.deepEqual(normalizeDiet(null), []);
});

test("trip.js の並びが、meals.js の並びとそろっている", () => {
  // trip.js は輪を作らないために並びを写しています。ずれると、画面で
  // 選べるのに旅程には届かない（またはその逆）ことになります。
  const ids = DIETS.map((d) => d.id);
  const trip = makeTrip({
    origin: { name: "東京駅", lat: 35.681, lng: 139.767 },
    departAt: new Date("2026-09-20T09:00"),
    arriveBy: new Date("2026-09-20T19:00"),
    diet: ids,
  });
  assert.deepEqual(trip.diet, ids,
    "meals.js にあるのに trip.js が落としている制約があります");
});

test("小麦を避ける人に、そばを出さない", () => {
  // 島根の名物は出雲そばです。まっすぐぶつかります。
  const plain = pickDish("島根県", { genre: "noodle" });
  assert.ok(plain, "名物が引けていません");
  assert.equal(plain.genre, "noodle");
  // 制約があると、その分類は外れます。外して何も残らなければ、
  // 名物の話はやめます（無い料理を作るより正確です）。
  const avoided = pickDish("島根県", { genre: "noodle", diet: ["gluten"] });
  assert.equal(avoided, null,
    `小麦を避ける指定なのに「${avoided?.name}」を出しています`);
});

test("ベジタリアンに、海鮮と肉を出さない", () => {
  for (let seed = 0; seed < 8; seed += 1) {
    const dish = pickDish("島根県", { seed, diet: ["vegetarian"] });
    if (!dish) continue;
    assert.ok(!["seafood", "meat"].includes(dish.genre),
      `ベジタリアンに「${dish.name}」（${dish.genre}）を出しています`);
  }
});

test("地図を探す言葉に、制約の言葉が先に入る", () => {
  assert.equal(dietQuery(["vegetarian"]), "ベジタリアン");
  assert.equal(dietQuery(["halal", "kids"]), "ハラール 子連れ 座敷");
  assert.equal(dietQuery([]), "");
});

test("「対応店です」とは言わない", () => {
  // こちらでは確かめられません。言葉を渡すところまでが、持っている
  // 情報でできることです。
  const note = dietNote(["vegetarian"]);
  assert.match(note, /ベジタリアン/);
  assert.match(note, /確かめられません|ご確認/);
  assert.doesNotMatch(note, /対応店|対応しています/);
  assert.equal(dietNote([]), "");
});
