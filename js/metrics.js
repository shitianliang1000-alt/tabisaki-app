// 使われかたを、名前の無い件数として数える。
//
// 何が使われ、どこで止まっているのかが分からないと、直す順番を
// 決められません。「旅程をつくった」「組めなかった（圏外で）」
// 「1か所を外した」のような出来事を、**件数だけ**数えます。
//
// 送らないもの
// ------------
//   入力した文・地名・旅程・位置・端末の識別子・Cookie。
//   送るのは決まった出来事の名前（EVENTS）と、決まった言葉の補足
//   （DETAILS）だけです。それ以外の文字列は、ここで落とします。
//   IP は中継（Cloudflare Worker）を通るので届きますが、Worker は
//   保存しません（server/worker.js の metrics）。
//
// 送らないとき
// ------------
//   - 設定で「使われかたの集計に協力する」を入れていないとき（既定は
//     入れていません。数えてよいかは、利用者が自分で決めます）
//   - ブラウザが Global Privacy Control / Do Not Track を出しているとき
//   - 中継（PROXY_URL）が無いとき（自分のキーで動かしている人の分は
//     数えません。そもそも届け先がありません）
//
// 失敗しても黙って捨てます。数えることのために、旅程づくりを1ミリ秒も
// 待たせません（sendBeacon は、ページを閉じる瞬間でも送れて、返事を
// 待ちません）。

// 末尾の「/」をすべて外す。/\/+$/ は「/」が続く長い文字列で遅くなる
// （CodeQL: polynomial regular expression）ので、正規表現を使わない。
function trimSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** 数える出来事。ここに無いものは送りません。 */
export const EVENTS = new Set([
  "plan_ok",        // 旅程ができた
  "plan_error",     // 旅程を組めなかった
  "offline_seen",   // 圏外の帯が出た
  "spot_replace",   // 「別の候補」
  "spot_remove",    // 「外す」
]);

/** 補足として許す言葉。ここに無いものは空にします。 */
export const DETAILS = new Set([
  // 移動手段
  "transit", "car", "transit+car", "walk",
  // 組めなかった理由（js/errors.js の kind）
  "plan", "offline", "network", "kb", "quota",
]);

/**
 * 旅程づくりの条件として送ってよい言葉（管理画面の「入力条件の分布」）。
 * 自由な文字は送りません。どれも、決まった選択肢のどれか1つです。
 * server/worker.js もここを読んで、同じ言葉だけを受け取ります。
 */
export const CONDITIONS = Object.freeze({
  t: ["any", "transit", "car", "transit+car", "air", "air+car", "ferry", "local", "walk"],
  days: ["1", "2", "3", "4+"],
  p: ["1", "2", "3-4", "5+"],
  b: ["yes", "no"],          // 予算を決めたか
  h: ["low", "mid", "high"], // 穴場の混ぜかた
  n: ["yes", "no"],          // 希望の文を書いたか（中身は送りません）
  k: ["yes", "no"],          // 混雑を避けるか
  pin: ["yes", "no"],        // 「必ず行く」を選んだか
  g: ["art", "city", "food", "history", "nature", "onsen", "sea", "view"], // 好み（複数）
});

/** 旅程の条件を、上の言葉にします。 */
export function conditionsOf(trip = {}, { pinned = 0 } = {}) {
  const days = Math.ceil(((trip.arriveBy ?? 0) - (trip.departAt ?? 0)) / 86400000);
  const people = Number(trip.people ?? 1);
  const bias = Number(trip.hiddenBias ?? 0.4);
  return {
    t: String(trip.transport ?? "any"),
    days: !(days > 0) ? "1" : days >= 4 ? "4+" : String(days),
    p: people >= 5 ? "5+" : people >= 3 ? "3-4" : people === 2 ? "2" : "1",
    b: trip.budgetYen ? "yes" : "no",
    h: bias <= 0.3 ? "low" : bias <= 0.6 ? "mid" : "high",
    n: String(trip.note ?? "").trim() ? "yes" : "no",
    k: trip.avoidCrowds ? "yes" : "no",
    pin: pinned > 0 ? "yes" : "no",
    g: [...new Set(trip.interests ?? [])],
  };
}

/**
 * 出来事に添える数と条件を、送ってよいものだけにします。
 *   s … 組み立てにかかった秒（0〜1800）
 *   r … AIに聞き直した回数（1〜9）
 *   c … 条件（CONDITIONS の言葉だけ）
 */
