// 「営業中」と「入場できる」は別のことです。
//
// 17:00 閉館の城に 16:55 に着いても、入れません。最終入場が 16:30
// だからです。閉館時刻だけで判定した旅程は、この差のぶんだけ現地で
// 崩れます。半端な30分ではなく、その日の残りの予定が全部ずれます。
//
// 休みも同じです。毎週月曜の休館、年末年始、冬期休業。どれも
// 「早く着けば大丈夫」ではありません。行っても閉まっています。
//
// ここが扱うのは、その1点だけです。時刻の突き合わせは verify.js、
// 分類ごとの既定値は feasibility.js が持ちます。
//
// データの出どころ
// ----------------
//   ・spot.hours があればそれを使う（実データ）
//   ・無ければ分類ごとの目安（画面に「目安」と出す）
//   ・AIが調べたもの（verified === false）は、値があっても未確認扱い
//
// 「たぶんこの時間」を確定情報のように出すのが、いちばん危険です。

import { profileOf } from "./feasibility.js";

/**
 * 分類ごとの「閉館の何分前で入場を締めるか」。
 *
 * 券を売って中を見せる施設は、閉館前に受付を止めます。
 * 屋外で自由に見られる場所は締めません（0分）。
 */
const LAST_ENTRY_MIN = {
  城: 30, 博物館: 30, 美術館: 30, 水族館: 60, 動物園: 60,
  テーマパーク: 60, 庭園: 30, 展望台: 30, 灯台: 20, 酒蔵: 30,
  ロープウェイ: 30, スキー場: 60, 世界遺産: 30, 温泉: 60, 温泉地: 60,
  寺院: 15, 教会: 15, 市場: 30, 観光名所: 15,
  神社: 0, 公園: 0, 史跡: 0, 山: 0, 丘: 0, 滝: 0, 湖: 0,
  海岸: 0, 川: 0, 渓谷: 0, 国立公園: 0, 国定公園: 0, 飲食店: 0,
};

const DEFAULT_LAST_ENTRY_MIN = 30;

/** 夜景・ライトアップの時間帯。日が暮れてから、遅くまで。 */
const NIGHT_FROM = 18;
const NIGHT_TO = 22;

/**
 * 暗くなってからでないと意味のない場所か。
 *
 * 名前で見ます。分類（展望台・町並み）では分かりません。同じ展望台でも、
 * 昼に登る場所と夜景の場所があるからです。
 */
export function isNightOnly(spot) {
  const name = String(spot?.name ?? "");
  return /夜景|ライトアップ|イルミネーション|ナイトクルーズ/.test(name);
}

/** その分類で、閉館の何分前に入場が締まるか。 */
export function lastEntryOffsetFor(category) {
  return LAST_ENTRY_MIN[category] ?? DEFAULT_LAST_ENTRY_MIN;
}

/**
 * 分類ごとに「休みが多い曜日」。0=日曜 … 6=土曜。
 *
 * ここを定休日として扱ってはいけません。月曜開館の美術館はいくらでも
 * あり、勝手に落とせば行けるはずの場所が消えます。逆に黙って通せば、
 * 現地で閉まっています。どちらでもなく、注意として伝えます。
 */
const COMMON_CLOSED_DAY = {
  美術館: 1, 博物館: 1, 文化施設: 1, 水族館: 1, 動物園: 1, 酒蔵: 1,
};

const DAY_NAME = ["日", "月", "火", "水", "木", "金", "土"];

const mmdd = (date) =>
  `${String(date.getMonth() + 1).padStart(2, "0")}-`
  + String(date.getDate()).padStart(2, "0");

/**
 * 「MM-DD」の範囲に入るか。年をまたぐ範囲（12-29..01-03）も扱います。
 * 年末年始の休館はこの形でしか書けないので、必要な処理です。
 */
function inDateRange(today, from, to) {
  if (from <= to) return today >= from && today <= to;
  return today >= from || today <= to;
}

function parseRange(spec) {
  if (Array.isArray(spec)) return [spec[0], spec[1] ?? spec[0]];
  const s = String(spec);
  const m = s.split("..");
  return [m[0], m[1] ?? m[0]];
}

function atHourOf(date, hour) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() + hour * 3600000);
}

/**
 * その日の、その場所の開き方。
 *
 * @param {object} spot
 * @param {Date} date  訪れる日
 * @param {string} [pace]
 * @returns {{closed:boolean, reason:string|null, alwaysOpen:boolean,
 *            open:Date|null, close:Date|null, lastEntry:Date|null,
 *            openHour:number, closeHour:number,
 *            estimated:boolean, lastEntryEstimated:boolean, note:string}}
 */
