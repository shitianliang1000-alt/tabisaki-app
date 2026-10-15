// チャットに書かれた条件を読み取る。
//
// 「明日から1泊2日で、大阪から。穴場多めで」と書いた人に、細かい設定
// （出発地・日時・まわる場所）を別に開かせるのは二度手間です。しかも
// 設定が「東京駅・今日」のままだと、書いたことと違う旅程が返ります。
//
// **書いたことが、設定より勝ちます。** ここで読み取った分は、組む前に
// 設定の欄へ書き込みます（js/app.js の applyChat）。読み取れないものは
// 読み取れないままにします。日付を推し量って外すより、設定どおりに
// 組むほうが、何が起きたかを本人が追えます。
//
// 読み取ったものは、チャットの吹き出しの下に「読み取った条件」として
// 並べます。何を拾ったのかが見えないと、直しようがありません。

import { readWish } from "./sunny.js";
import { purposeLabel, readPurposes, stripPurposeWords } from "./purpose.js";

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** 漢数字（一〜十）も数にします。「二泊三日」と書く人がいます。 */
const KANJI_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function num(s) {
  if (s == null) return null;
  const t = String(s).normalize("NFKC");
  if (/^\d+$/.test(t)) return Number(t);
  if (/^十[一二三四五六七八九]?$/.test(t)) return 10 + (KANJI_NUM[t[1]] ?? 0);
  if (/^[一二三四五六七八九]十$/.test(t)) return KANJI_NUM[t[0]] * 10;
  return KANJI_NUM[t] ?? null;
}
const N = "(\\d{1,2}|[一二三四五六七八九十]{1,2})";

