// 停留所を引く窓口。
//
// 外から見える形は、これまでとまったく同じです（findStop、searchStops、
// nearestStop、nearbyStops。どれも前から Promise を返していました）。
// 変わったのは、**どこで計算するか**だけです。
//
//   ・別のスレッドが使えるなら、そちらへ回します（packages/core/src/stops-worker.js）
//   ・使えないなら、この場で計算します（packages/core/src/stops-data.js）
//
// なぜ回すのか
// ------------
// 停留所のデータは 2.6MB あります。読んで解くだけで、低スペックの
// 携帯では 400ms ほど画面が止まります。しかも本体側の記憶に 2.6MB が
// 載り続けます。返ってくるのは「最寄りの3件」のような小さな答えなので、
// データを本体側に置いておく理由がありません。
//
// なぜ両方持つのか
// ----------------
// Worker が使えない場でも動かなければなりません。試験は Node で動き、
// file:// で開くこともあります。**使えないときに止まる**より、
// その場で計算するほうがよい、という判断です。
//
// 答えは同じでなければならないので、計算は1か所（stops-data.js）に
// まとめてあります。ここは行き先を決めるだけです。

import { APP_ROOT } from "./root.js";
import * as local from "./stops-data.js";

/** 別のスレッドに回せるか。1回だけ試して、駄目ならこの場で計算します。 */
let worker = null;
let workerBroken = false;
const waiting = new Map();
let nextId = 1;

function ensureWorker() {
  if (worker || workerBroken) return worker;
  // Worker が無い場（Node の試験、古い環境）では、この場で計算します。
  if (typeof Worker !== "function") { workerBroken = true; return null; }
  try {
    worker = new Worker(new URL("packages/core/src/stops-worker.js", APP_ROOT),
                        { type: "module" });
    worker.addEventListener("message", (e) => {
      const { id, ok, value, error } = e.data ?? {};
      const pending = waiting.get(id);
      if (!pending) return;
      waiting.delete(id);
      if (ok) pending.resolve(value); else pending.reject(new Error(error));
    });
    // 立ち上がらなかったとき（読み込み失敗、type:module 非対応）は、
    // 以後この場で計算します。**待っている依頼は投げ直します。**
    // ここで放っておくと、入力補完が永遠に返ってきません。
    worker.addEventListener("error", () => {
      workerBroken = true;
      worker = null;
      for (const [, p] of waiting) p.reject(new Error("worker failed"));
      waiting.clear();
    });
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

/**
 * 別のスレッドに聞きます。駄目ならこの場で計算します。
 *
 * @param {string} op 依頼の種類（stops-worker.js の OPS）
 * @param {object} args
 * @param {Function} fallback この場で計算する手
 */
function ask(op, args, fallback) {
  const w = ensureWorker();
  if (!w) return fallback();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, op, args });
  }).catch(() => fallback());
}

/**
 * 先に読み込んでおきます。
 *
 * 停留所のデータは2.6MBあり、最初の1回は数秒かかります。使う直前に
 * 取りにいくと、その数秒ぶん候補が出ません。触れた時点で始めます。
 */
export function preloadStops() {
  ask("preload", {}, () => { local.preloadStops(); return true; })
    .catch(() => { /* 読めなくても、直線距離の目安に戻るだけです */ });
}

/** 名前の一致で停留所を1件引きます。駅を優先します。 */
export function findStop(name) {
  return ask("find", { name }, () => local.findStop(name));
}

/** 入力補完の候補。打たれた文字で始まるものを先に返します。 */
export function searchStops(query, limit = 20) {
  return ask("search", { query, limit }, () => local.searchStops(query, limit));
}

/** 最寄りの停留所（駅・バス停）を返します。見つからなければ null。 */
export async function nearestStop(point, maxKm = 3) {
  return (await nearbyStops(point, maxKm, 1))[0] ?? null;
}

/** 近い順に、停留所をいくつか返します。 */
export function nearbyStops(point, maxKm = 3, limit = 3) {
  // 座標だけを渡します。スポットの丸ごとを渡すと、受け渡しのたびに
  // 説明文まで複製されます。
  const at = { lat: point?.lat, lng: point?.lng };
  return ask("near", { point: at, maxKm, limit },
             () => local.nearbyStops(at, maxKm, limit));
}

/** テスト・診断用に、読み込み状態をリセットします。 */
export function resetStopsCache() {
  local.resetStopsCache();
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerBroken = false;
  waiting.clear();
}
