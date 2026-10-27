// 「なぜこの場所が選ばれたのか」を、数字で説明する。
//
// AIが「おすすめです」と言うだけでは、なぜそこなのかが分かりません。
// 希望した「海」にどれくらい合っているのか、移動は効率的なのか、
// 混雑した時間を避けられているのか。どれも数えれば決まる量です。
//
// ここでもAIには採点させません。同じ場所でも聞くたびに点が変わるなら、
// それは説明ではありません。
//
// score.js との違い
// -----------------
//   score.js … 旅程が「無理のない形か」を測る（疲労・移動・リズム）
//   fit.js   … その場所が「あなたの希望に合っているか」を測る
// 前者は旅程を選ぶために、後者は説明のために使います。

import { crowdLevel } from "../packages/core/src/crowd.js";
import { drivingAppeal, drivingNote, isTouring } from "../packages/core/src/touring.js";
import { haversineKm } from "../packages/core/src/feasibility.js";

/**
 * 説明に使う軸。並びはここで決まります。
 * 毎回入れ替わると、読み手が比べられません。
 */
// icon は絵文字ではなく js/icons.js の名前です（端末ごとに絵が変わり、
// 大きさもそろわないため、絵文字は画面から外しました）。
export const AXES = {
  wish:  { label: "希望との一致", icon: "target", order: 1 },
  move:  { label: "移動のしやすさ", icon: "transit", order: 2 },
  // 車の旅のときだけ出ます。移動のしやすさのすぐ後ろ（2.5）に置くのは、
  // 車の人にとっては「どんな道の先か」が選ぶ理由そのものだからです。
  drive: { label: "道の楽しさ", icon: "car", order: 2.5 },
  crowd: { label: "混雑の避けやすさ", icon: "crowd", order: 3 },
  known: { label: "定番と穴場", icon: "star", order: 4 },
  season: { label: "季節の合いかた", icon: "leaf", order: 5 },
};

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** 点を星の数に。0〜100 を 0〜5 に落とします。 */
const starsOf = (n) => Math.max(0, Math.min(5, Math.round(n / 20)));

function axis(key, score, note) {
  const def = AXES[key];
  return { key, label: def.label, icon: def.icon, order: def.order,
           score: clamp(score), stars: starsOf(score), note: note ?? "" };
}

/** ジャンルの日本語名。説明文に使います。 */
const GENRE_LABEL = {
  onsen: "温泉", nature: "自然", history: "歴史・寺社", food: "グルメ",
  art: "アート", sea: "海・湖", city: "街歩き", view: "絶景",
};

/**
 * その場所が、この旅にどれくらい合っているか。
 *
 * @param {object} spot
 * @param {object} trip makeTrip の結果
 * @param {{at?:Date, fromKm?:number}} [ctx]
 *   at     … その場所に着く時刻（混雑の判定に使います）
 *   fromKm … 直前の場所からの距離（移動のしやすさに使います）
 * @returns {{total:number, axes:Array, summary:string}}
 */
