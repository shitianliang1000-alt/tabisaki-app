// 昼食・夕食を、その土地のものにする。
//
// これまで食事の欄はこう出ていました。「昼食 / 出雲で。お店は地図から
// 選べます」。時刻も所要も正しいのですが、**旅程として何も言って
// いません**。出雲でうどんを食べるのか蕎麦を食べるのかは、旅の中身です。
//
// ただし、このアプリは店の情報を持っていません。営業時間も、休みも、
// 予約の要否も、混み具合も分かりません。そこで、
//
//   ・**何を食べる土地か**は、ここが答えます（都道府県ごとの名物）
//   ・**どの店で食べるか**は、地図に渡します（実際に開いている店）
//
// と分けました。持っていない情報を、持っているふりで埋めないためです。
//
// いちばん大事にしたこと
// ----------------------
// **店名をこちらで作らない。** 「◯◯亭がおすすめです」と書けば旅程は
// 立派に見えますが、その店が今もあるのか、その日開いているのかを
// 知らずに書くことになります。閉店した店の前に立たせるのが、
// いちばん悪い結果です。
//
// 収録に飲食のスポット（グルメ・市場・道の駅）があって、その時間に
// 開いていて、食事の場所から歩ける距離にあるときだけ、名前を出します。
// それは収録データなので、出どころを言えます。

import { haversineKm } from "./feasibility.js";
import { hoursFor } from "./hours.js";

/**
 * 食べたいものの向き。画面の選択肢と、名物表の分類を兼ねます。
 *
 * query は地図検索に渡す言葉です。「ご当地」を選びたい人向けの項目は
 * 作っていません。既定（おまかせ）がすでにご当地を出すからです。
 */
export const FOOD_GENRES = [
  { id: "any", label: "おまかせ", query: "" },
  { id: "seafood", label: "海鮮", query: "海鮮" },
  { id: "noodle", label: "麺", query: "うどん そば ラーメン" },
  { id: "meat", label: "肉", query: "焼肉 ステーキ" },
  { id: "rice", label: "ご飯もの", query: "定食 丼" },
  { id: "sweets", label: "甘いもの", query: "カフェ 甘味処" },
];

const GENRE_IDS = new Set(FOOD_GENRES.map((g) => g.id));

/**
 * 都道府県ごとの名物。
 *
 * 分類ではなく**土地**で決まります。同じ「麺」でも、香川では讃岐うどん、
 * 島根では出雲そばです。分類から名前を作ることはできません。
 *
 * ここに書いたのは、その土地を代表するものとして広く知られている
 * 料理だけです。店ではありません。だから閉店しません。
 */
