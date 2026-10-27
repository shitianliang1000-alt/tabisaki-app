// 誰と行くかで、行ける場所は変わる。
//
// 旅程は「ふつうに歩ける大人ひとり」を前提に組まれていました。
// ところが同じ「城」でも、
//
//   ひとりで行く   石段を10分登って天守へ。40分で回れます
//   ベビーカー     石段はベビーカーでは上がれません
//   車椅子        天守の中は階段だけのことがあります
//   高齢の親と    登れなくはないが、40分では足りません
//
// で、意味がまったく違います。それでも旅程には同じ「松江城 80分」と
// 書かれ、当日に現地で分かります。
//
// ■ 持っているもの・持っていないもの
//
// **収録に「バリアフリーかどうか」はありません。** 施設ごとの段差、
// 手すり、多目的トイレ、車椅子の貸し出し——どれも持っていません。
// 持っていないものを「対応しています」と書くのは、いちばんしては
// いけないことです。行った先で入れなかったとき、取り返しがつきません。
//
// 持っているのは**分類**です。城には石段があり、砂浜では車輪が使えず、
// 山は登ります。これは分類から分かることで、作り話ではありません。
// packages/core/src/luggage.js が荷物のために同じ表を持っていたので、そこから
// 育てました（荷物がつらい場所と、足がつらい場所はよく重なります）。
//
// だから、ここでできるのは3つだけです。
//
//   ① 分類から「歩くのがつらい場所」を見分ける
//   ② 選ぶときに後ろへ回す（**外しはしません**。行きたい人もいます）
//   ③ 旅程に「何がつらいか」と「公式で確かめて」を書く
//
// 決めるのは本人です。こちらは材料を出すだけにします。

/**
 * 同行者。旅程の組みかたが変わるものだけを置きます。
 *
 * 「子連れ」を入れていないのは、食事の条件（packages/core/src/meals.js の diet）に
 * 「子ども向け」があり、そちらで拾えるからです。ここは**足**の話です。
 */
export const COMPANIONS = [
  { id: "stroller", label: "ベビーカー",
    what: "段差・砂利・石段が通れません" },
  { id: "wheelchair", label: "車椅子",
    what: "段差と急な坂が通れません" },
  { id: "senior", label: "歩くのがゆっくり",
    what: "登り坂と長い距離が負担になります" },
];

const BY_ID = new Map(COMPANIONS.map((c) => [c.id, c]));

