// 物理的に不可能な候補を、AI に渡す前に落とす。
//
// v2 は候補をそのままモデルに渡し、選ばれた後で時刻を割り当てていました。
// その順序だと「17:30 到着・17:00 閉館」のような、もっともらしいが実行不能な
// 旅程が生まれます。モデルは意味を扱うのが仕事で、開館時刻と移動時間の
// 突き合わせはプログラムの仕事です。
//
// ここでやること:
//   1. その日の開館時間に間に合うか
//   2. 見学を終えた後、その日の終点（宿 or 帰着地）に期限までに着けるか
// この2つを通ったものだけがモデルに渡ります。落とした理由も残すので、
// 「なぜ候補に出てこないのか」を画面で説明できます。

import { TUNING } from "./config.js";
import { hoursFor } from "./hours.js";

// --- 分類ごとの既定値 -------------------------------------------------------
// Wikidata は営業時間も料金も持たないため、分類ごとの一般的な値を使います。
// スポット側に実データ（hours / fee）があればそちらが優先されるので、
// 将来 Places API 等を足すときはこの関数の外だけを変えれば済みます。

const CATEGORY_PROFILES = {
  温泉: { dwell: 70, open: 9, close: 21, fee: 900 },
  温泉地: { dwell: 70, open: 9, close: 21, fee: 900 },
  寺院: { dwell: 45, open: 8, close: 17, fee: 400 },
  神社: { dwell: 35, open: 0, close: 24, fee: 0 },
  教会: { dwell: 30, open: 9, close: 17, fee: 0 },
  城: { dwell: 80, open: 9, close: 16.5, fee: 800 },
  史跡: { dwell: 35, open: 0, close: 24, fee: 0 },
  世界遺産: { dwell: 75, open: 8.5, close: 17, fee: 600 },
  博物館: { dwell: 65, open: 9.5, close: 17, fee: 700 },
  美術館: { dwell: 70, open: 10, close: 17, fee: 1000 },
  公園: { dwell: 45, open: 0, close: 24, fee: 0 },
  庭園: { dwell: 50, open: 9, close: 17, fee: 400 },
  国立公園: { dwell: 90, open: 0, close: 24, fee: 0 },
  国定公園: { dwell: 80, open: 0, close: 24, fee: 0 },
  山: { dwell: 90, open: 0, close: 24, fee: 0 },
  登山: { dwell: 180, open: 5, close: 17, fee: 0 },
  丘: { dwell: 40, open: 0, close: 24, fee: 0 },
  滝: { dwell: 35, open: 0, close: 24, fee: 0 },
  湖: { dwell: 50, open: 0, close: 24, fee: 0 },
  海岸: { dwell: 45, open: 0, close: 24, fee: 0 },
  川: { dwell: 35, open: 0, close: 24, fee: 0 },
  渓谷: { dwell: 55, open: 0, close: 24, fee: 0 },
  灯台: { dwell: 35, open: 9, close: 16, fee: 300 },
  建築: { dwell: 40, open: 9, close: 17, fee: 300 },
  名勝: { dwell: 40, open: 0, close: 24, fee: 0 },
  天然記念物: { dwell: 30, open: 0, close: 24, fee: 0 },
  ダム: { dwell: 30, open: 0, close: 24, fee: 0 },
  道の駅: { dwell: 40, open: 9, close: 18, fee: 0 },
  展望台: { dwell: 40, open: 9, close: 21, fee: 600 },
  テーマパーク: { dwell: 150, open: 9.5, close: 18, fee: 4500 },
  水族館: { dwell: 90, open: 9.5, close: 17, fee: 2200 },
  動物園: { dwell: 100, open: 9.5, close: 16.5, fee: 1200 },
  スキー場: { dwell: 120, open: 9, close: 16, fee: 4000 },
  ロープウェイ: { dwell: 40, open: 9, close: 16.5, fee: 1400 },
  市場: { dwell: 50, open: 8, close: 16, fee: 0 },
  酒蔵: { dwell: 50, open: 10, close: 16.5, fee: 500 },
  飲食店: { dwell: 60, open: 11, close: 21, fee: 1800 },
  観光名所: { dwell: 45, open: 9, close: 17, fee: 300 },

  // --- ここから下は、既定値に落ちていたもの ---------------------------------
  //
  // 収録の分類は44ありますが、上の表にあったのは29だけでした。残りの15は
  // DEFAULT_PROFILE（45分・9:00〜17:00・300円）に落ちていて、件数は
  // **1,500件を超えます**（島667・海水浴場221・峠218・遊園地166・岬94…）。
  //
  // 落ちると2つのことが起きます。どちらも黙って起きます。
  //
  //   1. **無い料金を300円として数えます。** 峠も海岸も町並みも、入るのに
  //      お金は要りません。要らないものを予算に足すと、合計がずれます。
  //   2. **9:00〜17:00 しか開いていないことにします。** 夕暮れの海岸へ
  //      行きたい人に、planner が「閉まっています」と言って外します。
  //      海岸に閉館時刻はありません。
  //
  // 門も料金所も無いもの（峠・岬・海水浴場・町並み・高原・漁港・自然）は
  // 0〜24時・0円です。**これは推量ではなく、無いものを無いと書いた結果**
  // です。建物のあるもの（牧場・遊園地・文化施設・商業施設）だけ、時刻と
  // 料金の目安を置きます。
  海水浴場: { dwell: 60, open: 0, close: 24, fee: 0 },
  島: { dwell: 180, open: 0, close: 24, fee: 0 },
  峠: { dwell: 25, open: 0, close: 24, fee: 0 },
  岬: { dwell: 35, open: 0, close: 24, fee: 0 },
  高原: { dwell: 70, open: 0, close: 24, fee: 0 },
  自然: { dwell: 50, open: 0, close: 24, fee: 0 },
  漁港: { dwell: 30, open: 0, close: 24, fee: 0 },
  町並み: { dwell: 50, open: 0, close: 24, fee: 0 },
  牧場: { dwell: 75, open: 9, close: 17, fee: 800 },
  遊園地: { dwell: 150, open: 10, close: 17, fee: 1500 },
  文化施設: { dwell: 60, open: 9, close: 17, fee: 500 },
  商業施設: { dwell: 60, open: 10, close: 20, fee: 0 },
  商店街: { dwell: 50, open: 10, close: 19, fee: 0 },
  グルメ: { dwell: 60, open: 11, close: 21, fee: 1800 },
  乗り物: { dwell: 40, open: 9, close: 17, fee: 1200 },
};

