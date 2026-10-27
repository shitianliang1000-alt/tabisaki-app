// カードに実際の写真を載せる。
//
// 「写真 > アイコン > テキスト」という順序でいきたいのですが、収録データ
// （国土数値情報）に写真はありません。ただ、多くのスポットは
// Wikipedia の記事名を持っています。そこから代表画像だけをもらいます。
//
// 使うのは Wikipedia の要約API（`page/summary`）です。キーは要らず、
// CORS も開いていて、返るのは1件ぶんの小さな JSON です。
//
// 大事なのは、**取れないことを失敗として扱わない**ことです。
// 写真はカードの飾りで、旅程の本体ではありません。オフラインでも、
// 記事が無くても、画面はそのまま出ます（art.js の絵のままになります）。
//
// 費用について
// ------------
// Wikipedia は課金されないので quota.js のゲートは通していません。
// そのかわり、取れた／取れなかったの両方を30日ブラウザに保存して、
// 同じ場所を何度も取りに行かないようにしています。

import { requestSignal } from "../packages/core/src/endpoints.js";

const KEY = "tabisaki.photos";
const TTL_MS = 30 * 24 * 3600 * 1000;
const API = "https://ja.wikipedia.org/api/rest_v1/page/summary/";

/** 同時に走る問い合わせの上限。旅程1回で十数件なので、これで足ります。 */
const CONCURRENCY = 4;

function load(storage) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return {};
    const doc = JSON.parse(raw);
    const now = Date.now();
    // 古いものはここで落とします（保存が際限なく膨らまないように）
    for (const [k, v] of Object.entries(doc)) {
      if (!v || now - (v.at ?? 0) > TTL_MS) delete doc[k];
    }
    return doc;
  } catch { return {}; }
}

function save(storage, doc) {
  try { storage?.setItem(KEY, JSON.stringify(doc)); } catch { /* 保存は任意 */ }
}

export function clearPhotoCache(storage = globalThis.localStorage) {
  try { storage?.removeItem(KEY); } catch { /* 消せなくても動きます */ }
}

/**
 * その場所の写真のURL。無ければ null。
 *
 * @param {{id?:string, name?:string, wikipedia?:string}} spot
 * @param {{fetchImpl?:Function, storage?:object, signal?:AbortSignal}} [opts]
 * @returns {Promise<string|null>}
 */
export async function photoFor(spot, opts = {}) {
  const title = String(spot?.wikipedia ?? "").trim();
  if (!title) return null;

  const storage = opts.storage ?? globalThis.localStorage ?? null;
  const doc = load(storage);
  const hit = doc[title];
  // 「無かった」も覚えます。覚えないと、写真の無い場所を開くたびに
  // 同じ問い合わせを繰り返すことになります。
  if (hit) return hit.url ?? null;

  const send = opts.fetchImpl ?? globalThis.fetch;
  let url = null;
  try {
    const res = await send(API + encodeURIComponent(title),
      { headers: { Accept: "application/json" },
        signal: requestSignal(opts.signal, 20_000) });
    if (res?.ok) {
      const data = await res.json();
      url = data?.thumbnail?.source ?? null;
    }
  } catch {
    // 通信できないときは、覚えずに諦めます。次に開いたときは
    // つながっているかもしれません。
    return null;
  }

  doc[title] = { url, at: Date.now() };
  save(storage, doc);
  return url;
}

/**
 * 旅程ぶんをまとめて取ります。
 * 取れなかったものは地図に載りません（キーそのものが入りません）。
 *
 * @returns {Promise<Map<string, string>>} スポットid → 写真URL
 */
export async function photoUrlsFrom(spots, opts = {}) {
  const list = (Array.isArray(spots) ? spots : [])
    .filter((s) => s?.wikipedia);
  const out = new Map();
  let i = 0;

  // 一度に全部投げると、十数件でも Wikipedia に失礼な叩き方になります。
  // 4本ずつ流します。
  async function worker() {
    while (i < list.length) {
      const spot = list[i++];
      const url = await photoFor(spot, opts);
      if (url) out.set(spot.id, url);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) },
                               worker));
  return out;
}

/**
 * 写真の説明ページ（撮った人とライセンスが書いてあるページ）のURL。
 *
 * Wikimedia の写真は、ほとんどが CC BY-SA などで、**撮った人と
 * ライセンスの表示が条件**です。カードに全部は書ききれないので、
 * 写真の隅にこのページへのリンクを置きます（credits.html にも書いています）。
 * 縮小版のURLからファイル名を取り出します。形が違えば null。
 *
 *   …/wikipedia/commons/thumb/a/ab/Foo.jpg/320px-Foo.jpg
 *     → https://commons.wikimedia.org/wiki/File:Foo.jpg
 *   …/wikipedia/ja/a/ab/Foo.jpg（日本語版に直に置かれたもの）
 *     → https://ja.wikipedia.org/wiki/File:Foo.jpg
 */
export function photoPageOf(url) {
  const m = String(url ?? "").match(
    /^https:\/\/upload\.wikimedia\.org\/wikipedia\/(commons|ja)\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/);
  if (!m) return null;
  const host = m[1] === "commons" ? "commons.wikimedia.org" : "ja.wikipedia.org";
  return `https://${host}/wiki/File:${m[2]}`;
}
