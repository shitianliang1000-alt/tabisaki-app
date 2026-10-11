// 知識ベースの読み込みと検索。
//
// 公開された静的 JSON を取ってきて、ベクトル検索（または語句検索）を行います。
// シャード名にビルドIDが入っているため、ブラウザの HTTP キャッシュに任せて
// 問題ありません。独自のキャッシュ層は置きません。

import { KB_INDEX_URL } from "./config.js";
import { drivingAppeal } from "./touring.js";
import { accessAppeal } from "./access.js";
import { genresForCategory } from "./feasibility.js";
import { betterOf, dedupeSpots, samePoint, sameThing } from "./dedupe.js";
import { whyNotASpot } from "./notaspot.js";

/**
 * 同梱データ（js/sample-data.js、約120KB）。
 *
 * 使うのは、公開知識ベースを読めなかったときだけです。静的に import
 * すると、ふだんの起動でも毎回取りに行って読み解くので、要るときに
 * 初めて読みます。圏外でも sw.js が先に入れてあるので読めます。
 */
async function sampleKb() {
  return (await import("./sample-data.js")).SAMPLE_KB;
}

const FAME_SCORE = { major: 82, known: 55, hidden: 26 };

/**
 * 公開知識ベースで省いた項目を補います。
 *
 * 1万件を超えると、エリア名・都道府県名・ジャンルといった「エリアから
 * 決まるもの」を1件ずつ持たせるだけでMB単位になります。ファイルには
 * 入れず、読み込んだここで埋めます。
 */
/**
 * 説明が住所だけのときは、説明として出しません。
 *
 * 収録13,569件のうち9,792件は、説明の欄に住所が入っています。
 *
 *   鹿児島市立美術館（美術館）。城山町4-36
 *   大平山ロープウェイ        大字牟礼138-4
 *
 * カードの説明としては何も言っていません。読んだ人は「この道具は
 * 場所のことを何も知らない」と受け取ります。住所は住所として残し
 * （地図で使えます）、説明は分類と土地から組み立てます。
 */
const ADDRESS_LIKE = /^[^。！？]{0,40}$/;
const ADDRESS_MARK = /[0-9０-９]|丁目|番地|大字|字[ぁ-んァ-ヶ一-龠]/;

export function describeIfAddress(spot) {
  const text = String(spot.description ?? "").trim();
  if (!text) return spot;
  // 文になっていない（句点が無い）うえ、番地や大字を含むなら住所です。
  if (!ADDRESS_LIKE.test(text) || !ADDRESS_MARK.test(text)) return spot;
  spot.address ??= text;
  const where = spot.region || spot.prefecture || "";
  spot.description = where && spot.category
    ? `${where}の${spot.category}`
    : (spot.category || "");
  return spot;
}

/**
 * まとめるほうへ、持っている情報を移します。
 *
 * 手作業の収録は営業時間と料金を持ち、Wikidata は説明とリンクを
 * 持っています。どちらかを捨てると、まとめたことで情報が減ります。
 * 別名も残します（「鎌倉大仏」で探した人がたどり着けなくなると、
 * 直したつもりで壊れます）。
 */
function absorbInto(keep, gone) {
  // **どちらの名前を残すかは、来た順では決めません。**
  //
  // 県ごとに遅れて読むので、どちらが先に来るかはそのときの都合です。
  // 先に来たほうを残すと、「観光神楽 高千穂神社」が残ることがあります
  // （催しの名前が神社の前に付いたものです）。読む人にとって分かる
  // ほうを残します（js/dedupe.js の betterOf）。
  //
  // 入れもの（keep）は索引に載っているので、**入れ替えずに名前だけ**
  // を移します。入れ替えると spotsById が古いほうを指したままになります。
  const names = new Set([keep.name, gone.name].filter(Boolean));
  for (const n of keep.aka ?? []) names.add(n);
  for (const n of gone.aka ?? []) names.add(n);
  const best = betterOf(keep, gone);
  keep.name = best.name;
  names.delete(keep.name);
  if (names.size) keep.aka = [...names];
  for (const f of ["description", "wikipedia", "wikidata", "url", "tel",
                   "open", "close", "fee", "dwell", "closedDays", "category"]) {
    const has = keep[f] !== undefined && keep[f] !== null && keep[f] !== "";
    const theirs = gone[f] !== undefined && gone[f] !== null && gone[f] !== "";
    if (!has && theirs) keep[f] = gone[f];
  }
  if (Number.isFinite(gone.fame_score)
      && gone.fame_score > (keep.fame_score ?? 0)) {
    keep.fame_score = gone.fame_score;
    keep.fame_tier = gone.fame_tier ?? keep.fame_tier;
  }
}

