// 「着いた」を、押させずに気づく。
//
// 旅行中モードには「『出雲大社』に着いた」というボタンがあります。
// 遅れはここから数えるので、押されないと何も始まりません。ところが
// 当日、人はこれを押しません。着いた瞬間は鳥居を見ていて、
// 携帯の中のボタンのことは忘れています。30分後に思い出して押すと、
// **30分の遅れとして数えられます**（着いた時刻を、押した時刻で
// 代えているためです）。
//
// 端末は自分がどこにいるかを知っています。聞けば済む話です。
//
// ■ 決めごと
//
//   ・**勝手に決めません。** 位置から分かるのは「近くにいる」までで、
//     中に入ったかは分かりません。旅程を書き換えず、「着きましたか？」
//     と出して、押すのは本人にします。
//   ・**精度を見ます。** GPS は屋内や谷あいで数百mずれます。端末が
//     「誤差500m」と言っているのに「着きました」と出すのは、
//     何も見ていないのと同じです。
//   ・**続けて2回**、同じ場所の近くにいたときだけ言います。1回の
//     ずれた測定で「着きました」と出ると、次から信じられなくなります。
//   ・位置は**どこにも送りません**。この判定は端末の中だけで終わります。
//
// ■ 半径をどう決めるか
//
// 「何mまでを着いたとするか」は場所によって違います。神社の境内は
// 200m、駅は50m、国立公園は数km。**収録に広さはありません。**
// だから分類から目安を持ちます（packages/core/src/access.js が足のつらさを分類から
// 持っているのと同じ考えかたです）。それに端末の誤差を足します。

import { haversineKm } from "../packages/core/src/feasibility.js";

/**
 * 分類ごとの「着いたとみなす」半径（m）。
 *
 * 数字の根拠は**そのくらいの広さのものが多い**という目安で、
 * 個別の敷地の形ではありません。だから広めに取りすぎないようにします。
 * 広くすると、隣の場所にいても「着きました」と出ます。
 */
const RADIUS_M = {
  駅: 150, 空港: 800, 港: 400,
  神社: 250, 寺院: 250, 城: 300, 史跡: 250,
  公園: 400, 庭園: 250, 国立公園: 1500, 国定公園: 1200,
  山: 1500, 登山: 1500, 高原: 1500, 湿原: 800, 渓谷: 800,
  海岸: 600, 海水浴場: 400, 湖: 800, 滝: 300,
  町並み: 400, 商店街: 300, 市場: 200,
  温泉: 400, 温泉地: 800,
  博物館: 150, 美術館: 150, 水族館: 200, 動物園: 400,
  テーマパーク: 600, 商業施設: 200, 道の駅: 200,
  展望台: 200, 建築: 150, 教会: 150, 文化施設: 150,
  グルメ: 120, 飲食店: 120, 宿: 150,
};

/** 表に無い分類の半径（m）。 */
const DEFAULT_RADIUS_M = 250;

/**
 * 端末の誤差がこれより大きいときは、何も言いません（m）。
 *
 * 誤差800mの測定で「250m以内なので着きました」と言うのは、
 * 数えているふりです。
 */
export const MAX_ACCURACY_M = 400;

/** 続けて何回、同じ場所の近くにいたら言うか。 */
export const STABLE_FIXES = 2;

/** その予定の、着いたとみなす半径（m）。端末の誤差を足します。 */
export function radiusFor(item, accuracyM = 0) {
  const cat = item?.place?.category ?? (item?.kind === "lodging" ? "宿" : null);
  const base = RADIUS_M[cat] ?? (item?.kind === "meal" ? RADIUS_M.グルメ
    : DEFAULT_RADIUS_M);
  // 誤差を返さない端末もあります。**大きいものとして捨てません**
  //（捨てると、その端末では一度も言わないことになります）。
  const acc = Number(accuracyM);
  return base + (Number.isFinite(acc) ? Math.max(0, acc) : 0);
}