const LOCAL_FOODS = {
  北海道: [["海鮮丼", "seafood"], ["ジンギスカン", "meat"],
          ["味噌ラーメン", "noodle"], ["スープカレー", "rice"]],
  青森県: [["大間のまぐろ", "seafood"], ["せんべい汁", "rice"],
          ["味噌カレー牛乳ラーメン", "noodle"], ["りんご", "sweets"]],
  岩手県: [["わんこそば", "noodle"], ["盛岡冷麺", "noodle"],
          ["前沢牛", "meat"]],
  宮城県: [["牛タン", "meat"], ["笹かまぼこ", "seafood"],
          ["ずんだ餅", "sweets"], ["はらこ飯", "rice"]],
  秋田県: [["きりたんぽ鍋", "rice"], ["稲庭うどん", "noodle"],
          ["ハタハタ", "seafood"]],
  山形県: [["米沢牛", "meat"], ["芋煮", "rice"],
          ["冷やしラーメン", "noodle"], ["さくらんぼ", "sweets"]],
  福島県: [["喜多方ラーメン", "noodle"], ["円盤餃子", "rice"],
          ["桃", "sweets"]],
  茨城県: [["あんこう鍋", "seafood"], ["納豆", "rice"],
          ["干し芋", "sweets"]],
  栃木県: [["宇都宮餃子", "rice"], ["日光の湯波", "rice"],
          ["いちご", "sweets"]],
  群馬県: [["水沢うどん", "noodle"], ["上州牛", "meat"],
          ["焼きまんじゅう", "sweets"]],
  埼玉県: [["川越のうなぎ", "seafood"], ["冷汁うどん", "noodle"],
          ["草加せんべい", "sweets"]],
  千葉県: [["海鮮丼", "seafood"], ["太巻き寿司", "rice"],
          ["落花生", "sweets"]],
  東京都: [["江戸前寿司", "seafood"], ["もんじゃ焼き", "rice"],
          ["深川めし", "rice"], ["東京ラーメン", "noodle"]],
  神奈川県: [["しらす丼", "seafood"], ["中華街の点心", "rice"],
            ["家系ラーメン", "noodle"]],
  新潟県: [["へぎそば", "noodle"], ["南蛮えび", "seafood"],
          ["タレカツ丼", "rice"]],
  富山県: [["白えび", "seafood"], ["ます寿司", "seafood"],
          ["富山ブラックラーメン", "noodle"]],
  石川県: [["のどぐろ", "seafood"], ["治部煮", "rice"],
          ["金沢おでん", "rice"]],
  福井県: [["越前そば", "noodle"], ["焼き鯖", "seafood"],
          ["ソースカツ丼", "rice"]],
  山梨県: [["ほうとう", "noodle"], ["鳥もつ煮", "meat"],
          ["ぶどう", "sweets"]],
  長野県: [["信州そば", "noodle"], ["おやき", "rice"],
          ["野沢菜", "rice"]],
  岐阜県: [["飛騨牛", "meat"], ["朴葉味噌", "rice"],
          ["鶏ちゃん", "meat"]],
  静岡県: [["うなぎ", "seafood"], ["桜えび", "seafood"],
          ["静岡おでん", "rice"], ["お茶とお菓子", "sweets"]],
  愛知県: [["ひつまぶし", "seafood"], ["味噌カツ", "meat"],
          ["台湾ラーメン", "noodle"], ["あんかけスパ", "rice"]],
  三重県: [["松阪牛", "meat"], ["伊勢うどん", "noodle"],
          ["手こね寿司", "seafood"], ["赤福", "sweets"]],
  滋賀県: [["近江牛", "meat"], ["鮒寿司", "seafood"],
          ["赤こんにゃく", "rice"]],
  京都府: [["湯豆腐", "rice"], ["おばんざい", "rice"],
          ["抹茶のお菓子", "sweets"], ["にしんそば", "noodle"]],
  大阪府: [["たこ焼き", "rice"], ["お好み焼き", "rice"],
          ["串カツ", "meat"], ["肉吸い", "rice"]],
  兵庫県: [["神戸牛", "meat"], ["明石焼き", "rice"],
          ["そばめし", "noodle"]],
  奈良県: [["柿の葉寿司", "seafood"], ["三輪そうめん", "noodle"],
          ["茶粥", "rice"]],
  和歌山県: [["和歌山ラーメン", "noodle"], ["めはり寿司", "rice"],
            ["まぐろ", "seafood"], ["みかん", "sweets"]],
  鳥取県: [["松葉がに", "seafood"], ["牛骨ラーメン", "noodle"],
          ["二十世紀梨", "sweets"]],
  島根県: [["出雲そば", "noodle"], ["しじみ汁", "seafood"],
          ["ぜんざい", "sweets"]],
  岡山県: [["ばら寿司", "seafood"], ["デミカツ丼", "rice"],
          ["きびだんご", "sweets"]],
  広島県: [["お好み焼き", "rice"], ["牡蠣", "seafood"],
          ["尾道ラーメン", "noodle"], ["もみじ饅頭", "sweets"]],
  山口県: [["ふぐ", "seafood"], ["瓦そば", "noodle"],
          ["外郎", "sweets"]],
  徳島県: [["徳島ラーメン", "noodle"], ["半田そうめん", "noodle"],
          ["阿波尾鶏", "meat"], ["すだち", "sweets"]],
  香川県: [["讃岐うどん", "noodle"], ["骨付鳥", "meat"],
          ["和三盆のお菓子", "sweets"]],
  愛媛県: [["鯛めし", "rice"], ["じゃこ天", "seafood"],
          ["焼豚玉子飯", "rice"], ["みかん", "sweets"]],
  高知県: [["かつおのたたき", "seafood"], ["皿鉢料理", "rice"],
          ["屋台餃子", "rice"]],
  福岡県: [["豚骨ラーメン", "noodle"], ["もつ鍋", "meat"],
          ["明太子", "seafood"], ["水炊き", "meat"]],
  佐賀県: [["呼子のいか", "seafood"], ["佐賀牛", "meat"],
          ["シシリアンライス", "rice"]],
  長崎県: [["ちゃんぽん", "noodle"], ["皿うどん", "noodle"],
          ["トルコライス", "rice"], ["カステラ", "sweets"]],
  熊本県: [["馬刺し", "meat"], ["太平燕", "noodle"],
          ["からしれんこん", "rice"], ["いきなり団子", "sweets"]],
  大分県: [["とり天", "meat"], ["だんご汁", "noodle"],
          ["関あじ", "seafood"], ["中津からあげ", "meat"]],
  宮崎県: [["チキン南蛮", "meat"], ["冷や汁", "rice"],
          ["宮崎牛", "meat"]],
  鹿児島県: [["黒豚しゃぶしゃぶ", "meat"], ["鶏飯", "rice"],
            ["さつま揚げ", "seafood"], ["しろくま", "sweets"]],
  沖縄県: [["沖縄そば", "noodle"], ["ゴーヤーチャンプルー", "rice"],
          ["タコライス", "rice"], ["ぜんざい", "sweets"]],
};