/**
 * 出どころごとの、取り込んだ日。
 *
 * 収録の1件1件には「いつ確かめたか」が書いてありません。けれど、
 * **いつ、どこから取り込んだか**は分かっています（git の履歴に残っている
 * 取り込みの日です）。それを 1件ずつの fetchedAt として渡せば、
 * js/confidence.js が「◯か月前に取得」と言えるようになります。
 *
 * ここに書くのは取り込んだ日であって、現地で確かめた日ではありません。
 * それより新しい日付を作らないこと。データの側に fetchedAt があれば、
 * そちらを優先します（取り込み直したときに書き込めば、それが勝ちます）。
 *
 * 手で入れたもの（src も dataSource も無いもの）は、いつ確かめたかが
 * 分からないので空けておきます。画面には「確認日は不明です」と出ます。
 */
export const FETCHED_ON = {
  kokudo: "2026-09-05",
  opendata: "2026-09-07",
  wikidata: "2026-09-10",
  wikipedia: "2026-09-22",
  "wikipedia-tourlist": "2026-09-30",
  "osm-tourlist": "2026-09-30",
  "overture-tourlist": "2026-09-30",
  "tourlist-geocoded": "2026-10-09",
};
/** シャード単位で出どころが書かれているもの（dataSource）。 */
const FETCHED_ON_DATASOURCE = [
  [/P27/, "2026-09-05"],
];

/** その収録を取り込んだ日（ミリ秒）。分からなければ undefined。 */
export function fetchedAtOf(spot) {
  if (Number.isFinite(spot?.fetchedAt)) return spot.fetchedAt;
  let day = spot?.src ? FETCHED_ON[spot.src] : undefined;
  if (!day && spot?.dataSource) {
    day = FETCHED_ON_DATASOURCE.find(([re]) => re.test(spot.dataSource))?.[1];
  }
  if (!day) return undefined;
  // 日本の日付として読みます。UTC で読むと、前の日に見えることがあります。
  const ms = Date.parse(`${day}T00:00:00+09:00`);
  return Number.isFinite(ms) ? ms : undefined;
}

