// 停留所（駅・バス停）の位置から、経路APIが届かない区間の
// 「なんとなくの目安」を組み立てるための下ごしらえ。
//
// ここは**計算だけ**です。データを読み、格子に入れ、近い順に返します。
// 呼ぶ側は packages/core/src/stops.js で、そちらが「別のスレッドでやるか、この場で
// やるか」を決めます（停留所のデータは2.6MBあり、読んで解くだけで
// 低スペック端末では画面が固まります。packages/core/src/stops-worker.js）。
//
// なぜ要るか
//   Routes API は、バスしかない区間や登山道では ZERO_RESULTS を返す
//   （packages/core/src/routes.js のコメント参照）。そのとき今までは出発地→目的地の
//   直線距離だけで見積もっていたが、たとえば富士山五合目のように
//   「バス停までは速い公共交通、そこから先は徒歩（登山道）」という
//   区間を、ぜんぶ同じ速さで計算すると大きく外れる。
//   停留所の実位置が分かれば、「最寄り停留所まで徒歩→停留所間は
//   目安の速さ→最寄り停留所から先は徒歩」と分けて見積もれる。
//
// 出典・作成年について（tools/build_stops.py も参照）
//   kb/stops-rail.json … 国土数値情報(鉄道) 2008年度版。全国の駅。
//   kb/stops-bus.json  … 同(バス停留所) 2012年3月時点。登山まわりの
//                         スポットの近くだけを抜き出したもの（全国では
//                         25万件を超え、静的サイトに乗せる大きさではない）。
//   どちらも「今の時刻表」ではなく「だいたいの位置」の目安でしかない。

import { haversineKm } from "./feasibility.js";
import { appUrl } from "./root.js";

const CELL_DEG = 0.05; // 約5.5km四方。半径5〜8km圏内の探索に足りる粗さ。

function cellOf(lat, lng) {
  return `${Math.round(lat / CELL_DEG)},${Math.round(lng / CELL_DEG)}`;
}

function buildGrid(stops) {
  const grid = new Map();
  for (const s of stops) {
    const key = cellOf(s[0], s[1]);
    const list = grid.get(key);
    if (list) list.push(s); else grid.set(key, [s]);
  }
  return grid;
}

async function fetchJson(name) {
  try {
    const url = appUrl(`kb/${name}`);
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // 読めなくても、経路の計算そのものは止めない（直線距離の目安に戻る）。
    return null;
  }
}

async function fetchStops(name) {
  const data = await fetchJson(name);
  return Array.isArray(data?.stops) ? data.stops : [];
}

/**
 * 駅とバス停は、分けて読みます。バス停はさらに、地図のように**タイル**で。
 *
 * 大きさ
 * ------
 *   駅     kb/stops-rail.json   0.3MB（gzip 117KB）
 *   バス停 kb/stops-bus/        2.5MB・65,606件・67タイル（1度四方ごと）
 *
 * これを毎回まとめて読んでいました。出発地の欄に触れただけで 2.6MB です。
 *
 * どう分けたか
 * ------------
 *   ・駅は最初に読みます（名前で引く・座標で引く、どちらにも使います）
 *   ・バス停は**座標で引くとき**、その周りのタイルだけを読みます
 *     （旅程1本が触るのは1〜3枚。50〜300KB）
 *   ・バス停を**名前で引くとき**は、どのタイルか分からないので全部
 *     読みます。駅に当たらない名前を打たれたときだけなので、
 *     めったに起きません
 *
 * 数えたこと
 * ----------
 * 旅程に入りやすいスポット373件のうち、3km圏内に駅があるのは 57%
 * だけです（2駅以上 47%、3駅以上 40%）。**旅程を1本組めば、たいてい
 * 駅の無い立ち寄りが1つは入ります。** だからバス停を「駅で足りない
 * ときだけ」にしても、旅程では結局読むことになります。効くのはタイルで
 * 切るほうです。
 *
 * 答えを変えないこと
 * ------------------
 * 経路の見積もりでは、**頼まれた数に足りなければ必ずバス停まで見ます**
 * （2番目・3番目の候補が Yahoo!の名前解決に効くので、ここを節約すると
 * 時刻が引けなくなります）。節約するのは通信量だけで、答えではありません。
 */