/** その日の0時。 */
function day0(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { const x = day0(d); x.setDate(x.getDate() + n); return x; }

/** 今日から見て、次のその曜日（今日がその曜日なら今日）。 */
function nextWeekday(now, wd) {
  const d = day0(now);
  return addDays(d, (wd - d.getDay() + 7) % 7);
}

/** 時刻の言い回し（「9時」「9時半」「9:30」）を、時の数にします。 */
function hourOf(h, half, min) {
  const H = num(h);
  if (H == null || H > 24) return null;
  const M = half ? 30 : Number(min ?? 0);
  return H + Math.min(59, M) / 60;
}

/**
 * 出発地として読まない語。「明日から」「朝から」は場所ではありません。
 * 末尾がこれなら捨てます。
 */
const NOT_PLACE = /(今日|本日|明日|明後日|あさって|週末|土日|曜日?|[月火水木金土日]曜|時|時半|分|朝|昼|夜|夕方|午前|午後|日|月|年|今|ここ|そこ|家|自宅|会社|職場|うち|最初|始め|はじめ|次|前|後|以上|以下|から|出|始|再|初|自)$/;
/** ひらがなの地名（駅名）。字の種類で場所を拾うので、別に持ちます。 */
const KANA_PLACES = "つくば|さいたま|ひたちなか|いわき|むつ|えびの|うきは|みどり|あきる野|かすみがうら|つくばみらい|ふじみ野|いすみ";
const PLACE = `((?:${KANA_PLACES})駅?|[一-龯々〆ヵヶァ-ヴー]{1,12}?駅?)`;

/**
 * 書かれた条件を読み取ります。
 *
 * @param {string} text
 * @param {Date} [now]
 * @returns {{
 *   start: Date|null, nights: number|null,
 *   departHour: number|null, returnHour: number|null,
 *   origin: string|null, mix: number|null, avoidCrowds: boolean|null, sunny: boolean,
 *   people: number|null, budgetYen: number|null, purposes: string[],
 *   labels: string[], rest: string, found: boolean,
 * }}
 */
export function readChat(text, now = new Date()) {
  const src = String(text ?? "").normalize("NFKC");
  const out = {
    start: null, nights: null, departHour: null, returnHour: null,
    origin: null, mix: null, avoidCrowds: null, people: null, budgetYen: null,
    purposes: [], labels: [], rest: src, found: false,
  };
  let rest = src;
  const take = (re) => {
    const m = rest.match(re);
    if (m) rest = rest.replace(m[0], " ");
    return m;
  };

  // --- いつ ----------------------------------------------------------------
  let m;
  if ((m = take(/(\d{1,2})月(\d{1,2})日/)) || (m = take(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/))) {
    const mo = Number(m[1]) - 1, d = Number(m[2]);
    if (mo >= 0 && mo < 12 && d >= 1 && d <= 31) {
      let date = new Date(now.getFullYear(), mo, d);
      if (date < day0(now)) date = new Date(now.getFullYear() + 1, mo, d);
      out.start = date;
    }
  } else if ((m = take(/しあさって|明々後日/))) out.start = addDays(now, 3);
  else if ((m = take(/明後日|あさって/))) out.start = addDays(now, 2);
  else if ((m = take(/明日|あした|あす/))) out.start = addDays(now, 1);
  else if ((m = take(/今日|本日|きょう/))) out.start = day0(now);
  else if ((m = take(/(来週|再来週)の?(?:週末|土日)/))) {
    out.start = addDays(nextWeekday(now, 6), m[1] === "再来週" ? 14 : 7);
    if (out.nights == null && /土日/.test(m[0])) out.nights = 1;
  } else if ((m = take(/(今週末|週末|今週の?土日|土日)/))) {
    // 日曜に「週末」と言われたら今日（もう土曜は過ぎています）。
    out.start = day0(now).getDay() === 0 ? day0(now) : nextWeekday(now, 6);
    if (/土日/.test(m[0])) out.nights = 1;
  } else if ((m = take(/(来週|再来週|今度|今週)?の?([月火水木金土日])曜日?/))) {
    const wd = WEEK.indexOf(m[2]);
    let d = nextWeekday(now, wd);
    if (m[1] === "来週" || m[1] === "再来週") {
      // 来週の◯曜: 次の月曜から始まる週のその曜日。
      const monday = nextWeekday(addDays(now, 1), 1);
      d = addDays(monday, (wd + 6) % 7 + (m[1] === "再来週" ? 7 : 0));
    }
    out.start = d;
  }

  // --- 何日 ----------------------------------------------------------------
  if ((m = take(/日帰り/))) out.nights = 0;
  else if ((m = take(new RegExp(`${N}泊(?:${N}日)?`)))) out.nights = num(m[1]);
  else if ((m = take(new RegExp(`${N}日間`)))) {
    const n = num(m[1]);
    if (n != null && n >= 1) out.nights = n - 1;
  }
  if (out.nights != null && (out.nights < 0 || out.nights > 20)) out.nights = null;

  // --- 何時 ----------------------------------------------------------------
  // 帰りを先に見ます（「19時までに帰る」の「19時」を出発と読まないように）。
  if ((m = take(/(\d{1,2}|[一二三四五六七八九十]{1,2})(?:時(半)?|:(\d{2}))(?:頃|ごろ)?(?:まで(?:に)?|には)(?:帰|戻|着)[^\s、。]*/))) {
    out.returnHour = hourOf(m[1], m[2], m[3]);
  }
  if ((m = take(/(\d{1,2}|[一二三四五六七八九十]{1,2})(?:時(半)?|:(\d{2}))(?:頃|ごろ)?(?:に|から)?(?:出発|発|出る|出て|スタート)/))) {
    out.departHour = hourOf(m[1], m[2], m[3]);
  } else if ((m = take(/朝(?:早く|早め|一番|いち)|早朝/))) {
    out.departHour = 7;
  }

  // --- どこから ------------------------------------------------------------
  // 「青森駅でスタート」「青森駅スタート」も出発地です。
  const fromRe = new RegExp(`${PLACE}(?:から|を?出発|で?スタート|発(?![見表明売電]))`, "g");
  for (const hit of rest.matchAll(fromRe)) {
    const name = hit[1];
    if (NOT_PLACE.test(name)) continue;
    out.origin = name;
    rest = rest.replace(hit[0], " ");
    break;
  }

  // 「東京に近いところ」は、東京を出発地として読みます（行き先ではありません）。
  const wish = readWish(src);
  if (!out.origin && wish.nearPlace && !NOT_PLACE.test(wish.nearPlace)) out.origin = wish.nearPlace;
  out.sunny = wish.sunny;

  // --- 旅のしかた ----------------------------------------------------------
  if ((m = take(/穴場(?:多め|中心|が?多く|を?多く|めぐり|巡り)?|知る人ぞ知る|マイナー(?:な|め)?|ディープ/))) out.mix = 75;
  else if ((m = take(/定番(?:中心|多め|どころ)?|王道|有名(?:な|どころ|所)/))) out.mix = 15;

  if ((m = take(/(?:混雑|混み|人混み|人ごみ)(?:は|を|が)?(?:避け|さけ|苦手|いや|嫌|なし)[^\s、。]*|空いて(?:いる|る)[^\s、。]*|人が少な[^\s、。]*/))) {
    out.avoidCrowds = true;
  } else if ((m = take(/混ん(?:で)?(?:いても|でも)(?:いい|よい|大丈夫|平気)/))) {
    out.avoidCrowds = false;
  }

  if ((m = take(/一人旅|ひとり旅|ひとりで|一人で|1人で|ソロ/))) out.people = 1;
  else if ((m = take(/二人旅|ふたり旅|ふたりで|二人で|夫婦|カップル|恋人と/))) out.people = 2;
  else if ((m = take(new RegExp(`(?:家族|友達|友人|仲間)?${N}人(?:で|旅|家族)?`)))) {
    const n = num(m[1]);
    if (n && n <= 20) out.people = Math.min(6, n);
  }

  if ((m = take(/予算(?:は|が)?(?:ひとり|一人|1人)?(?:あたり)?(\d+(?:\.\d+)?)万円?(?:以内|まで|くらい|程度)?/))) {
    out.budgetYen = Math.round(Number(m[1]) * 10000);
  } else if ((m = take(/(\d+(?:\.\d+)?)万円(?:以内|まで)/))) {
    out.budgetYen = Math.round(Number(m[1]) * 10000);
  } else if ((m = take(/予算(?:は|が)?(\d{4,7})円|(\d{4,7})円(?:以内|まで)/))) {
    out.budgetYen = Number(m[1] ?? m[2]);
  }

  // --- 並べる言葉 ------------------------------------------------------------
  const L = out.labels;
  if (out.start) {
    L.push(`${out.start.getMonth() + 1}月${out.start.getDate()}日（${WEEK[out.start.getDay()]}）から`);
  }
  if (out.nights != null) L.push(out.nights === 0 ? "日帰り" : `${out.nights}泊${out.nights + 1}日`);
  if (out.departHour != null) L.push(`${fmtHour(out.departHour)}に出発`);
  if (out.returnHour != null) L.push(`${fmtHour(out.returnHour)}までに帰る`);
  if (out.origin) L.push(`${out.origin}から`);
  if (out.sunny) L.push("晴れる所");
  if (wish.near) L.push("近場");
  if (out.mix === 75) L.push("穴場多め");
  if (out.mix === 15) L.push("定番中心");
  if (out.avoidCrowds === true) L.push("混雑を避ける");
  if (out.avoidCrowds === false) L.push("混雑は気にしない");
  if (out.people) L.push(`${out.people}人`);
  // 旅の目的（デート・アクティブ…）も js/pipeline.js が文から読みます。
  // 設定（こだわりの「旅の目的」）にも書き込みます（js/app.js の applyChat）。
  out.purposes = readPurposes(src);
  if (out.purposes.length) rest = stripPurposeWords(rest);
  for (const id of out.purposes) L.push(`目的: ${purposeLabel(id)}`);
  // 乗り物と旅の形は js/pipeline.js が読みます（文が設定に勝ちます）。
  // ここでは、読んだことが見えるように札だけ出します。
  if (/青春18|18きっぷ|鈍行|各駅停車|普通列車(?:のみ|だけ|で)/.test(src)) L.push("普通列車のみ");
  if (/日本(?:列島)?縦断|列島縦断/.test(src)) L.push("日本縦断（片道）");
  if (out.budgetYen) L.push(`予算 ${(out.budgetYen / 10000).toLocaleString("ja-JP")}万円`);

  out.found = L.length > 0;
  out.rest = rest.replace(/\s+/g, " ").trim();
  return out;
}

/**
 * 希望文から「◯◯から」「◯◯でスタート」の部分を消します（出発地の名前のときだけ）。
 * 出発地を行き先として読まないためです（「青森駅でスタート」で青森を
 * 行き先に選ぶと、縦断の旅が青森から始まりません）。
 */
export function stripOriginPhrase(text, originName) {
  const base = String(originName ?? "").normalize("NFKC").replace(/駅$/, "").trim();
  const s = String(text ?? "");
  if (!base) return s;
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.normalize("NFKC")
    .replace(new RegExp(`${esc}駅?(?:から(?:出発|スタート)?|を?出発|で?スタート|発(?![見表明売電]))`, "g"), " ");
}

export function fmtHour(h) {
  const H = Math.floor(h), M = Math.round((h - H) * 60);
  return `${H}:${String(M).padStart(2, "0")}`;
}

/**
 * 条件を取り除いた残りに、旅の中身が書いてあるか。
 *
 * 「明日にして」「大阪からで」のように、条件だけを言い直した返信なら、
 * 前の希望のまま条件を変えて組み直します。中身が書いてあれば、
 * 新しい希望として扱います（または旅程の直し）。
 */
export function hasSubstance(rest) {
  const t = String(rest ?? "")
    .replace(/[、。,.!！?？\s「」『』（）()・〜~ー-]/g, "")
    .replace(/(にして|に変えて|にかえて|に変更|でお願い|でおねがい|でいい|でいく|で行く|でください|ください|お願いします|おねがいします|お願い|おねがい|して|します|したい|がいい|にする|で|に|は|を|が|の|と|も|へ|や|ね|よ|な)/g, "");
  return t.length >= 2;
}