function hydrate(spot, region) {
  spot.region ??= region?.name ?? "";
  spot.prefecture ??= region?.prefecture ?? "";
  spot.prefectureId ??= spot.regionId;
  spot.country ??= region?.country ?? "日本";
  spot.genres ??= genresForCategory(spot.category);
  describeIfAddress(spot);
  spot.wikipedia ??= spot.name;
  spot.fame_score ??= FAME_SCORE[spot.fame_tier] ?? 50;
  const at = fetchedAtOf(spot);
  if (at !== undefined) spot.fetchedAt = at;
  if (spot.src) {
    // 外部データは営業時間も料金も持っていません。確認済みとは区別します。
    spot.source ??= "external";
    spot.verified ??= false;
  }
  return spot;
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

function index(regions, spots) {
  const regionsById = new Map(regions.map((r) => [r.id, r]));
  const spotsByRegion = new Map();
  const spotsById = new Map();
  for (const s of spots) {
    spotsById.set(s.id, s);
    const list = spotsByRegion.get(s.regionId);
    if (list) list.push(s); else spotsByRegion.set(s.regionId, [s]);
  }
  return { regionsById, spotsByRegion, spotsById };
}

/**
 * 知識ベースを読み込みます。
 * KB_INDEX_URL が未設定なら、同梱のサンプルで動作します（動作確認用）。
 */
/**
 * 索引とエリアだけを先に読みます（約380KB）。
 *
 * 収録は約4MBあります。全部読み終わるまでボタンを押せなくしていたので、
 * 低速な回線では、開いてから最初の操作までがそのぶん遅れていました。
 * 条件を書いているあいだに、後ろで残りを取りに行くほうが速く感じます。
 *
 * ここで返すのは「エリアの一覧」までです。スポットはまだありません。
 */
export async function loadRegionIndex(signal) {
  if (!KB_INDEX_URL) return null;
  const appRoot = new URL("../", import.meta.url);
  const base = new URL(KB_INDEX_URL, appRoot).toString();
  try {
    const manifest = await getJson(base, signal);
    if (!manifest?.shards?.length) return null;
    const regionsDoc = await getJson(
      new URL(manifest.regionsFile, base).toString(), signal);
    return { base, manifest, regions: regionsDoc.regions ?? [] };
  } catch {
    // 読めなければ、下の loadKnowledgeBase が同じことをやり直して
    // 同梱データに落ちます。ここでは黙って諦めます。
    return null;
  }
}

/**
 * @param {Function} [onProgress]
 * @param {AbortSignal} [signal]
 * @param {object} [pre] loadRegionIndex の結果。あれば取り直しません。
 */
export async function loadKnowledgeBase(onProgress, signal, pre = null) {
  if (!KB_INDEX_URL) {
    // 配列を複製してから返します。調べた結果を足す（mergeIntoKb）ときに
    // 同梱データそのものを書き換えてしまうと、読み込み直しても
    // 前回の結果が混ざったままになるためです。
    const SAMPLE_KB = await sampleKb();
    const regions = [...SAMPLE_KB.regions];
    const spots = [...SAMPLE_KB.spots];
    onProgress?.(1, 1, "サンプルデータ");
    return {
      source: "sample",
      manifest: { counts: { regions: regions.length, spots: spots.length } },
      regions, spots, ...index(regions, spots),
      hasVectors: spots.some((s) => s.v),
    };
  }

  // 相対パス（kb/index.json）でも書けるように解決します。
  //
  // 基準はページではなく、**このモジュールの位置**です。
  // ページを基準にすると、admin/index.html のような1階層下の画面から
  // 読んだときに /admin/kb/index.json を取りにいって 404 になり、
  // 黙って同梱データに落ちます（件数だけ 232 になって気づきにくい）。
  // kb/ は js/ と同じ高さにあるので、js/ の1つ上を基準にします。
  const appRoot = new URL("../", import.meta.url);
  const base = new URL(KB_INDEX_URL, appRoot).toString();

  let manifest;
  try {
    manifest = pre?.manifest ?? await getJson(base, signal);
  } catch (e) {
    // 公開知識ベースを読めないときに、真っ白で終わらせない。
    // 同梱データでも旅程は組めるので、そちらに落ちて理由を伝えます。
    const { regions, spots } = await sampleKb();
    onProgress?.(1, 1, "同梱データ");
    return {
      source: "sample",
      loadError: `公開知識ベースを読み込めませんでした（${e.message}）。`
        + "同梱データで動作しています。",
      manifest: { counts: { regions: regions.length, spots: spots.length } },
      regions: [...regions], spots: [...spots],
      ...index([...regions], [...spots]),
      hasVectors: spots.some((s) => s.v),
    };
  }
  if (!manifest?.shards?.length) {
    throw new Error("index.json に shards がありません");
  }
  const total = manifest.shards.length + 1;
  onProgress?.(0, total, "地域データ");

  const regions = pre?.regions ?? (await getJson(
    new URL(manifest.regionsFile, base).toString(), signal)).regions ?? [];

  // シャードは並べて取ります。
  //
  // 1つずつ待っていた頃は、待ち時間が「往復 × シャード数」でした。
  // 手元では気になりませんが、旅行者が使うのは移動中の回線です。
  // 往復200msの回線なら、7枚で1.4秒が待つだけの時間になります。
  let done = 0;
  const docs = await Promise.all(manifest.shards.map(async (shard) => {
    const doc = await getJson(new URL(shard.file, base).toString(), signal);
    onProgress?.(++done, total, `スポット ${done}/${manifest.shards.length}`);
    return doc;
  }));

  const spots = [];
  for (const doc of docs) {
    // 出どころがシャード側にまとめて書かれていることがあります
    // （同じ文字列を全行に書くと、それだけで100KBを超えるため）。
    const from = doc.dataSource;
    for (const spot of doc.spots ?? []) {
      // 宿や町の記事は、行き先として並べません（js/notaspot.js）。
      // 収録からも外してありますが、取り込み直すと戻るので、ここでも見ます。
      if (whyNotASpot(spot)) continue;
      if (from && !spot.dataSource) spot.dataSource = from;
      spots.push(spot);
    }
  }
  onProgress?.(total, total, "完了");

  // まとめてから索引を作ります。**索引を先に作ると、まとめたあとの
  // 件数と合いません**（消したはずの id が spotsById に残ります）。
  const idx0 = index(regions, spots);
  for (const spot of spots) hydrate(spot, idx0.regionsById.get(spot.regionId));
  const { spots: unique, merged } = dedupeSpots(spots);
  const idx = index(regions, unique);
  return {
    source: "remote", manifest, regions, spots: unique, ...idx,
    // まとめた件数。画面の「収録◯件」を、実際に行ける数に合わせます。
    merged,
    // 出典の表示が求められるデータを含みます（国土数値情報など）。
    // 画面から消さないでください。
    attribution: manifest.sources ?? [],
    hasVectors: spots.some((s) => s.v),
  };
}

/**
 * 段を遅れて読むための、スポットが空の知識ベース。
 *
 * なぜこうするか
 * --------------
 * 収録は 29,706件・4.8MB（gzip で約1MB）あります。これを起動時に全部
 * 読んでいました。ところが「島根の旅程」に使うのは島根のぶんだけで、
 * 残り 46 県は読んで、照合して、捨てていました。
 *
 * 行き先の絞り込み（pipeline.js の scope）は、地名から**エリアの一覧**
 * だけで決まります。エリアの一覧は regions.json（gzip で 66KB）にあり、
 * スポットはそのあとで足ります。
 *
 * ここで返すのは入れ物です。中身は ensureRegions / ensureAllSpots が
 * 足していきます。**足りないまま使われても壊れないこと**が条件なので、
 * spots は空配列、索引は空の Map にしておきます（undefined を混ぜると、
 * 読む側のあちこちで落ちます）。
 *
 * @param {object} pre loadRegionIndex の結果
 */
export function stagedKb(pre) {
  if (!pre?.manifest?.shards?.length) return null;
  const regions = pre.regions ?? [];
  const kb = {
    source: "remote",
    staged: true,
    base: pre.base,
    manifest: pre.manifest,
    regions,
    spots: [],
    ...index(regions, []),
    loadedShards: new Set(),
    // ベクトルがあるかどうかは、1枚でも読むまで分かりません。
    // 分からないうちは「無い」として扱います（語での検索に落ちます）。
    hasVectors: false,
    attribution: pre.manifest.sources ?? [],
  };
  return kb;
}

/** その段は、これらのエリアのどれかを含むか。 */
function shardHasRegion(shard, ids) {
  const list = shard.regions;
  if (!list?.length) return true;   // 書いていない段は、分けられません
  return list.some((id) => ids.has(id));
}

/**
 * これらのエリアのスポットが入っている段のファイル名。
 *
 * index.json の段ごとに「どのエリアが入っているか」が書かれています
 * （tools/reshard_kb.py）。書かれていない古い索引では、全部を返します
 * （分けられないので、分けたふりをしません）。
 */
export function shardsForRegions(kb, regionIds) {
  const ids = regionIds instanceof Set ? regionIds : new Set(regionIds ?? []);
  const shards = kb?.manifest?.shards ?? [];
  if (!ids.size) return [];
  return shards.filter((sh) => shardHasRegion(sh, ids)).map((sh) => sh.file);
}

/** まだ読んでいない段を読み、知識ベースに足します。 */
export async function ensureShards(kb, files, opts = {}) {
  if (!kb?.staged) return 0;
  const todo = [...new Set(files)].filter((f) => !kb.loadedShards.has(f));
  if (!todo.length) return 0;

  const base = kb.base;
  let done = 0;
  const total = todo.length;
  opts.onProgress?.(0, total, `スポット 0/${total}`);
  const docs = await Promise.all(todo.map(async (file) => {
    const doc = await getJson(new URL(file, base).toString(), opts.signal);
    opts.onProgress?.(++done, total, `スポット ${done}/${total}`);
    return { file, doc };
  }));

  let added = 0;
  for (const { file, doc } of docs) {
    const from = doc.dataSource;
    const spots = [];
    for (const spot of doc.spots ?? []) {
      if (whyNotASpot(spot)) continue;
      if (from && !spot.dataSource) spot.dataSource = from;
      hydrate(spot, kb.regionsById.get(spot.regionId));
      spots.push(spot);
    }
    added += mergeIntoKb(kb, { spots });
    kb.loadedShards.add(file);
    if (!kb.hasVectors && spots.some((x) => x.v)) kb.hasVectors = true;
  }
  return added;
}

/** これらのエリアのスポットを、読み込み済みにします。 */
export function ensureRegions(kb, regionIds, opts = {}) {
  return ensureShards(kb, shardsForRegions(kb, regionIds), opts);
}

/**
 * 残り全部を読み込みます。
 *
 * 地名の書かれていない希望（「温泉でゆっくり」）では、どの県が候補に
 * なるか分からないので、全部が必要です。**分からないときに勘で絞る**と、
 * 行けたはずの旅先が黙って消えます。
 */
export function ensureAllSpots(kb, opts = {}) {
  return ensureShards(kb, (kb?.manifest?.shards ?? []).map((s) => s.file), opts);
}

/** 読み終わっていない段があるか。 */
export function hasAllShards(kb) {
  if (!kb?.staged) return true;
  return (kb.manifest?.shards ?? []).every((s) => kb.loadedShards.has(s.file));
}

/**
 * 地名の索引（kb/names.json）を読み込みます。
 *
 * 「収録に無い土地」の判定（areas.js の unknownPlaceTerms）は、収録の
 * 名前を全部つないだ文字列への部分一致で行っています。段を遅れて読むと、
 * 読んでいない県の場所が「収録に無い」と判定され、要らない調べものが
 * 走ります。名前だけを別に持っておけば、その判定は段の読み込みと
 * 関係なく正しくなります（gzip で 226KB。**打たれた語に地名らしい
 * ものがあるときだけ**取りにいきます）。
 */
export async function ensureNames(kb, signal) {
  if (!kb?.staged || kb.names !== undefined) return kb?.names ?? null;
  try {
    const doc = await getJson(new URL("names.json", kb.base).toString(), signal);
    kb.names = String(doc?.names ?? "");
  } catch {
    // 取れなければ、読み込み済みのスポットから作ります（areas.js 側）。
    kb.names = null;
  }
  kb.__searchHaystack = undefined;
  return kb.names;
}

/**
 * 調べて得たエリア・スポットを、いま読み込んでいる知識ベースに足します。
 *
 * ファイルには書き戻しません。収録データ（確認済み）と、その場で調べた
 * データ（未確認）は出どころが違うので、混ぜて保存はしない方針です。
 * 同じ地名を続けて調べる負担は discover.js のキャッシュが受け持ちます。
 */
export function mergeIntoKb(kb, { regions = [], spots = [] } = {}) {
  let added = 0;
  for (const r of regions) {
    if (kb.regionsById.has(r.id)) continue;
    kb.regions.push(r);
    kb.regionsById.set(r.id, r);
  }
  kb.spotsByPoint ??= new Map();
  for (const s of spots) {
    if (kb.spotsById.has(s.id)) continue;
    // **同じ場所が、別の名前で2件入っていました。**
    //
    //   高徳院（鎌倉大仏）  35.3167, 139.5358   手作業の収録
    //   鎌倉大仏 高徳院     35.3167, 139.5358   別の出どころ
    //
    // 座標が1桁も違いません。それぞれ別のスポットとして扱っていたので、
    // 旅程に両方入り、「高徳院（鎌倉大仏）40分 → 移動0分 →
    // 鎌倉大仏 高徳院 40分」という並びができます。行った人は、同じ
    // 大仏の前に80分立つことになります。
    //
    // まとめるのは、**座標が同じ かつ 名前が同じことを言っている**もの
    // だけです（js/dedupe.js）。名前が違うもの（小樽美術館と小樽文学館）
    // は残します。同じ建物の別の施設かもしれず、潰すと行けたはずの場所が
    // 消えます。
    const twin = findTwin(kb, s);
    if (twin) {
      absorbInto(twin, s);
      kb.merged = (kb.merged ?? 0) + 1;
      continue;
    }
    kb.spots.push(s);
    kb.spotsById.set(s.id, s);
    addPoint(kb, s);
    const list = kb.spotsByRegion.get(s.regionId);
    if (list) list.push(s); else kb.spotsByRegion.set(s.regionId, [s]);
    added++;
  }
  kb.__searchHaystack = undefined;   // areas.js が持つ照合用の文字列を作り直させる
  return added;
}

/** 地点の格子の鍵。約11m四方です。 */
function pointCell(s) {
  return `${Math.round(s.lat / 0.0001)},${Math.round(s.lng / 0.0001)}`;
}

function addPoint(kb, s) {
  if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lng)) return;
  const k = pointCell(s);
  const list = kb.spotsByPoint.get(k);
  if (list) list.push(s); else kb.spotsByPoint.set(k, [s]);
}