const DEFAULT_PROFILE = { dwell: 45, open: 9, close: 17, fee: 300 };

/**
 * 分類 → ジャンル。
 *
 * 知識ベースが大きくなると、スポット1件ごとにジャンルの配列を持たせるだけで
 * 数百KBになります。分類から決まるものなので、読み込むときに補います。
 */
const CATEGORY_GENRES = {
  温泉: ["onsen"], 温泉地: ["onsen"],
  神社: ["history"], 寺院: ["history"], 教会: ["history"], 城: ["history"],
  史跡: ["history"], 町並み: ["history"], 世界遺産: ["history"],
  庭園: ["nature"], 公園: ["nature"], 滝: ["nature"], 渓谷: ["nature"],
  登山: ["nature"], 山: ["nature"], 丘: ["nature"], 高原: ["nature"],
  自然: ["nature"], 国立公園: ["nature"], 国定公園: ["nature"],
  名勝: ["nature"], 天然記念物: ["nature"], ダム: ["view"], 道の駅: ["food"],
  牧場: ["nature"], 動物園: ["nature"], スキー場: ["nature"], 川: ["nature"],
  湖: ["sea"], 海岸: ["sea"], 漁港: ["sea"], 水族館: ["sea"],
  美術館: ["art"], 博物館: ["art"], 文化施設: ["art"], 建築: ["art"],
  商店街: ["food"], 市場: ["food"], グルメ: ["food"], 飲食店: ["food"],
  酒蔵: ["food"],
  展望台: ["view"], 灯台: ["view"], ロープウェイ: ["view"],
  商業施設: ["city"], 乗り物: ["city"], テーマパーク: ["city"],
  観光名所: ["city"], 年中行事: ["city"],
};

export function genresForCategory(category) {
  return CATEGORY_GENRES[category] ?? ["city"];
}

const PACE_FACTOR = { relaxed: 1.25, balanced: 1.0, packed: 0.8 };

/**
 * スポットの滞在時間・営業時間・料金。
 *
 * 営業時間の出どころは3つあり、細かいほうを勝たせます。
 *
 *   1. spot.hours   … 曜日・季節・最終入場まで持つ実データ（hours.js が扱う）
 *   2. spot.open/close … 単純な実データ
 *   3. 分類ごとの目安 … 上のどちらも無いとき
 *
 * どれを使ったかは estimated で分かるようにします。目安を確定情報の
 * ように出すと、「開いているはずの時間に閉まっていた」が起きます。
 */