/** 1タイルの大きさ（度）。tools/tile_stops.py と合わせています。 */
const TILE_DEG = 1;

let railPromise = null;      // 駅（最初に1回）
let busIndexPromise = null;  // バス停のタイル索引
let allBusPromise = null;    // バス停を全部（名前で引くときだけ）
const busTiles = new Map();  // タイル名 → Promise
const busGrid = new Map();   // 読んだバス停の位置索引
let busAll = [];             // 読んだバス停（名前の一覧に使います）
let busByName = new Map();

function loadRail() {
  railPromise ??= fetchStops("stops-rail.json").then((rail) => ({
    grid: buildGrid(rail.map((s) => [s[0], s[1], s[2], "rail"])),
    all: rail.map((s) => ({ lat: s[0], lng: s[1], name: s[2], kind: "rail" })),
    byName: nameIndex(rail, "rail"),
  }));
  return railPromise;
}

/**
 * バス停の入れ物を読みます。
 *
 * 古い形（{stops:[...]}）もそのまま読めるようにしてあります。索引に
 * tiles が無ければ、これまでどおり全件として扱います（試験はこの形です）。
 */
function loadBusIndex() {
  busIndexPromise ??= fetchJson("stops-bus.json").then((doc) => {
    if (Array.isArray(doc?.stops)) {
      addBus(doc.stops);
      return { tiles: null };   // 全部そろっています
    }
    return { tiles: Array.isArray(doc?.tiles) ? doc.tiles : [] };
  });
  return busIndexPromise;
}

function addBus(stops) {
  for (const s of stops) {
    const key = cellOf(s[0], s[1]);
    const row = [s[0], s[1], s[2], "bus"];
    const list = busGrid.get(key);
    if (list) list.push(row); else busGrid.set(key, [row]);
    const at = { lat: s[0], lng: s[1], name: s[2], kind: "bus" };
    busAll.push(at);
    const nk = normalizeName(s[2]);
    if (!busByName.has(nk)) busByName.set(nk, at);
  }
}

/** その点の周りにあるタイルを読みます。 */
async function loadBusNear(point, maxKm) {
  const { tiles } = await loadBusIndex();
  if (!tiles) return;                    // 古い形。もう全部あります
  const span = Math.max(0, Math.ceil(maxKm / (TILE_DEG * 111)));
  const want = new Set();
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      want.add(`${Math.floor(point.lat) + dx}_${Math.floor(point.lng) + dy}`);
    }
  }
  const files = tiles.filter((t) => want.has(`${t.lat}_${t.lng}`));
  await Promise.all(files.map((t) => {
    let p = busTiles.get(t.file);
    if (!p) {
      p = fetchStops(t.file).then(addBus);
      busTiles.set(t.file, p);
    }
    return p;
  }));
}

/** バス停を全部読みます（名前で引くときだけ）。 */
function loadAllBus() {
  allBusPromise ??= loadBusIndex().then(async ({ tiles }) => {
    if (!tiles) return;
    await Promise.all(tiles.map((t) => {
      let p = busTiles.get(t.file);
      if (!p) {
        p = fetchStops(t.file).then(addBus);
        busTiles.set(t.file, p);
      }
      return p;
    }));
  });
  return allBusPromise;
}

function nameIndex(stops, kind) {
  const byName = new Map();
  for (const s of stops) {
    const key = normalizeName(s[2]);
    if (!byName.has(key)) {
      byName.set(key, { lat: s[0], lng: s[1], name: s[2], kind });
    }
  }
  return byName;
}

/** 「新宿駅」「 新宿 」を同じ鍵にします。 */
function normalizeName(name) {
  return String(name ?? "").trim().replace(/[\s　]+/g, "").replace(/駅$/, "");
}