/** 収録のうち、食事どころとして扱う分類。 */
const FOOD_CATEGORIES = new Set(["グルメ", "飲食店", "市場", "道の駅", "商店街"]);

/** 食事のために歩ける距離。これを超えると、食事のために移動が要ります。 */
export const FOOD_NEAR_KM = 1.2;

/** その都道府県の名物。知らない県では空の配列を返します（作りません）。 */
export function localFoodsFor(prefecture) {
  const list = LOCAL_FOODS[String(prefecture ?? "").trim()];
  if (!list) return [];
  return list.map(([name, genre]) => ({ name, genre }));
}

/** 収録スポットのうち、食事どころにあたるもの。 */
export function isFoodSpot(spot) {
  return FOOD_CATEGORIES.has(spot?.category)
    || (spot?.genres ?? []).includes("food");
}

/**
 * 名物を1つ選びます。
 *
 * 選び方は**毎回同じ**にします。同じ旅程を組み直すたびに食べるものが
 * 変わったら、旅程として信用できません。昼と夕で違うものになるよう、
 * seed だけずらします。
 *
 * @param {string} prefecture
 * @param {object} [opts]
 * @param {string} [opts.genre] 食べたいものの向き（FOOD_GENRES の id）
 * @param {number} [opts.seed]  同じ土地で複数回食べるときの区別
 * @returns {{name:string, genre:string}|null}
 */
export function pickDish(prefecture, opts = {}) {
  const all = localFoodsFor(prefecture);
  if (!all.length) return null;
  const genre = GENRE_IDS.has(opts.genre) ? opts.genre : "any";
  // 向きが指定されていれば、その向きのものだけ。
  // 無ければ**土地の名物のほうを捨てます**（無い料理を作るより、
  // 地図の検索語だけを渡すほうが正確です）。
  // おまかせのときは、甘いものを後回しにします。
  //
  // 「夕食 / ぜんざい」が出ていました。ぜんざいは島根の名物ですが、
  // 夕食ではありません。選んで指定された（genre === "sweets"）ときだけ
  // 出すことにして、おまかせでは食事になるものから選びます。
  const wanted = genre === "any"
    ? all.filter((f) => f.genre !== "sweets")
    : all.filter((f) => f.genre === genre);
  // 食べられないものは、名物のほうからも外します。
  //
  // 「小麦を避ける」を選んだ人に「出雲そば」を出しても、旅程として
  // 役に立ちません。外した結果1つも残らなければ、名物の話はやめて
  // 地図の言葉だけを渡します（無い料理を作るより正確です）。
  const avoid = avoidedGenres(opts.diet);
  const allowed = avoid.size
    ? wanted.filter((f) => !avoid.has(f.genre))
    : wanted;
  const pool = allowed.length
    ? allowed
    : (genre === "any" && !avoid.size ? all : []);
  if (!pool.length) return null;
  const seed = Number.isFinite(opts.seed) ? Math.abs(Math.trunc(opts.seed)) : 0;
  return pool[seed % pool.length];
}