/**
 * すでに入っている、同じ場所の同じもの。
 *
 * 県ごとに遅れて読むので、まとめる相手はあとから来ることも先に来ることも
 * あります。読み込むたびに全件を見比べると重いので、地点の格子で
 * 当たりを付けます。
 */
function findTwin(kb, s) {
  if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lng)) return null;
  // 格子の境目にまたがることがあるので、隣も見ます。
  const cx = Math.round(s.lat / 0.0001);
  const cy = Math.round(s.lng / 0.0001);
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const other of kb.spotsByPoint.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (samePoint(other, s) && sameThing(other.name, s.name)) return other;
      }
    }
  }
  return null;
}

// --- ベクトル検索 -----------------------------------------------------------

/** base64（int8 を +128 したもの）→ Int8Array */
export function decodeVector(b64) {
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) - 128;
  return out;
}

/**
 * 量子化ベクトルとのコサイン類似度。
 * スケールはコサインで打ち消し合うため適用不要です。
 */
export function cosineToQuantized(query, q) {
  const n = Math.min(query.length, q.length);
  let dot = 0, nq = 0, ns = 0;
  for (let i = 0; i < n; i++) {
    dot += query[i] * q[i];
    nq += query[i] * query[i];
    ns += q[i] * q[i];
  }
  if (nq === 0 || ns === 0) return 0;
  return dot / (Math.sqrt(nq) * Math.sqrt(ns));
}

