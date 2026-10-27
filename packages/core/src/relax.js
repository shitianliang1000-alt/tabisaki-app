// 「できません」で終わらせない。
//
// 「富士登山をしたい」と書いて日帰りの条件だと、いまは
// 「時間内に行ける旅先が見つかりませんでした」で終わります。これは
// 正しいのですが、利用者が次に何をすればいいのか分かりません。
//
// 足りないのは何分なのか、1泊増やせば届くのか、は全部こちらで計算できます。
// 計算できることを「できません」の一言で潰さないための場所です。
//
// 返すのはデータだけで、画面の操作は app.js が受け持ちます。

import { nightsOf, totalMinutes } from "./trip.js";

/** 提案1件の形。apply は app.js が解釈して入力欄に反映します。 */
const opt = (id, label, detail, apply) => ({ id, label, detail, apply });

const hhmm = (min) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
};

/**
 * 行ける旅先が無かったときに、どうすれば行けるかを出します。
 *
 * @param {object} args
 * @param {object} args.trip
 * @param {Array}  args.rejected reachableRegions が返した届かなかった旅先
 * @param {string} [args.areaTerm] 利用者が指定した地名
 * @returns {Array} 提案
 */
export function relaxForUnreachable({ trip, rejected, areaTerm }) {
  const out = [];
  if (!rejected?.length) return out;

  // いちばん惜しい旅先（あと何分あれば届くか）
  const best = [...rejected].sort((a, b) => a.need - b.need)[0];
  const have = totalMinutes(trip);
  const short = Math.max(1, Math.round(best.need - have));
  const where = areaTerm ? `「${areaTerm}」` : best.region.name;

  // 当日中に延ばして届くなら、それがいちばん軽い変更
  if (short <= 6 * 60) {
    out.push(opt("extend", `到着を${hhmm(short)}遅くする`,
      `${where}に行くには、いまの日程だとあと${hhmm(short)}足りません。`
      + `到着時刻を${hhmm(short)}後ろにすれば届きます。`,
      { extendMinutes: short + 15 }));
  }

  // 泊まれば滞在の下限が変わるので、たいていはこちらが現実的
  const nights = nightsOf(trip);
  out.push(opt("addNight", nights === 0 ? "1泊2日にする" : `もう1泊増やす`,
    `${where}は${trip.origin?.name ?? "出発地"}から片道約`
    + `${hhmm(Math.round(best.oneWay))}です。`
    + `${nights === 0 ? "日帰りでは慌ただしいため、1泊すると" : "もう1泊すると"}`
    + "ゆとりを持って回れます。",
    { addNights: 1 }));

  out.push(opt("nearer", "近い旅先から選び直す",
    "地名の指定を外すと、いまの日程で行ける範囲から提案します。",
    { clearArea: true }));

  return out;
}

/**
 * 旅程は組めたが、削ったり埋まらなかったりしたときの提案。
 *
 * @param {object} args
 * @param {object} args.trip
 * @param {object} args.checked  verifyProposal の結果
 * @returns {Array}
 */
export function relaxForItinerary({ trip, checked }) {
  const out = [];
  const result = checked?.result;
  if (!result) return out;

  const dropped = checked.dropped?.length ?? 0;
  if (dropped > 0) {
    // 何分足りなかったのかは、余裕の不足分から言えます
    const shortMin = Math.max(30, -Math.min(0, result.slackMin) + 45);
    out.push(opt("extend", `到着を${hhmm(shortMin)}遅くする`,
      `時間が足りず${dropped}か所を外しました。`
      + `到着を${hhmm(shortMin)}遅くすれば、その分を戻せる見込みです。`,
      { extendMinutes: shortMin }));
    out.push(opt("relaxPace", "ゆっくり回る（立ち寄りを減らす）",
      "1か所あたりの滞在を長くして、立ち寄る数を絞ります。",
      { pace: "relaxed" }));
  }

  if (result.underfilled) {
    const u = result.underfilled;
    out.push(opt("shorten", `日程を${u.days}日短くする`,
      `${u.totalDays}日のうち${u.plannedDays}日ぶんしか予定を埋められませんでした。`
      + "この範囲の収録が足りていません。",
      { shortenDays: u.days }));
    out.push(opt("widen", "エリアの指定を広げる",
      "地名の指定を外すか、より広い地方名（「四国」→「中国・四国」など）に"
      + "すると、回れる先が増えます。",
      { clearArea: true }));
  }

  for (const c of checked.conflicts ?? []) {
    out.push(opt("earlier", "出発を1時間早める",
      `「必ず行く」に指定された${c.name}が入りませんでした。${c.detail}`,
      { startEarlierMinutes: 60 }));
  }

  return out;
}