/**
 * 食べられないもの。
 *
 * 海鮮・麺・肉までは選べるのに、**ベジタリアン・アレルギー・ハラール・
 * 子ども向けがどこにも入りませんでした。** 食べられないものがある人に
 * とっては、名物より先に決まる条件です。「出雲そば」と書かれても、
 * 小麦を避けている人には使えません。
 *
 * 店は持っていないので、ここで変わるのは**地図へ渡す言葉**だけです。
 * それでも「出雲 ベジタリアン」で開くのと「出雲 出雲そば」で開くのでは、
 * 出てくる店がまるで違います。
 *
 * **その店が条件に合うかは、こちらでは確かめられません。** 言葉を
 * 渡すところまでが、持っている情報でできることです。旅程には
 * そう書き添えます（勝手に「対応店です」とは言いません）。
 *
 * query は地図検索に足す言葉、avoid は名物のほうで外す分類です。
 */
export const DIETS = [
  { id: "vegetarian", label: "ベジタリアン", query: "ベジタリアン",
    avoid: ["seafood", "meat"] },
  { id: "vegan", label: "ヴィーガン", query: "ヴィーガン",
    avoid: ["seafood", "meat", "sweets"] },
  { id: "halal", label: "ハラール", query: "ハラール", avoid: ["meat"] },
  // 小麦は、麺の名物とまっすぐぶつかります（そば・うどん・ラーメン）。
  { id: "gluten", label: "小麦を避ける", query: "グルテンフリー",
    avoid: ["noodle"] },
  { id: "seafood-free", label: "魚介を避ける", query: "魚介不使用",
    avoid: ["seafood"] },
  // 子ども向けは、何かを外すのではなく探す言葉が変わります。
  { id: "kids", label: "子ども向け", query: "子連れ 座敷", avoid: [] },
];

const DIET_BY_ID = new Map(DIETS.map((d) => [d.id, d]));