export function profileOf(spot, pace = "balanced") {
  const base = CATEGORY_PROFILES[spot.category] ?? DEFAULT_PROFILE;
  const factor = PACE_FACTOR[pace] ?? 1;
  const h = spot.hours ?? {};
  const open = h.open ?? spot.open;
  const close = h.close ?? spot.close;
  return {
    dwell: Math.max(20, Math.round((h.dwell ?? spot.dwell ?? base.dwell) * factor)),
    open: open ?? base.open,
    close: close ?? base.close,
    /** 入場を締める時刻（時）。無ければ hours.js が分類から補います。 */
    lastEntry: h.lastEntry ?? spot.lastEntry,
    fee: h.fee ?? spot.fee ?? base.fee,
    /** 0=日曜 … 6=土曜。実データがあれば使う。 */
    closedDays: h.closedDays ?? spot.closedDays ?? [],
    /**
     * 既定値なのか実データなのか。UI で「目安」と出すために使う。
     * AI が調べたデータ（verified === false）は、値が入っていても
     * 裏取りができていないので「要確認」側に倒します。
     */
    estimated: open === undefined || close === undefined
      || spot.verified === false,
  };
}

export function isAlwaysOpen(prof) {
  return prof.open === 0 && prof.close === 24;
}

// --- 距離と時間 -------------------------------------------------------------

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 登山道など、車も公共交通も通っていない区間として扱うカテゴリ。
 * 街なかの徒歩と同じ速さで見積もると、五合目から山頂までの数kmが
 * 「30分」のように出てしまう（実際は数時間かかる）ため、この区間だけ
 * 別の、ずっと遅い速さで見積もります。
 */
const SLOW_TERRAIN_CATEGORIES = new Set(["登山", "山", "高原", "渓谷"]);

export function isSlowTerrain(spot) {
  return SLOW_TERRAIN_CATEGORIES.has(spot?.category);
}

/**
 * Routes API が使えないときの移動時間（分）。意図的に控えめに見積もります。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.slow] 登山道などの徒歩ラストマイル区間。
 *   街なかの4.2km/hではなく、山道の目安2.2km/hで見ます
 *   （距離に応じた車・鉄道への切り替えもしません。区間ぜんぶが徒歩の
 *   前提だからです）。
 */
/**
 * タクシーで行くときの所要時間（分）。
 *
 * 近くに駅もバス停も無い区間で使います。電車・バスの見積もり
 * （estimateMinutes）をそのまま当てると、待ち時間や乗り換えを含んだ数字に
 * なるので、**乗り物が来ない場所ほど長く出る**という逆のことが起きます。
 *
 * 道路の実効速度は、直線距離あたりで見ると思ったより遅くなります。
 * 信号と曲がりのぶんです。短い区間ほど遅く見ます。
 * 呼んでから乗るまでの数分も乗せます（流しを拾える街なかでも0分では
 * ありません）。
 *
 * @param {number} km 直線距離
 * @returns {number} 分
 */
export function taxiMinutes(km) {
  if (!Number.isFinite(km) || km <= 0) return 0;
  const speed = km <= 3 ? 20 : km <= 10 ? 26 : 34;
  return Math.max(5, Math.round((km / speed) * 60) + 6);
}

export function estimateMinutes(a, b, opts = {}) {
  const km = haversineKm(a, b);
  if (opts.slow) return Math.max(10, Math.round((km / 2.2) * 60) + 10);
  // 歩く速さは時速4.2km。ここを超えると、乗り物を使う前提の見積もりです。
  if (km <= 1.0) return Math.max(5, Math.round((km / 4.2) * 60) + 4);
  if (km <= 40) return Math.round((km / 22) * 60) + 10;
  // 40km を超えると鉄道が現実的な手段になります。直線距離あたりの実効速度は
  // 在来線で 50km/h 前後、新幹線区間では 120km/h 前後まで上がるため、
  // 距離に応じて切り替えます。ここを道路速度のままにすると、東京〜関西が
  // 片道8時間と見積もられ、行けるはずの旅先が候補から消えます。
  if (km <= 120) return Math.round((km / 50) * 60) + 20;
  if (km <= 700) return Math.round((km / 120) * 60) + 35;  // 新幹線＋乗換

  // ここから先は飛行機のほうが早くなります。この分岐が無いと、
  // 東京〜石垣が「時速120kmで20時間」になり、行けるはずの旅先が
  // 候補から消えます。
  // 空港での手続きと市内との往復を、片道210分として乗せています。
  const ground = Math.round((km / 120) * 60) + 35;
  const air = Math.round((km / 800) * 60) + 210;
  return Math.min(ground, air);
}

export function atHour(date, hour) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + hour * 3600000);
}

export function addMinutes(d, m) {
  return new Date(d.getTime() + m * 60000);
}

// --- 判定 -------------------------------------------------------------------