/**
 * 意味検索。hiddenBias が高いほど、知名度の低い場所を押し上げます。
 */
export function searchSpots(kb, queryVector,
                            { limit = 260, hiddenBias = 0, touring = false,
                              companions = [] } = {}) {
  const out = [];
  for (const spot of kb.spots) {
    if (!spot.v) continue;
    const sim = cosineToQuantized(queryVector, decodeVector(spot.v));
    const obscurity = 1 - Math.min(100, Math.max(0, spot.fame_score ?? 50)) / 100;
    out.push({ spot,
      score: sim + hiddenBias * 0.12 * obscurity + touringBonus(spot, touring)
        + accessBonus(spot, companions) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * 車の旅のときだけ足す重み。
 *
 * 峠・岬・展望台・湖畔は前へ、商店街や古い町並みは少し後ろへ。
 * 消してはいけません（車で行けないわけではありません）。**並びを
 * 変えるだけ**です。0.12 は穴場の重みと同じ幅で、希望との一致
 * （0〜1）を覆すほどではありません。
 */
function touringBonus(spot, touring) {
  if (!touring) return 0;
  return (drivingAppeal(spot) - 0.5) * 0.12;
}

/**
 * 同行者がいるときだけ足す重み。
 *
 * ベビーカー・車椅子・歩くのがゆっくりな人がいるなら、石段と登り道を
 * 少し後ろへ。**消してはいけません**（行きたい人はいます。抱えて
 * 上がる人も、一部だけ見る人もいます）。並びを変えるだけです。
 *
 * 幅は車のときと同じ 0.12 にしてあります。希望との一致（0〜1）を
 * 覆すほどではありません。「城が見たい」と書いた人の旅程から、
 * 城が消えてはいけません。
 */
function accessBonus(spot, companions) {
  if (!companions?.length) return 0;
  return (accessAppeal(spot, companions) - 0.5) * 0.12;
}

/**
 * ベクトルが無い知識ベース、または埋め込み失敗時の語句検索。
 *
 * どこに当たったかで重みを変えます。以前は当たった語の数だけを見ていたので、
 * 収録が1万件を超えたとたん、「温泉」で名前に温泉を含む地元の小さな湯が
 * 大量に上位を占め、草津や箱根が消えました。名前に当たったのか、
 * 説明文に当たったのかは、同じ1件ではありません。
 */
const FIELD_WEIGHT = {
  name: 1.0, category: 0.6, genre: 0.5, region: 0.15, description: 0.3,
};

export function searchSpotsByKeyword(kb, keywords,
  { limit = 260, hiddenBias = 0, touring = false, companions = [] } = {}) {
  const terms = (keywords ?? []).map((k) => String(k).trim()).filter(Boolean);
  // 語が無いときは、知名度の高い順に返します。
  //
  // 読み込んだ順の先頭を返していたので、県の並び（北海道から）がそのまま
  // 出ていました。「最長往復切符で旅したい」のように探す語が残らない
  // 希望で、候補が北海道と青森だけになっていました。
  if (!terms.length) {
    return kb.spots
      .map((spot, i) => ({ spot, i, fame: spot.fame_score ?? 50 }))
      .sort((a, b) => b.fame - a.fame || a.i - b.i)
      .slice(0, limit).map(({ spot }) => ({ spot, score: 0.1 }));
  }
  const out = [];
  for (const spot of kb.spots) {
    let score = 0;
    for (const t of terms) {
      if (spot.name.includes(t)) score += FIELD_WEIGHT.name;
      else if ((spot.category ?? "").includes(t)) score += FIELD_WEIGHT.category;
      else if ((spot.genres ?? []).includes(t)) score += FIELD_WEIGHT.genre;
      else if ((spot.description ?? "").includes(t)) score += FIELD_WEIGHT.description;
      else if ((spot.region ?? "").includes(t)
               || (spot.prefecture ?? "").includes(t)) score += FIELD_WEIGHT.region;
    }
    if (!score) continue;
    score /= terms.length;

    // 知名度で伸び縮みさせる。穴場を消さない程度に留めます。
    const fame = Math.min(100, Math.max(0, spot.fame_score ?? 50));
    score *= 0.6 + 0.8 * (fame / 100);

    // 営業時間まで確認できているものを、わずかに優先します。
    if (spot.verified !== false) score *= 1.12;

    const obscurity = 1 - fame / 100;
    out.push({ spot,
      score: score + hiddenBias * 0.12 * obscurity + touringBonus(spot, touring)
        + accessBonus(spot, companions) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * 地域ごとにまとめて順位付け。
 * 上位数件の平均で評価するので、弱い候補を大量に持つ大都市が
 * 数の力で勝つことはありません。
 */
/**
 * 往復して滞在する時間が残るか。
 *
 * これが無いと、東京から片道8時間の旅先が日帰り候補に混ざります。
 * 検索の類似度だけでは「行けるかどうか」は分からないので、
 * 順位付けの前に物理的にふるいます。
 */
export function reachableRegions(regions, { origin, endPlace, totalMinutes,
                                            nights = 0, travelFn,
                                            safetyBufferMin = 15 }) {
  // 終点は出発地とは限りません。片道の旅（東京→名古屋で終了）で
  // 往復を前提に判定すると、行けるはずの旅先が全部落ちます。
  const end = endPlace ?? origin;
  const minStay = nights === 0 ? 90 : 240;
  const kept = [];
  const rejected = [];
  for (const region of regions) {
    const station = { lat: region.stationLat, lng: region.stationLng };
    const oneWay = travelFn(origin, station);
    const toEnd = travelFn(station, end);
    const need = oneWay + toEnd + minStay + safetyBufferMin;
    if (need <= totalMinutes) kept.push({ region, oneWay, toEnd });
    else rejected.push({ region, oneWay, toEnd, need });
  }
  return { kept, rejected };
}

/**
 * 移動時間が旅全体に占める割合から、旅先の効率を評価します。
 *
 * 「往復できる」だけでは良い提案になりません。10時間のうち8時間が移動、
 * 滞在1時間という旅程は、実行可能ではあっても勧めるべきものではない。
 * 移動が全体の 55% を超えたあたりから急に価値が下がる、という形にしています。
 */
export function travelEfficiency(travelMin, totalMinutes) {
  if (!totalMinutes) return 0;
  const share = travelMin / totalMinutes;
  return Math.max(0, 1 - share / 0.55);
}

/**
 * その旅先で、無理なく回れる件数の見積もり。
 *
 * 1か所あたり「滞在70分＋次への移動20分」で見ます。細かく当てる必要は
 * ありません。近い旅先と遠い旅先で、回れる数が何倍違うかが分かれば
 * 順位付けには足ります。
 */
export function fittableSpots(oneWayMin, totalMinutes) {
  const left = totalMinutes - oneWayMin * 2;
  if (left <= 0) return 0;
  return Math.max(0, Math.floor(left / 90));
}

export function rankRegions(kb, matches, topPerRegion = 8, opts = {}) {
  const { oneWayByRegion, totalMinutes, wantedGenres = [], days = 1,
          enjoyTravel = false } = opts;
  const wanted = new Set(wantedGenres);
  const spotsWanted = 5 * Math.max(1, days);   // 1日あたり5か所を目安に
  const byRegion = new Map();
  for (const m of matches) {
    const list = byRegion.get(m.spot.regionId);
    if (list) list.push(m); else byRegion.set(m.spot.regionId, [m]);
  }
  const out = [];
  for (const [regionId, list] of byRegion) {
    const region = kb.regionsById.get(regionId);
    if (!region) continue;
    // 点が並んだら、知られているほうを上にします。
    //
    // 「鎌倉を1日で」のように、地名のほかに希望が書かれていないと、
    // 一致の点はどれも0で並びます。そのまま切ると、上位8件は収録の
    // 順番で決まります。鎌倉では「鎌倉市」のエリアの上位が、科学館・
    // 郷土資料館のように地名で拾われただけの場所になり、知名度の平均で
    // 鶴岡八幡宮・大仏のある「鎌倉」を上回っていました。旅程は
    // 佐助稲荷神社・CIAL鎌倉から始まり、八幡宮も大仏も入りません。
    list.sort((a, b) => (b.score - a.score)
      || ((b.spot.fame_score ?? 50) - (a.spot.fame_score ?? 50)));
    const top = list.slice(0, topPerRegion);

    // 上位の加重和（重みは 1, 0.7, 0.49, … と減衰）。
    //
    // 平均で評価していたときは、強い一致が1件だけの町が、良い一致を3件
    // 持つ町に勝っていました（1件だけだと平均が薄まらないため）。
    // 減衰つきの和なら、件数が増えるほど有利になりつつ、弱い候補を大量に
    // 持つ大都市が数の力だけで勝つこともありません。
    let score = 0;
    let weight = 1;
    for (const m of top) {
      score += m.score * weight;
      weight *= 0.7;
    }

    // 知名度を効かせる。
    //
    // 収録が1万件を超えると、その大半は地元の祭りや小さな史跡です。
    // 一致の点数だけで並べると、「四国」で四国中央市の秋祭りが上位に来ます。
    // 「行ってみたい場所か」を測る手がかりとして、上位スポットの知名度を
    // 見ます（穴場を消さないよう、重みは控えめにします）。
    const fame = top.length
      ? top.reduce((a, m) => a + (m.spot.fame_score ?? 50), 0) / top.length
      : 50;
    score += 1.6 * (fame / 100);

    // 地域そのものの性格を効かせる。スポット単位の一致だけで順位を付けると、
    // 温泉施設が1つある山が、温泉街そのものと同じ扱いになります。
    // 「温泉でゆっくり」の答えは、日帰り湯のある高尾山ではなく箱根や熱海です。
    if (wanted.size) {
      const overlap = (region.genres ?? []).filter((g) => wanted.has(g)).length;
      score += 0.22 * overlap;
    }

    // 日数に対して見どころが足りない旅先は、泊まっても手持ち無沙汰になります。
    // 日帰りなら十分な小さな町でも、2泊3日の行き先としては物足りない。
    const available = kb.spotsByRegion.get(regionId)?.length ?? list.length;
    if (available < spotsWanted) {
      score -= 0.30 * (spotsWanted - available) / spotsWanted;
    }

    if (oneWayByRegion && totalMinutes) {
      const oneWay = oneWayByRegion.get(regionId);
      if (oneWay !== undefined) {
        // 移動の重みは、日帰りと泊まりで変えます。
        //
        // 泊まりなら、初日に3時間かけて行っても翌日以降で取り返せます。
        // 日帰りは取り返せません。往復5時間の旅先を選ぶと、その日は
        // 2〜3か所しか回れず、「行った気がしない」旅程になります。
        // 同じ重みで扱っていたときに、実際にそうなっていました。
        //
        // 移動を楽しみたい人には、逆にします。乗っている時間が旅なので、
        // 遠いことは減点ではありません。旅全体の3割くらいまでは、遠いほど
        // 少しずつ上げます（それ以上は、着いてから何もできなくなります）。
        const weight = days <= 1 ? 0.95 : 0.35;
        score += enjoyTravel
          ? 0.45 * Math.min(1, oneWay / (totalMinutes * 0.3))
          : weight * travelEfficiency(oneWay, totalMinutes);

        // 「その日、実際に何か所まわれるか」を直接点にします。
        // 移動を引いた残り時間を、1か所あたり(滞在+移動)で割った数です。
        // 日帰りではここが体験の量そのものなので、重めに見ます。
        const fitWeight = enjoyTravel ? 0.15 : days <= 1 ? 0.55 : 0.25;
        score += fitWeight * Math.min(1, fittableSpots(oneWay, totalMinutes) / spotsWanted);
      }
    }
    out.push({ region, spots: top, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