export function spotFit(spot, trip, ctx = {}) {
  const axes = [];
  const genres = spot?.genres ?? [];
  const wishes = trip?.interests ?? [];

  // 1. 希望との一致。希望を出していない旅では、この軸を出しません
  //    （出しても「希望なしに100点」で、意味のない満点になります）。
  let matched = [];
  if (wishes.length) {
    matched = wishes.filter((w) => genres.includes(w));
    const score = matched.length
      ? 60 + (matched.length / wishes.length) * 40
      : 20;
    axes.push(axis("wish", score, matched.length
      ? `ご希望の「${matched.map(labelOf).join("・")}」に当たります`
      : "ご希望のジャンルからは外れます"));
  }

  // 2. 移動のしやすさ。直前の場所から近いほど高く。
  //    1.5km（歩ける）で満点、40km を超えると移動が主役になります。
  // 1か所目には「直前の場所」がありません。出発地からの距離を使いますが、
  // 言い方を変えます（「直前の場所から669km」は嘘になります）。
  const fromPrev = Number.isFinite(ctx.fromKm);
  const km = fromPrev
    ? ctx.fromKm
    : (spot && trip?.origin ? haversineKm(trip.origin, spot) : null);
  if (Number.isFinite(km)) {
    // 出発地からの距離は、旅の長さであって移動のしやすさではありません。
    // 1か所目は「行きの移動」なので、ここでは点を下げすぎないようにします。
    // 1か所目は「行きの移動」なので、点を下げすぎないようにします。
    // ただし**下げなさすぎてもいけません**。966km先の美術館に60点を
    // 付けていたので、ほかの軸より高くなり、画面には
    // 「移動のしやすさの点で選んでいます（出発地から約966km）」と
    // 出ていました。読めば分かるとおり、逆のことを言っています。
    const score = fromPrev
      ? (km <= 1.5 ? 100 : km >= 40 ? 15 : 100 - ((km - 1.5) / 38.5) * 85)
      : (km <= 150 ? 65 : km >= 900 ? 12 : 65 - ((km - 150) / 750) * 53);
    axes.push(axis("move", score,
      fromPrev
        ? (km <= 1.5 ? "歩いて行ける距離です"
           : `直前の場所から約${km < 10 ? km.toFixed(1) : Math.round(km)}km`)
        : `出発地から約${Math.round(km)}km`
          + (km >= 400 ? "。まる半日ぶんの移動です" : "（行きの移動）")));
  }

  // 2.5 車の旅なら、そこまでの道が楽しいかどうか。
  //
  //     駅からの近さは、車では意味を持ちません。代わりに効くのは
  //     「走って気持ちのいい道の先か」「駐められるか」です。
  //     電車の旅では出しません（出しても判断が変わりません）。
  if (isTouring(trip) && spot) {
    const appeal = drivingAppeal(spot);
    axes.push(axis("drive", 20 + appeal * 80,
      drivingNote(spot) || (appeal >= 0.6 ? "車で寄りやすい場所です" : "")));
  }

  // 3. 混雑の避けやすさ。crowd.js の見込みを裏返します。
  if (ctx.at instanceof Date && spot) {
    const c = crowdLevel(spot, ctx.at);
    axes.push(axis("crowd", 100 - c.score,
      `${c.label}の時間帯です`));
  }

  // 4. 定番と穴場のバランス。
  //    「穴場寄り」を指定しているなら穴場が高く、そうでなければ定番が高い。
  const bias = trip?.hiddenBias ?? 0.5;
  const tierScore = { major: 1, known: 0.5, hidden: 0 }[spot?.fame_tier] ?? 0.5;
  // 指定した好みと、その場所の位置づけが近いほど高く。
  const near = 1 - Math.abs((1 - bias) - tierScore);
  axes.push(axis("known", 40 + near * 60,
    { major: "誰でも知っている場所", known: "その地方では知られた場所",
      hidden: "知る人ぞ知る場所" }[spot?.fame_tier] ?? ""));

  axes.sort((a, b) => a.order - b.order);
  const total = axes.length
    ? clamp(axes.reduce((a, x) => a + x.score, 0) / axes.length) : 0;

  return { total, axes, summary: summarize(spot, axes, matched) };
}

function labelOf(g) { return GENRE_LABEL[g] ?? g; }

function summarize(spot, axes, matched) {
  const name = spot?.name ?? "この場所";
  const best = axes.slice().sort((a, b) => b.score - a.score)[0];
  if (matched?.length) {
    const move = axes.find((a) => a.key === "move");
    return `「${matched.map(labelOf).join("・")}」というご希望に合う場所です。`
      + (move && move.score >= 60 ? `${move.note}で、移動も負担になりません。` : "");
  }
  if (!best) return `${name}を候補に入れています。`;
  return `${name}は、${best.label}の点で選んでいます（${best.note}）。`;
}

// --- 旅全体 -----------------------------------------------------------------

/**
 * 旅全体が、希望にどれくらい合っているか。
 *
 * 「AIがおすすめする鎌倉」より「あなたの希望との適合度 92」のほうが、
 * 何を根拠にそうなったのかが伝わります。
 *
 * @param {object} itin buildItinerary の結果
 * @param {object} trip
 * @returns {{total:number, axes:Array, summary:string}}
 */
export function tripFit(itin, trip) {
  const spots = (itin?.days ?? [])
    .flatMap((d) => d?.items ?? [])
    .filter((i) => i.kind === "spot" && i.place)
    .map((i) => i.place);

  if (!spots.length) {
    return { total: 0, axes: [],
             summary: "立ち寄り先がないため、適合度は出せません。" };
  }

  const axes = [];
  const wishes = trip?.interests ?? [];

  // 1. 目的（希望したジャンルが、いくつ旅程に入っているか）
  if (wishes.length) {
    const have = new Set(spots.flatMap((s) => s.genres ?? []));
    const met = wishes.filter((w) => have.has(w));
    axes.push(axis("wish", (met.length / wishes.length) * 100,
      `ご希望の${wishes.length}件のうち${met.length}件に対応しています`));
  }

  // 2. 移動効率。score.js が数えた値をそのまま使います
  //    （同じことを二度数えると、片方だけ直したときにずれます）。
  const move = itin?.score?.parts?.find((p) => p.key === "move");
  if (move) axes.push(axis("move", move.score, move.note));

  // 3. 滞在ペース。疲労の裏返しです。
  if (Number.isFinite(itin?.score?.fatigue)) {
    axes.push(axis("crowd", 100 - itin.score.fatigue,
      `疲労の見込みは「${itin.score.fatigueLabel ?? "—"}」です`));
  }

  // 4. 定番と穴場のバランス
  const tiers = new Set(spots.map((s) => s.fame_tier).filter(Boolean));
  axes.push(axis("known", tiers.size >= 3 ? 100 : tiers.size === 2 ? 75 : 45,
    tiers.size >= 2 ? `定番と穴場が${tiers.size}層まざっています`
                    : "似た知名度の場所が並んでいます"));

  axes.sort((a, b) => a.order - b.order);
  const total = clamp(axes.reduce((a, x) => a + x.score, 0) / axes.length);
  const weakest = axes.slice().sort((a, b) => a.score - b.score)[0];

  const head = total >= 85 ? "ご希望によく合っています"
    : total >= 70 ? "ご希望におおむね合っています"
    : total >= 55 ? "ご希望に半分ほど応えられています"
    : "ご希望には十分応えられていません";
  return { total, axes,
           summary: `${head}（${total}点）。`
             + `気になるのは「${weakest.label}」です — ${weakest.note}。` };
}

