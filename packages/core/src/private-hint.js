// 中継（Cloudflare Worker）にだけ置いた非商用データに、「はい／いいえ」を聞く窓口。
//
// 国土数値情報のバス停（P11）・観光資源（P12）・文化施設（P27）は、複製物を
// 配れないので、サイトにもアプリにも入れていません（docs/private-kb.md）。
// 元データは中継の Workers KV にあり、中継は判定の答え（true/false）しか返しません。
// ここはその答えを聞くだけです。名前や座標は、聞いても返ってきません。
//
// 中継が無い・入れ物がつながっていない・通信が落ちた、のどれでも false を
// 返します。答えが無いときは「無い」と見て、これまでどおりに進みます。

import { endpointFor, requestSignal, usingProxy } from "./endpoints.js";

/** 中継が遅いときに、旅程づくりを待たせない上限。 */
const HINT_TIMEOUT_MS = 5_000;

const cache = new Map();

async function ask(what, body, cfg) {
  if (!usingProxy(cfg) || typeof fetch !== "function") return null;
  const key = `${what}|${JSON.stringify(body)}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    try {
      const res = await fetch(endpointFor(what, {}, cfg), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: requestSignal(null, HINT_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const doc = await res.json();
      return doc && typeof doc === "object" ? doc : null;
    } catch {
      return null;
    }
  })();
  cache.set(key, p);
  const doc = await p;
  // 答えが無かったものは覚えません（次は届くかもしれません）。
  if (!doc) cache.delete(key);
  return doc;
}

/** 座標は 100m 単位に丸めて送ります（同じ場所の聞き直しをまとめ、細かい位置も送りません）。 */
const round = (v) => Math.round(Number(v) * 1000) / 1000;

/**
 * その場所から km 以内にバス停があるか（中継の非商用データで判定）。
 * @param {{lat:number,lng:number}} point
 * @param {number} km
 * @param {{proxyUrl?:string}} cfg
 * @returns {Promise<boolean>}
 */
export async function busStopNear(point, km, cfg) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return false;
  const doc = await ask("stops:near", { lat: round(point.lat), lng: round(point.lng), km }, cfg);
  return doc?.available === true && doc?.within === true;
}

/**
 * その名前の観光資源・文化施設が、その場所の近くに載っているか（名前の裏取り）。
 * @param {string} name
 * @param {{lat:number,lng:number}} point
 * @param {{proxyUrl?:string}} cfg
 * @returns {Promise<boolean|null>} 判定できなければ null
 */
export async function spotListed(name, point, cfg) {
  if (!name || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return null;
  const doc = await ask("spots:check",
    { name: String(name).slice(0, 60), lat: round(point.lat), lng: round(point.lng) }, cfg);
  if (doc?.available !== true) return null;
  return doc.listed === true;
}

/** 試験用。 */
export function resetPrivateHintCache() {
  cache.clear();
}
