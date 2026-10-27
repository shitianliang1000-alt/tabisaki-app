// 出る時刻を、画面を見ていなくても知らせる。
//
// 旅行中モードは「あと12分で出発」と出しますが、**その画面を開いて
// いなければ何も起きません**。当日、人は地図アプリを見ていたり、
// 写真を撮っていたり、そもそも携帯を鞄に入れています。12分は
// あっという間に過ぎ、駅に着いたら電車は出たあとです。
//
// ブラウザには通知の仕組みがあります。使えば済む話です。
//
// ■ できること・できないこと（ここを曖昧にしません）
//
// このアプリには**サーバがありません**。GitHub Pages に置いた静的な
// ファイルと、Cloudflare の中継だけです。つまり
//
//   ・**プッシュ通知はできません。** 端末に向けて外から鳴らすには、
//     鍵を持ったサーバが要ります。持っていません。
//   ・できるのは、**この画面を開いているあいだに、時間が来たら鳴らす**
//     ことだけです。タブを閉じると止まります。
//
// これを黙って「お知らせします」と書くのは嘘になります。旅先で
// 頼りにされて、鳴らないのがいちばん困ります。画面にもそう書きます
//（NOTICE_LIMITS）。
//
// ■ いつ知らせるか
//
// 「出発の15分前」だけでは足りません。空港へは1時間前に着く必要が
// あり、船はもっと早く締まります（packages/core/src/modes.js の BOARDING_LEAD_MIN。
// 根拠もそこに書いてあります）。乗り物で変えます。

import { BOARDING_LEAD_MIN } from "../packages/core/src/modes.js";

/**
 * この仕組みでできないこと。画面にそのまま出します。
 *
 * **持っていないものは持っていないと言います。**
 */
export const NOTICE_LIMITS =
  "お知らせは、この端末でこの画面を開いているあいだだけ鳴ります"
  + "（このアプリにはサーバが無いので、閉じているあいだに鳴らすことは"
  + "できません）。大事な便は、端末のアラームにも入れてください。";

/** ふつうの予定は、何分前に知らせるか。 */
export const LEAD_MIN = {
  transit: 15,
  spot: 10,
  meal: 10,
  lodging: 20,
  luggage: 10,
};

/** 表に無い種類は、知らせません（何の予定か分からないので）。 */
const SKIP = new Set(["free", "arrive"]);

/**
 * その予定を、何分前に知らせるか。
 *
 * 空路・航路は、乗り物の側の締切が先に来ます。15分前に知らせても、
 * 保安検査はもう締まっています。
 */
export function leadFor(item) {
  if (!item || SKIP.has(item.kind)) return null;
  const base = LEAD_MIN[item.kind];
  if (!base) return null;
  const kinds = Array.isArray(item.vehicle?.kinds) ? item.vehicle.kinds : [];
  const boarding = kinds
    .map((k) => BOARDING_LEAD_MIN[k])
    .filter((n) => Number.isFinite(n));
  // 乗り物の締切があるなら、そのぶん前に。さらに支度の15分を足します。
  if (boarding.length) return Math.max(...boarding) + base;
  return base;
}

/** 知らせの文。読んだだけで、何をすればいいかが分かる長さにします。 */
function bodyOf(item, lead) {
  const at = hhmm(item.start);
  if (item.kind === "transit") {
    const kinds = Array.isArray(item.vehicle?.kinds) ? item.vehicle.kinds : [];
    if (kinds.includes("air")) {
      return `${at} の便です。搭乗手続きと保安検査があるので、`
        + "そろそろ空港へ向かってください。";
    }
    if (kinds.includes("ferry")) {
      return `${at} の便です。乗船手続きは早めに締まります。`
        + "港へ向かってください。";
    }
    return `${at} 出発です。あと${lead}分。`;
  }
  if (item.kind === "lodging") return `${at} に宿へ。あと${lead}分。`;
  return `${at} から。あと${lead}分。`;
}

function hhmm(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return "--:--";
  return `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/**
 * 旅程から、鳴らす時刻の一覧を作ります。
 *
 * ここは**数えるだけ**です。通知そのものは知りません（試験で
 * 時計を進めずに確かめられるようにするためです）。
 *
 * @param {object} itin
 * @param {Date} now これより前のものは作りません（過ぎた予定を
 *   鳴らしても、驚かせるだけです）
 * @param {{horizonHours?:number}} [opts]
 *   horizonHours … 何時間先まで作るか。既定は16。丸1日ぶんの
 *   タイマーを一度に積むと、途中で旅程を組み直したときに古い
 *   知らせが残ります。
 * @returns {Array<{at:Date, title:string, body:string, itemId:string}>}
 */
export function scheduleNotices(itin, now = new Date(), opts = {}) {
  const horizon = (Number.isFinite(opts.horizonHours) ? opts.horizonHours : 16)
    * 3600000;
  const out = [];
  for (const day of itin?.days ?? []) {
    for (const item of day?.items ?? []) {
      const lead = leadFor(item);
      if (lead == null || !item.start) continue;
      const start = new Date(item.start);
      if (Number.isNaN(start.getTime())) continue;
      const at = new Date(start.getTime() - lead * 60000);
      // 過ぎたものと、遠すぎるものは作りません。
      if (at <= now) continue;
      if (at - now > horizon) continue;
      out.push({
        at, itemId: item.id,
        title: item.title ?? "つぎの予定",
        body: bodyOf(item, lead),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 知らせを仕掛けます。
 *
 * @param {Array} notices scheduleNotices の結果
 * @param {object} opts
 *   show      … ({title, body}) => void  実際に鳴らす関数
 *   now       … () => Date
 *   setTimer  … (fn, ms) => id（試験で差し替えます）
 *   clearTimer… (id) => void
 * @returns {{stop:()=>void, count:number}}
 */
export function armNotices(notices, opts = {}) {
  const now = opts.now ?? (() => new Date());
  const setTimer = opts.setTimer
    ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = opts.clearTimer
    ?? ((id) => globalThis.clearTimeout(id));
  const ids = [];
  for (const n of notices ?? []) {
    const ms = new Date(n.at) - now();
    // **負の待ち時間を 0 にしません。** 0 にすると、開いた瞬間に
    // 過ぎた知らせがまとめて鳴ります。
    if (!(ms > 0)) continue;
    // setTimeout は約24.8日で溢れます。ここは16時間までですが、
    // 呼ぶ側が horizon を広げたときに黙って即発火しないよう見ます。
    if (ms > 2 ** 31 - 1) continue;
    ids.push(setTimer(() => opts.show?.(n), ms));
  }
  return {
    count: ids.length,
    stop() { for (const id of ids) clearTimer(id); ids.length = 0; },
  };
}

/**
 * 通知を使ってよいか、端末に聞きます。
 *
 * **押されてから聞きます。** 開いた瞬間に許可を求めるのは、いちばん
 * 断られる聞きかたです（何に使うのか分からないためです）。
 *
 * @returns {Promise<{ok:boolean, why:string}>}
 */
export async function askNotifyPermission(api = globalThis.Notification) {
  if (!api) {
    return { ok: false, why: "この端末では通知を使えません" };
  }
  if (api.permission === "granted") return { ok: true, why: "" };
  if (api.permission === "denied") {
    return { ok: false,
      why: "通知が許可されていません（ブラウザの設定から変えられます）" };
  }
  let res;
  try {
    res = await api.requestPermission();
  } catch {
    return { ok: false, why: "通知を求められませんでした" };
  }
  return res === "granted"
    ? { ok: true, why: "" }
    : { ok: false, why: "通知は使わない設定になりました" };
}