// --- スポットの性格 ---------------------------------------------------------
//
// 「知名度」だけでは、その場所がどういう場所かが分かりません。
// 同じ「major」でも、城と市場と海岸では、行って得られるものが違います。
//
// 分類から5軸に落とします。分類ごとに手で決めた表なので、精密では
// ありませんが、「ここは食が強い」「ここは写真が強い」くらいの
// 見当はつきます。個別のスポットが値を持っていれば、そちらを使います。

const QUALITY_AXES = [
  { key: "history", label: "歴史", icon: "castle" },
  { key: "nature", label: "自然", icon: "leaf" },
  { key: "photo", label: "写真", icon: "camera" },
  { key: "food", label: "食", icon: "meal" },
  { key: "activity", label: "体験", icon: "ticket" },
];

/** 分類 → [歴史, 自然, 写真, 食, 体験]（0〜5）。 */
const QUALITY = {
  城: [5, 2, 5, 1, 3], 史跡: [5, 2, 3, 1, 2], 世界遺産: [5, 3, 5, 1, 3],
  寺院: [5, 3, 4, 1, 3], 神社: [4, 3, 4, 1, 3], 教会: [4, 1, 4, 1, 2],
  町並み: [4, 2, 5, 3, 3], 建築: [4, 1, 5, 1, 2],
  博物館: [5, 1, 2, 1, 4], 美術館: [3, 1, 2, 1, 4], 文化施設: [3, 1, 2, 1, 4],
  山: [1, 5, 5, 1, 4], 登山: [1, 5, 5, 1, 5], 丘: [1, 4, 4, 1, 3],
  高原: [1, 5, 5, 2, 3], 渓谷: [1, 5, 5, 1, 3], 滝: [1, 5, 5, 1, 2],
  湖: [1, 5, 5, 2, 3], 川: [1, 4, 4, 1, 3], 海岸: [1, 5, 5, 2, 3],
  漁港: [2, 3, 4, 5, 2], 国立公園: [1, 5, 5, 1, 3], 国定公園: [1, 5, 5, 1, 3],
  自然: [1, 5, 4, 1, 2], 公園: [2, 4, 3, 2, 2], 庭園: [4, 5, 5, 1, 2],
  牧場: [1, 4, 4, 4, 5],
  温泉: [3, 3, 2, 3, 5], 温泉地: [3, 3, 3, 4, 5],
  市場: [1, 1, 3, 5, 3], 商店街: [2, 1, 3, 5, 3], グルメ: [1, 1, 3, 5, 2],
  飲食店: [1, 1, 2, 5, 2], 酒蔵: [3, 1, 3, 5, 5],
  展望台: [1, 4, 5, 2, 2], 灯台: [2, 4, 5, 1, 2], ロープウェイ: [1, 4, 5, 1, 4],
  水族館: [1, 3, 4, 1, 5], 動物園: [1, 4, 4, 2, 5],
  テーマパーク: [1, 1, 4, 3, 5], スキー場: [1, 4, 4, 2, 5],
  商業施設: [1, 1, 2, 4, 3], 乗り物: [2, 2, 4, 1, 5],
  年中行事: [4, 1, 5, 3, 4], 観光名所: [3, 3, 4, 2, 3],
};

const QUALITY_DEFAULT = [3, 3, 3, 2, 3];

/**
 * その場所の性格。5軸そろって返します（欠けると比べられません）。
 * @returns {Array<{key:string, label:string, icon:string, stars:number}>}
 */
export function qualityOf(spot) {
  const own = spot?.quality;
  const base = QUALITY[spot?.category] ?? QUALITY_DEFAULT;
  return QUALITY_AXES.map((a, i) => ({
    ...a,
    stars: Math.max(0, Math.min(5,
      Math.round(Number.isFinite(own?.[a.key]) ? own[a.key] : base[i]))),
  }));
}