export const REJECT = {
  CLOSED_TODAY: "定休日",
  TOO_LATE: "到着時には閉まっている",
  AFTER_LAST_ENTRY: "最終入場を過ぎている",
  WAIT_TOO_LONG: "開館までの待ち時間が長すぎる",
  CANNOT_FINISH: "見学を終えると終点に間に合わない",
  DAY_FULL: "その日の行動時間に収まらない",
  UNREACHABLE: "移動時間が長すぎて往復できない",
  BASE_MOVED: "その日はもう別のエリアに移っている",
  // 同じ名前の場所が、収録に2件あることがあります（久住山が12km離れて
  // 2件など）。どちらの座標が正しいかは決められませんが、旅程に
  // 「久住山 → 移動30分 → 久住山」と並ぶのは、どう転んでも誤りです。
  DUPLICATE: "同じ名前の場所が、もう旅程に入っている",
};

/**
 * 1件のスポットが、与えられた状況で実際に訪問できるか。
 *
 * @param {object} spot
 * @param {object} ctx
 * @param {{lat,lng}} ctx.from     いまいる場所
 * @param {Date}      ctx.earliest そこを出発できる最も早い時刻
 * @param {{lat,lng}} ctx.endPlace その日の終点（宿 or 帰着地）
 * @param {Date}      ctx.endBy    終点に着いていなければならない時刻
 * @param {string}   [ctx.pace]
 * @param {(a,b)=>number} [ctx.travelFn] 移動時間（分）を返す関数
 * @returns {{ok:boolean, reason?:string, arrive?:Date, end?:Date,
 *            travel?:number, wait?:number, backMin?:number}}
 */
export function checkSpot(spot, ctx) {
  const travelFn = ctx.travelFn ?? estimateMinutes;
  const pace = ctx.pace ?? "balanced";
  const prof = profileOf(spot, pace);

  const travel = travelFn(ctx.from, spot);
  let arrive = addMinutes(ctx.earliest, travel);
  let wait = 0;

  // その日の開き方。定休日・年末年始・冬期休業・曜日ごとの時間まで見ます。
  const day = hoursFor(spot, arrive, pace);
  if (day.closed) {
    return { ok: false, reason: REJECT.CLOSED_TODAY, closedReason: day.reason };
  }

  if (!day.alwaysOpen) {
    if (arrive < day.open) {
      wait = Math.round((day.open - arrive) / 60000);
      if (wait > TUNING.maxWaitMin) {
        return { ok: false, reason: REJECT.WAIT_TOO_LONG, wait };
      }
      arrive = new Date(day.open);
    }
    // すでに閉まっているのか、開いてはいるが入れないのか。
    // 理由が違えば打てる手も違うので（前者は日を変える、後者は
    // 順番を前に詰める）、分けて返します。
    if (arrive >= day.close) {
      return { ok: false, reason: REJECT.TOO_LATE, arrive };
    }
    // 「営業中」と「入場できる」は別です。17:00 閉館の城に 16:55 に
    // 着いても、最終入場 16:30 なら入れません。閉館時刻だけで通すと、
    // 現地で「時間内のはずなのに入れない」が起きます。
    if (day.lastEntry && arrive > day.lastEntry) {
      return { ok: false, reason: REJECT.AFTER_LAST_ENTRY, arrive,
               lastEntry: day.lastEntry };
    }
    // 閉館までに滞在しきれるか。入れたとしても、15分で追い出されるなら
    // 行った意味がないので、そこも見ます。
    if (addMinutes(arrive, prof.dwell) > day.close) {
      return { ok: false, reason: REJECT.TOO_LATE, arrive };
    }
  }

  const end = addMinutes(arrive, prof.dwell);

  // ここが v2 に無かった判定 — 見た後、その日の終点に間に合うか。
  if (ctx.endPlace && ctx.endBy) {
    const backMin = travelFn(spot, ctx.endPlace);
    const arriveEnd = addMinutes(end, backMin);
    const limit = addMinutes(ctx.endBy, -TUNING.safetyBufferMin);
    if (arriveEnd > limit) {
      return { ok: false, reason: REJECT.CANNOT_FINISH, arrive, end, backMin };
    }
    return { ok: true, arrive, end, travel, wait, backMin };
  }

  return { ok: true, arrive, end, travel, wait };
}

/**
 * 候補をふるいにかけ、通ったものと落ちたもの（理由つき）を返します。
 * ここを通った候補だけをモデルに渡します。
 */
export function filterFeasible(spots, ctx) {
  const kept = [];
  const rejected = [];
  for (const spot of spots) {
    const r = checkSpot(spot, ctx);
    if (r.ok) kept.push({ spot, ...r });
    else rejected.push({ spot, reason: r.reason });
  }
  return { kept, rejected };
}

/** 落選理由の内訳。画面に「なぜ少ないのか」を出すために使います。 */
export function summarizeRejections(rejected) {
  const counts = {};
  for (const r of rejected) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
}