/**
 * 先に読み込んでおきます。
 *
 * 停留所のデータは2.7MBあり、最初の1回は数秒かかります。使う直前に
 * 取りにいくと、その数秒ぶん候補が出ません。触れた時点で始めます。
 */
export function preloadStops() {
  // 先に読むのは駅だけです（0.3MB）。バス停は、座標で引くときに
  // その周りのタイルだけを読みます。
  loadRail().catch(() => { /* 読めなくても、直線距離の目安に戻るだけです */ });
}

/**
 * 名前の一致で停留所を1件引きます。駅を優先します。
 * @returns {{lat,lng,name,kind}|null}
 */
export async function findStop(name) {
  const q = normalizeName(name);
  if (!q) return null;
  const rail = await loadRail();
  const hit = rail.byName.get(q) ?? busByName.get(q);
  if (hit) return hit;
  // 駅に無い名前は、バス停かもしれません。名前ではどのタイルか
  // 分からないので、ここでだけ全部読みます。
  await loadAllBus();
  return busByName.get(q) ?? null;
}

/**
 * 入力補完の候補。打たれた文字で始まるものを先に返します。
 * @param {string} query
 * @param {number} limit
 */
export async function searchStops(query, limit = 20) {
  const q = normalizeName(query);
  if (q.length < 1) return [];
  const rail = await loadRail();
  let pool = [...rail.all, ...busAll];
  // 駅の名前に1つも当たらないときだけ、バス停まで見ます。
  // 「松江」と打った人に要るのは松江駅で、松江市内のバス停400件では
  // ありません（打ち込みのたびに全部読むわけにもいきません）。
  if (!pool.some((s) => normalizeName(s.name).includes(q))) {
    await loadAllBus();
    pool = [...rail.all, ...busAll];
  }
  const starts = [];
  const contains = [];
  for (const s of pool) {
    const n = normalizeName(s.name);
    if (n === q || n.startsWith(q)) starts.push(s);
    else if (n.includes(q)) contains.push(s);
    if (starts.length >= limit) break;
  }
  // 同じ名前の停留所は全国にいくつもあります（「本町」など）。
  // 候補としては1つで足ります。
  const seen = new Set();
  const out = [];
  for (const s of [...starts, ...contains]) {
    const key = normalizeName(s.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 最寄りの停留所（駅・バス停）を返します。見つからなければ null。
 * @param {{lat:number,lng:number}} point
 * @param {number} maxKm この距離より遠ければ「無い」扱いにします
 */
export async function nearestStop(point, maxKm = 3) {
  return (await nearbyStops(point, maxKm, 1))[0] ?? null;
}

/**
 * 近い順に、停留所をいくつか返します。
 *
 * 最寄りの1件だけでは足りない場面があります。Yahoo!路線情報は
 * 同じ名前の停留所が全国にあると答えられないことがあり、また出発地と
 * 目的地の最寄りが**同じ停留所**になると、そもそも問い合わせられません
 * （「高尾山口駅から高尾山口駅まで」は経路になりません）。
 * 2番目・3番目の候補があれば、そのどちらかで実際の時刻が引けます。
 *
 * 同じ名前は1件にまとめます（同じ名前で聞き直しても答えは変わりません）。
 * 駅を先に、そのあと近い順です。バス停より駅のほうが、Yahoo!が名前を
 * 解決できる見込みが高いためです。
 *
 * @param {{lat:number,lng:number}} point
 * @param {number} maxKm
 * @param {number} limit
 * @returns {Promise<Array<{lat,lng,name,kind,km}>>}
 */
export async function nearbyStops(point, maxKm = 3, limit = 3) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return [];
  const rail = await loadRail();
  // **バス停のタイルは、いつでも読みます。**
  //
  // ここは「駅が頼まれた数だけ見つかったら、バス停は読まない」という
  // 作りでした。タイルを取りに行く回数を惜しんだのですが、そのせいで
  // **バスの時刻がまったく引けなくなっていました。**
  //
  //   出雲大社の半径5kmには、出雲大社前駅・浜山公園北口駅・遙堪駅が
  //   あります。3件で埋まるので、バス停は1件も読まれません。すると
  //   Yahoo!路線情報へ渡す名前は駅ばかりになり、日御碕や稲佐の浜へ
  //   向かう一畑バスの便は、候補にすら入りませんでした。
  //
  // Yahoo!はバスの時刻をちゃんと返します（出雲大社前→日御碕は
  // 「大社線で出雲大社BTへ、54分待って日御碕線」と、待ち時間まで）。
  // 引けていなかったのは、**聞いていなかった**からです。
  //
  // 取りに行くのは1度四方のタイル1〜3枚（50〜300KB）で、いちど読めば
  // そのまま残ります。旅程1本が触る範囲は狭いので、いつでも読んで
  // 構いません（名前で引くときだけ全国ぶんを読みます。そちらは
  // これまでどおり最後の手です）。
  await loadBusNear(point, maxKm);
  return scan([rail.grid, busGrid], point, maxKm, limit);
}

/** 格子（駅とバス停）から、近い順にいくつか拾います。 */
function scan(grids, point, maxKm, limit) {
  const cx = Math.round(point.lat / CELL_DEG);
  const cy = Math.round(point.lng / CELL_DEG);
  // 見るマスの数は、探す半径から決めます。
  //
  // ここは ±1マス（約5.5km四方）で決め打ちでした。maxKm に 15 を
  // 渡しても、7km先の停留所は**マスの外**なので見つかりません。
  // 呼ぶ側は「15kmまで探した」つもりで、実際は5kmまでです。
  // 地方では駅まで10kmが珍しくなく、そこが丸ごと「停留所なし」に
  // なっていました。
  const span = Math.max(1, Math.ceil(maxKm / (CELL_DEG * 111)));
  const found = [];
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      for (const grid of grids) {
        const list = grid.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;
        for (const s of list) {
          const km = haversineKm(point, { lat: s[0], lng: s[1] });
          if (km <= maxKm) {
            found.push({ lat: s[0], lng: s[1], name: s[2], kind: s[3], km });
          }
        }
      }
    }
  }
  // 並べ方は「近い順」が基本です。ただし、ほぼ同じ距離（0.3km以内）に
  // 駅とバス停があるなら駅を先にします。
  found.sort((a, b) => {
    if (Math.abs(a.km - b.km) > 0.3) return a.km - b.km;
    const rank = (x) => (x.kind === "rail" ? 0 : 1);
    return rank(a) - rank(b) || a.km - b.km;
  });
  const seen = new Set();
  const out = [];
  const take = (s) => {
    const key = normalizeName(s.name);
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(s);
    return true;
  };
  // **駅だけで埋めません。**
  //
  // 近い順に3件取ると、街では3件とも駅になります。ところが
  // 「バスでしか行けない場所」へ向かう区間では、渡すべき名前は
  // バス停です。駅名だけを渡すと、Yahoo!は遠回りの鉄道経路を返すか、
  // 何も返しません（そして画面には「目安」とだけ出ます）。
  //
  // そこで、枠が2つ以上あるときは**1つをバス停のために空けておきます**。
  // 近い順は崩しません（先に近いものを詰め、最後の1枠だけ譲ります）。
  // バス停が無い土地では、これまでどおり駅で埋まります。
  const busReserve = limit >= 2 && found.some((s) => s.kind === "bus") ? 1 : 0;
  for (const s of found) {
    if (out.length >= limit - busReserve) break;
    take(s);
  }
  if (busReserve) {
    for (const s of found) {
      if (out.length >= limit) break;
      if (s.kind === "bus") take(s);
    }
    // バス停が全部同じ名前だった、などで埋まらなければ、近い順で足します。
    for (const s of found) {
      if (out.length >= limit) break;
      take(s);
    }
  }
  return out;
}

/** テスト・診断用に、読み込み状態をリセットします。 */
export function resetStopsCache() {
  railPromise = null;
  busIndexPromise = null;
  allBusPromise = null;
  busTiles.clear();
  busGrid.clear();
  busAll = [];
  busByName = new Map();
}