export function hoursFor(spot, date, pace = "balanced") {
  const prof = profileOf(spot, pace);
  const h = spot?.hours ?? {};
  const today = mmdd(date);
  const dow = date.getDay();

  // --- 休みかどうか。休みなら時刻は関係ありません ---
  const closedDays = h.closedDays ?? prof.closedDays ?? [];
  if (closedDays.includes(dow)) {
    return closedResult(`定休日（毎週${DAY_NAME[dow]}曜）`, spot, prof);
  }
  for (const spec of h.closedDates ?? []) {
    const [from, to] = parseRange(spec);
    if (inDateRange(today, from, to)) {
      return closedResult(`休業日（${from}〜${to}）`, spot, prof);
    }
  }
  for (const spec of h.closedSeasons ?? []) {
    const [from, to] = parseRange(spec);
    if (inDateRange(today, from, to)) {
      return closedResult(`休業期間（${from}〜${to}）`, spot, prof);
    }
  }

  // --- その日の時間 ---
  // 優先順位は 曜日ごと > 季節ごと > 既定。細かいほうを勝たせます。
  let openHour = h.open ?? prof.open;
  let closeHour = h.close ?? prof.close;
  let lastEntryHour = h.lastEntry;

  for (const s of h.seasons ?? []) {
    if (inDateRange(today, s.from, s.to)) {
      openHour = s.open ?? openHour;
      closeHour = s.close ?? closeHour;
      if (s.lastEntry !== undefined) lastEntryHour = s.lastEntry;
    }
  }
  const byDay = h.byDay?.[dow] ?? h.byDay?.[String(dow)];
  if (byDay) {
    openHour = byDay.open ?? openHour;
    closeHour = byDay.close ?? closeHour;
    if (byDay.lastEntry !== undefined) lastEntryHour = byDay.lastEntry;
  }

  // 暗くなってからでないと意味のない場所は、夜に回します。
  //
  // 「函館山からの函館市街地の夜景」が、10:37 に入っていました。時刻表も
  // 営業時間も間違っていません。ただ、**朝に見る夜景はありません**。
  // 名前がそう言っている場所だけを、日が暮れてからの時間帯にします。
  // 収録に時間が書いてあるなら、そちらが勝ちます（そこまでは分かって
  // 書かれた値なので、推し量りで上書きしません）。
  if (isNightOnly(spot) && h.open === undefined && h.close === undefined) {
    openHour = Math.max(openHour, NIGHT_FROM);
    closeHour = Math.max(closeHour, NIGHT_TO) === 24 ? NIGHT_TO
      : Math.max(closeHour, NIGHT_TO);
  }

  const alwaysOpen = openHour === 0 && closeHour === 24;
  const open = alwaysOpen ? null : atHourOf(date, openHour);
  const close = alwaysOpen ? null : atHourOf(date, closeHour);

  // --- 最終入場 ---
  let lastEntry = null;
  let lastEntryEstimated = false;
  if (!alwaysOpen) {
    if (lastEntryHour !== undefined && lastEntryHour !== null) {
      lastEntry = atHourOf(date, lastEntryHour);
    } else {
      const off = lastEntryOffsetFor(spot?.category);
      lastEntry = new Date(close.getTime() - off * 60000);
      lastEntryEstimated = off > 0;
    }
    // 閉館より後の最終入場はありえません。データの誤りは丸めます。
    if (lastEntry > close) lastEntry = new Date(close);
  }

  // 実データの定休日が無い分類のうち、その曜日に休みが多いもの。
  const common = COMMON_CLOSED_DAY[spot?.category];
  const knowsClosedDays = Array.isArray(h.closedDays) && h.closedDays.length > 0;
  const riskyDay = !knowsClosedDays && common === dow;

  const estimated = prof.estimated;
  return {
    closed: false, reason: null, alwaysOpen,
    open, close, lastEntry, openHour, closeHour,
    estimated, lastEntryEstimated,
    riskyDay,
    riskyNote: riskyDay
      ? `${spot.category}は${DAY_NAME[dow]}曜が休館のことが多い分類です。`
        + "この施設の定休日は確認できていないので、訪問前にご確認ください。"
      : null,
    note: noteFor(spot, estimated, lastEntryEstimated),
  };
}

function closedResult(reason, spot, prof) {
  return {
    closed: true, reason, alwaysOpen: false,
    open: null, close: null, lastEntry: null,
    openHour: prof.open, closeHour: prof.close,
    estimated: prof.estimated, lastEntryEstimated: false,
    riskyDay: false, riskyNote: null,
    note: noteFor(spot, prof.estimated, false),
  };
}

// 季節で開閉時刻が動く場所。
//
// 浅草寺の本堂は4月〜9月が6:00、10月〜3月は6:30に開きます。庭園や
// 城跡も、夏と冬で閉門が1時間ちがうことがあります。収録にあるのは
// 1組の時刻だけなので、**「確認済み」と言い切ると危ない**分類です。
// 数字は消しません。動くことがある、と添えます。
const SEASONAL = new Set(["寺院", "神社", "庭園", "城", "史跡", "名勝",
                          "公園", "展望台"]);

function noteFor(spot, estimated, lastEntryEstimated) {
  if (spot?.verified === false) {
    return "AIが調べた未確認の情報です。訪問前に公式でご確認ください。";
  }
  if (estimated) {
    return "分類ごとの目安です。訪問前に公式でご確認ください。";
  }
  if (lastEntryEstimated) {
    return "最終入場は分類ごとの目安です（閉館時刻は実データ）。";
  }
  if (SEASONAL.has(spot?.category)) {
    return "季節によって開閉の時刻が変わることがあります。";
  }
  return "";
}

const fmt = (d) => d
  ? `${String(d.getHours()).padStart(2, "0")}:`
    + String(d.getMinutes()).padStart(2, "0")
  : "";

/** 画面にそのまま出せる一文。 */
export function describeHours(spot, date, pace = "balanced") {
  const h = hoursFor(spot, date, pace);
  if (h.closed) return `休み — ${h.reason}`;
  if (h.alwaysOpen) return "いつでも見学できます";
  const parts = [`${fmt(h.open)}〜${fmt(h.close)}`];
  if (h.lastEntry && +h.lastEntry !== +h.close) {
    parts.push(`最終入場 ${fmt(h.lastEntry)}`);
  }
  const closedDays = spot?.hours?.closedDays ?? [];
  if (closedDays.length) {
    parts.push(`定休 ${closedDays.map((d) => `${DAY_NAME[d]}曜`).join("・")}`);
  }
  return parts.join("・");
}