/** 選ばれた制約を、正しいものだけに絞ります。 */
export function normalizeDiet(list) {
  const out = [];
  for (const id of Array.isArray(list) ? list : []) {
    if (DIET_BY_ID.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 制約のせいで外れる名物の分類。 */
export function avoidedGenres(diet) {
  const out = new Set();
  for (const id of normalizeDiet(diet)) {
    for (const g of DIET_BY_ID.get(id).avoid) out.add(g);
  }
  return out;
}

/** 地図へ渡す言葉に足す、制約の言葉。 */
export function dietQuery(diet) {
  return normalizeDiet(diet).map((id) => DIET_BY_ID.get(id).query).join(" ");
}

/** 旅程に添える断り書き。対応しているとは言いません。 */
export function dietNote(diet) {
  const ids = normalizeDiet(diet);
  if (!ids.length) return "";
  const names = ids.map((id) => DIET_BY_ID.get(id).label).join("・");
  return `${names}の条件で、地図を探す言葉を変えています。`
    + "お店がその条件に合うかは、こちらでは確かめられません。"
    + "行く前にお店へご確認ください。";
}

/**
 * 食事の場所から歩ける距離にある、収録の食事どころ。
 *
 * その時間に開いている店だけを返します。閉まっている店の名前を出すのは、
 * 名前を出さないより悪いことです。
 *
 * @param {Array} spots 収録スポット（全件でよい）
 * @param {{lat:number, lng:number}} near
 * @param {Date} at
 * @param {object} [opts]
 * @returns {object|null}
 */
export function nearbyFoodSpot(spots, near, at, opts = {}) {
  if (!Number.isFinite(near?.lat)) return null;
  const maxKm = opts.maxKm ?? FOOD_NEAR_KM;
  const exclude = opts.exclude ?? new Set();
  const best = [];
  for (const s of spots ?? []) {
    if (!isFoodSpot(s) || exclude.has(s.id)) continue;
    const km = haversineKm(near, s);
    if (!Number.isFinite(km) || km > maxKm) continue;
    if (at instanceof Date && !Number.isNaN(at.getTime())) {
      const h = hoursFor(s, at);
      if (h.closed) continue;
      // 開く前・閉まったあとは、行っても入れません
      if (h.open && at < h.open) continue;
      if (h.lastEntry && at > h.lastEntry) continue;
    }
    best.push({ spot: s, km });
  }
  if (!best.length) return null;
  best.sort((a, b) => a.km - b.km);
  return best[0].spot;
}

/**
 * 食事の欄に書く言葉。
 *
 * 持っている情報だけで書きます。名物が分からない土地では名物の話を
 * せず、店が分からないときは店の話をしません。
 */
export function mealDetail({ regionName, dish, spot, genre } = {}) {
  const where = regionName ? `${regionName}で` : "";
  if (spot) {
    // 収録にある場所です。出どころを言えるので、名前を出します。
    return `${where}。収録の「${spot.name}」が歩ける距離にあります`;
  }
  if (dish) {
    return `${where}、この土地の名物「${dish.name}」を。`
      + "お店は地図から選べます";
  }
  const g = FOOD_GENRES.find((x) => x.id === genre);
  if (g && g.id !== "any") {
    return `${where}、${g.label}のお店を地図から選べます`;
  }
  return `${where}。お店は地図から選べます`;
}

/**
 * 旅程の食事に、その土地のものを当てます。
 *
 * 旅程の時刻も費用も変えません。変えるのは説明と、地図に渡す検索語だけ
 * です（店の値段を知らないので、費用の見積もりは動かせません）。
 *
 * @param {object} itin buildItinerary の結果
 * @param {object} [opts]
 * @param {Array} [opts.spots] 収録スポット（食事どころを探すのに使います）
 * @param {string} [opts.genre] 食べたいものの向き
 * @returns {number} 具体的にできた食事の数
 */
export function attachMeals(itin, opts = {}) {
  const days = Array.isArray(itin?.days) ? itin.days : [];
  // 収録は3万件あります。食事のたびに全件を測ると、食事の数だけ
  // 3万回の距離計算が走ります。食事どころは60件ほどなので、先に絞ります。
  const spots = (opts.spots ?? []).filter(isFoodSpot);
  const genre = GENRE_IDS.has(opts.genre) ? opts.genre : "any";

  // 同じ名物を、旅のあいだ何度も出しません。
  // 3日間ぜんぶ「出雲そば」では、選んだ意味がありません。
  const usedDishes = new Set();
  const usedSpots = new Set(days.flatMap((d) => d?.items ?? [])
    .map((i) => i.spotId ?? i.place?.id).filter(Boolean));
  let n = 0;
  let seed = 0;

  for (const day of days) {
    for (const item of day?.items ?? []) {
      if (item.kind !== "meal") continue;
      const near = item.near ?? {};
      // 都道府県は、その食事のいちばん近くのスポットから取ります。
      // 旅程が県をまたぐと、名物も変わります。
      const pref = prefectureNear(days, item) ?? opts.prefecture ?? null;

      const spot = nearbyFoodSpot(spots, near, item.start,
                                  { exclude: usedSpots });
      let dish = null;
      if (!spot) {
        // 同じものが続かないよう、seed をずらしながら探します
        for (let k = 0; k < 6 && !dish; k += 1) {
          const cand = pickDish(pref, { genre, seed: seed + k,
                                        diet: opts.diet });
          if (!cand) break;
          if (!usedDishes.has(cand.name)) dish = cand;
        }
        if (dish) {
          usedDishes.add(dish.name);
          seed += 1;
        }
      } else {
        usedSpots.add(spot.id);
      }

      item.food = {
        genre,
        dish: dish?.name ?? null,
        spotId: spot?.id ?? null,
        spotName: spot?.name ?? null,
        // 地図に渡す言葉。名物が分かればそれ、向きだけ分かればそれ。
        // 食べられないものがあるなら、**その言葉を先に置きます**
        // （「ベジタリアン 出雲そば」ではなく「ベジタリアン」が主）。
        query: [dietQuery(opts.diet),
                dish?.name
                  ?? FOOD_GENRES.find((g) => g.id === genre)?.query
                  ?? ""].filter(Boolean).join(" "),
        diet: normalizeDiet(opts.diet),
      };
      item.detail = mealDetail({
        regionName: near.regionName, dish, spot, genre,
      });
      if (dish || spot) n += 1;
    }
  }
  return n;
}

/**
 * その食事のいちばん近くにあるスポットの都道府県。
 *
 * 食事の項目そのものは都道府県を持っていません（エリアの中心座標だけ）。
 * 同じ日に行く場所から取れば、県をまたぐ旅程でも当たります。
 */
function prefectureNear(days, meal) {
  for (const day of days) {
    const items = (day?.items ?? []).filter((i) => i.kind === "spot"
      && i.place?.prefecture);
    if (!items.length) continue;
    if (!items.some((i) => i.start && meal.start
      && Math.abs(i.start - meal.start) < 24 * 3600 * 1000)) continue;
    // 時間のいちばん近いスポットの県
    const best = items.reduce((a, b) =>
      Math.abs(b.start - meal.start) < Math.abs(a.start - meal.start) ? b : a);
    return best.place.prefecture;
  }
  return null;
}