/**
 * 組み上がった旅程の弱点を、こちらで計算して並べます。
 *
 * AIに「この旅程はどうですか」と聞くと、たいてい褒めます。
 * 移動が何割か・何km歩くかは計算できることなので、計算します。
 *
 * @param {object} itin buildItinerary の結果
 * @returns {Array<{key:string, label:string, text:string, level:string}>}
 */
export function critique(itin) {
  const items = itin.days.flatMap((d) => d.items);
  const minutes = (i) => Math.max(0, (i.end - i.start) / 60000);

  let move = 0, sight = 0, meal = 0, free = 0, walkKm = 0, wait = 0;
  for (const i of items) {
    switch (i.kind) {
      case "transit": move += minutes(i); if (i.walk) walkKm += i.km ?? 0; break;
      case "spot": sight += minutes(i); break;
      case "meal": meal += minutes(i); break;
      case "free": free += minutes(i); if (/開くまで/.test(i.detail ?? "")) wait += minutes(i); break;
      default: break;
    }
  }
  const active = move + sight + meal + free;
  const notes = [];

  if (active > 0) {
    const share = Math.round((move / active) * 100);
    notes.push({
      key: "move", label: "移動の割合",
      text: `旅程のうち移動が約${share}%（${hhmm(Math.round(move))}）です。`
        + `見学は${hhmm(Math.round(sight))}です。`,
      level: share >= 45 ? "warn" : "info",
    });
  }
  if (walkKm >= 0.3) {
    notes.push({
      key: "walk", label: "歩く距離",
      text: `徒歩での移動は合わせて約${walkKm.toFixed(1)}kmです。`,
      level: walkKm >= 8 ? "warn" : "info",
    });
  }
  if (wait >= 20) {
    notes.push({
      key: "wait", label: "待ち時間",
      text: `開館を待つ時間が合わせて約${hhmm(Math.round(wait))}あります。`
        + "順序を入れ替えると減らせる場合があります。",
      level: "info",
    });
  }

  // いちばん詰まっている日
  let busiest = null;
  for (const [i, d] of itin.days.entries()) {
    const n = d.items.filter((x) => x.kind === "spot").length;
    if (!busiest || n > busiest.n) busiest = { n, day: i + 1 };
  }
  if (busiest && itin.days.length > 1) {
    notes.push({
      key: "busiest", label: "いちばん詰まっている日",
      text: `${busiest.day}日目が${busiest.n}か所でいちばん多い日です。`,
      level: busiest.n >= 6 ? "warn" : "info",
    });
  }

  if (free - wait >= 90) {
    notes.push({
      key: "free", label: "自由時間",
      text: `予定の入っていない時間が合わせて約${hhmm(Math.round(free - wait))}`
        + "あります。現地で足せます。",
      level: "info",
    });
  }

  const unverified = items.filter((i) => i.kind === "spot"
    && i.place?.verified === false).length;
  if (unverified) {
    notes.push({
      key: "unverified", label: "未確認のデータ",
      text: `${unverified}か所は収録データではなくAIが調べたものです。`
        + "営業時間・場所は訪問前にご確認ください。",
      level: "warn",
    });
  }

  return notes;
}