export function cleanExtra(extra) {
  const out = {};
  const s = Math.round(Number(extra?.s));
  if (Number.isFinite(s) && s >= 0 && s <= 1800) out.s = s;
  const r = Math.round(Number(extra?.r));
  if (Number.isFinite(r) && r >= 1 && r <= 9) out.r = r;
  const c = extra?.c;
  if (c && typeof c === "object") {
    const cc = {};
    for (const [k, allowed] of Object.entries(CONDITIONS)) {
      if (k === "g") {
        const g = Array.isArray(c.g) ? [...new Set(c.g.filter((x) => allowed.includes(x)))] : [];
        if (g.length) cc.g = g;
      } else if (allowed.includes(String(c[k]))) {
        cc[k] = String(c[k]);
      }
    }
    if (Object.keys(cc).length) out.c = cc;
  }
  return out;
}

export const METRICS_KEY = "tabisaki.metrics";

/**
 * 集計に協力するか。
 *
 * **既定は「協力する」です。** 設定の「使われかたの集計に協力しない」に
 * チェックを入れた人（保存した値が "off"）のぶんだけ、数えるのをやめます。
 * 値が無い人も、前の版で "on" を保存した人も、数えます（どちらも
 * 「止めた」とは言っていません）。前の版で "off" にした人は、そのまま
 * 止まったままです。
 */
export function metricsEnabled(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(METRICS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setMetricsEnabled(on, storage = globalThis.localStorage) {
  try {
    storage?.setItem(METRICS_KEY, on ? "on" : "off");
  } catch { /* 保存できない環境では、毎回の既定に戻ります */ }
}

/** ブラウザが「追跡しないで」と言っているか。 */
export function browserOptedOut(nav = globalThis.navigator) {
  if (nav?.globalPrivacyControl === true) return true;
  return nav?.doNotTrack === "1";
}

/**
 * 送る中身を作ります。送れないもの・送らないものは null。
 * @returns {string|null} JSON 文字列
 */
export function metricBody(event, detail = "", extra = null) {
  if (!EVENTS.has(event)) return null;
  const d = DETAILS.has(detail) ? detail : "";
  return JSON.stringify({ e: event, d, ...cleanExtra(extra) });
}

// 圏外のあいだに起きたことは、つながったときに送ります。
// 圏外で送ると捨てられるので、「圏外で組めなかった」がいちばん
// 数えたいのに、いちばん数えられない、ということになります。
// 端末には残しません（このページを開いているあいだだけ持ちます）。
const MAX_QUEUED = 20;
const queued = [];
let listening = false;

/** 圏外のあいだに貯めたぶんを送ります。 */
export function flushQueued(opts = {}) {
  const items = queued.splice(0, queued.length);
  let sent = 0;
  for (const [event, detail, extra] of items) {
    if (track(event, detail, { ...opts, extra })) sent++;
  }
  return sent;
}

/** 試験用。貯めている件数。 */
export function queuedCount() { return queued.length; }

/**
 * 1件数えます。
 *
 * @param {string} event
 * @param {string} [detail]
 * @param {object} [env] 試験のための差し替え
 * @returns {boolean} 送ったかどうか
 */
export function track(event, detail = "", {
  proxyUrl = "",
  nav = globalThis.navigator,
  storage = globalThis.localStorage,
  extra = null,
} = {}) {
  const base = trimSlashes(String(proxyUrl ?? "").trim());
  if (!/^https:\/\//i.test(base)) return false;
  if (!metricsEnabled(storage) || browserOptedOut(nav)) return false;
  const body = metricBody(event, detail, extra);
  if (!body) return false;
  if (nav?.onLine === false) {
    if (queued.length < MAX_QUEUED) queued.push([event, detail, extra]);
    if (!listening && globalThis.addEventListener) {
      listening = true;
      globalThis.addEventListener("online",
        () => flushQueued({ proxyUrl, nav, storage }));
    }
    return false;
  }
  try {
    // text/plain なら、CORS の下見（OPTIONS）が要りません。
    const blob = new Blob([body], { type: "text/plain" });
    return Boolean(nav?.sendBeacon?.(`${base}/metrics`, blob));
  } catch {
    return false;
  }
}