/** その予定の座標。無ければ null。 */
export function pointOf(item) {
  const p = item?.place ?? item?.to ?? null;
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * 「着いた」と言える予定は、どれか。
 *
 * 見るのはその日の**立ち寄り・食事・宿**だけです。移動に「着いた」は
 * ありません（「小町通りへ移動 に着いた」は日本語として通りません）。
 */
export function arrivableItems(itin, now = new Date()) {
  const day = (itin?.days ?? []).find((d) => sameDay(d.date, now))
    ?? itin?.days?.[0];
  return (day?.items ?? []).filter((i) =>
    ["spot", "meal", "lodging"].includes(i.kind) && pointOf(i));
}

function sameDay(a, b) {
  if (!a || !b) return false;
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

/**
 * いまいる場所から、どの予定に着いたと言えるか。
 *
 * @param {{lat:number, lng:number, accuracyM?:number}} here
 * @param {object} itin
 * @param {Date} now
 * @returns {{item:object, km:number, radiusM:number, tooRough?:boolean}|null}
 *   何も言えないときは null。**「分かりません」も返しません**
 *   （画面に出すことが無いので、出さないのと同じです）。
 */
export function arrivedAt(here, itin, now = new Date()) {
  const lat = Number(here?.lat);
  const lng = Number(here?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const acc = Number(here?.accuracyM);
  const accuracyM = Number.isFinite(acc) ? acc : 0;
  // 誤差が大きすぎるときは、何も言いません。
  if (accuracyM > MAX_ACCURACY_M) return null;

  let best = null;
  for (const item of arrivableItems(itin, now)) {
    const p = pointOf(item);
    const km = haversineKm({ lat, lng }, p);
    const radiusM = radiusFor(item, accuracyM);
    if (km * 1000 > radiusM) continue;
    // 同じくらい近いものが2つあるときは、近いほうを採ります
    //（小樽美術館と小樽文学館は同じ建物です。どちらか一方しか
    //  言えませんが、**近いほう**なら説明が付きます）。
    if (!best || km < best.km) best = { item, km, radiusM };
  }
  return best;
}

/**
 * 位置を見張って、着いたら知らせます。
 *
 * **旅程は書き換えません。** 知らせるだけです。押すのは本人です。
 *
 * @param {object} opts
 *   getItinerary … いまの旅程を返す関数（組み直されても追いつけるように）
 *   onArrive     … ({item, km, radiusM}) => void
 *   onDeny       … (reason:string) => void  許可されなかったとき
 *   geolocation  … navigator.geolocation の差し替え（試験用）
 *   now          … () => Date
 * @returns {{stop:()=>void}} 見張りを止める手
 */
export function watchArrival(opts = {}) {
  const geo = opts.geolocation ?? globalThis.navigator?.geolocation ?? null;
  const now = opts.now ?? (() => new Date());
  if (!geo?.watchPosition) {
    opts.onDeny?.("この端末では現在地を使えません");
    return { stop() {} };
  }

  // 続けて同じ予定の近くにいた回数。1回のずれた測定で言わないための数です。
  let lastId = null;
  let streak = 0;
  // 一度知らせたものは、もう知らせません。歩き回るたびに出ると邪魔です。
  const told = new Set();

  const id = geo.watchPosition((pos) => {
    const itin = opts.getItinerary?.();
    if (!itin) return;
    const found = arrivedAt({
      lat: pos?.coords?.latitude,
      lng: pos?.coords?.longitude,
      accuracyM: pos?.coords?.accuracy,
    }, itin, now());
    if (!found) { lastId = null; streak = 0; return; }
    if (found.item.id !== lastId) { lastId = found.item.id; streak = 1; }
    else streak += 1;
    if (streak < STABLE_FIXES || told.has(found.item.id)) return;
    told.add(found.item.id);
    opts.onArrive?.(found);
  }, (err) => {
    // 断られた理由で、言うことが変わります。「使えません」とだけ
    // 書くと、自分が拒否したのだと思われます。
    const why = err?.code === 1
      ? "現在地の利用が許可されていません（ブラウザの設定から変えられます）"
      : err?.code === 3
        ? "現在地を確かめるのに時間がかかっています"
        : "現在地を確かめられませんでした";
    opts.onDeny?.(why);
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });

  return { stop() { try { geo.clearWatch?.(id); } catch { /* 済み */ } } };
}