/** 選ばれたものを、正しいものだけに絞ります。 */
export function normalizeCompanions(list) {
  const out = [];
  for (const id of Array.isArray(list) ? list : []) {
    if (BY_ID.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 分類ごとの、足のつらさ（0〜1）。
 *
 * 1 に近いほど「車輪では通れない・登る」場所です。0.5 未満は
 * 平らな屋内で、どの同行者でもだいたい行けます。
 *
 * **この数字は分類の目安です。** 同じ「寺院」でも、平地の境内だけの
 * ところと、山門から本堂まで300段あるところがあります。個別の段数は
 * 持っていないので、旅程には「石段があることが多い分類です」と書き、
 * 確かめ先を添えます。
 */
const HARDNESS = {
  登山: 1, 山: 0.95, 峠: 0.9, 渓谷: 0.85, 丘: 0.8, 滝: 0.75,
  海岸: 0.75, 海水浴場: 0.75, 砂丘: 0.9,
  城: 0.8, 史跡: 0.65, 寺院: 0.6, 神社: 0.6,
  高原: 0.7, 湿原: 0.7, 島: 0.6, 洞窟: 0.9, 鍾乳洞: 0.9,
  国立公園: 0.7, 国定公園: 0.65,
  町並み: 0.55, 庭園: 0.5, 公園: 0.45,
  // ここから下は、たいてい平らな屋内です。
  博物館: 0.2, 美術館: 0.2, 水族館: 0.25, 動物園: 0.4,
  商業施設: 0.2, 道の駅: 0.25, 温泉: 0.35, グルメ: 0.2,
  展望台: 0.3, 建築: 0.3, 教会: 0.3, 文化施設: 0.2,
};

/** 表に無い分類は、ふつう扱いにします。 */
const NEUTRAL = 0.45;

/** その場所の、足のつらさ（0〜1）。 */
export function hardnessOf(spot) {
  const v = HARDNESS[spot?.category];
  return Number.isFinite(v) ? v : NEUTRAL;
}

/**
 * 同行者ごとの、通れない線。
 *
 * ここを超える場所は「後ろへ回す」対象です。**外しません。**
 * ベビーカーでも、抱っこして石段を上がる人はいます。決めるのは本人です。
 */
const LIMIT = { stroller: 0.6, wheelchair: 0.55, senior: 0.75 };

/**
 * その場所が、同行者にとってつらいか。
 *
 * @param {object} spot
 * @param {string[]} companions
 * @returns {{hard:boolean, why:string, who:string[]}}
 *   hard が false なら、何も書きません（「歩きやすいです」とは
 *   言いません。確かめていないので）。
 */
export function accessNote(spot, companions) {
  const who = normalizeCompanions(companions);
  if (!who.length) return { hard: false, why: "", who: [] };
  const h = hardnessOf(spot);
  const hit = who.filter((id) => h >= (LIMIT[id] ?? 1));
  if (!hit.length) return { hard: false, why: "", who: [] };
  const names = hit.map((id) => BY_ID.get(id).label).join("・");
  const what = REASON[spot?.category] ?? "歩く場所があります";
  return {
    hard: true,
    who: hit,
    // **「行けません」とは言いません。** 分類から分かるのは
    // 「そういう場所が多い」までで、その施設がどうかは知りません。
    why: `${what}。${names}では負担になることがあります。`
      + "段差や貸し出しの有無は、公式サイトか電話でご確認ください。",
  };
}

/** 何がつらいのか。分類から分かることだけを書きます。 */
const REASON = {
  登山: "登山道です", 山: "登り道です", 峠: "峠の道です",
  渓谷: "足場の整っていない道があります", 丘: "坂と階段があります",
  滝: "遊歩道を歩きます", 砂丘: "砂の上を歩きます",
  海岸: "砂浜では車輪が使えません", 海水浴場: "砂浜では車輪が使えません",
  城: "石段があります", 史跡: "屋外を歩きます",
  寺院: "石段や砂利道があります", 神社: "石段や砂利道があります",
  高原: "歩く距離があります", 湿原: "木道を歩きます",
  島: "船と坂があります", 洞窟: "階段と狭い通路があります",
  鍾乳洞: "階段と狭い通路があります",
  国立公園: "歩く距離があります", 国定公園: "歩く距離があります",
  町並み: "石畳や坂があります",
};

/**
 * 選ぶときの重み（0〜1。高いほど選ばれやすい）。
 *
 * **外しません。** 行きたい人はいます。同じくらいの点なら平らな
 * ほうを先に、というだけの重みです（packages/core/src/touring.js の drivingAppeal と
 * 同じ考えかたです）。
 */
export function accessAppeal(spot, companions) {
  const who = normalizeCompanions(companions);
  if (!who.length) return 0.5;
  const h = hardnessOf(spot);
  // いちばん厳しい同行者に合わせます。
  const limit = Math.min(...who.map((id) => LIMIT[id] ?? 1));
  if (h < limit) return 0.5;
  // 線を超えたぶんだけ、なだらかに下げます。0 にはしません
  // （0 にすると、山のエリアで候補が全部消えます）。
  return Math.max(0.15, 0.5 - (h - limit) * 1.2);
}

/**
 * 1日の歩行距離が、同行者にとって長すぎないか。
 *
 * 数えるのは**場所と場所のあいだ**の徒歩だけです（着いた先の境内を
 * 歩く距離は誰も測っていません）。だから「これだけしか歩きません」
 * とは言わず、「移動だけでこれだけ歩きます」と書きます。
 *
 * @param {number} km 移動での徒歩（km）
 * @param {string[]} companions
 * @returns {string} 書くことが無ければ空
 */
export function walkLoadNote(km, companions) {
  const who = normalizeCompanions(companions);
  if (!who.length || !(km > 0)) return "";
  // 1日あたりの目安。歩くのがゆっくりな人で2km、車輪で1.5km。
  const limit = who.includes("wheelchair") || who.includes("stroller")
    ? 1.5 : 2.0;
  if (km <= limit) return "";
  const names = who.map((id) => BY_ID.get(id).label).join("・");
  return `この日は移動だけで約${km.toFixed(1)}km 歩きます`
    + `（${names}には長めです）。`
    + "着いた先で歩くぶんは、これに含まれていません。";
}

/**
 * 旅程に、同行者のための一言を足します。
 *
 * 時刻も経路も変えません。**変えるのは説明だけ**です。
 *
 * @returns {number} 書き足した立ち寄りの数
 */
export function attachAccess(itin, companions) {
  const who = normalizeCompanions(companions);
  if (!who.length) return 0;
  let n = 0;
  for (const day of itin?.days ?? []) {
    for (const item of day?.items ?? []) {
      if (item.kind !== "spot" || !item.place) continue;
      const note = accessNote(item.place, who);
      if (!note.hard) continue;
      item.access = { why: note.why, who: note.who };
      n += 1;
    }
    // その日の、移動での徒歩。
    const km = (day?.items ?? [])
      .filter((i) => i.kind === "transit" && i.walk)
      .reduce((a, i) => a + (i.km ?? 0), 0);
    const load = walkLoadNote(km, who);
    if (load) day.walkLoad = load;
  }
  return n;
}
