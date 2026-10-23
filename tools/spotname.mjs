// 収録の名前に残った、出どころの書きかたを落とす。
//
// 収録は、出どころの違う一覧を継ぎ足して作っています。名前に、その
// 一覧の都合の書きかたが残っていて、ページにそのまま出ていました。
//
//   りんご並木 (飯田市)            Wikipedia の記事名。同じ名前の記事と
//   加茂神社 (長野市鬼無里)        分けるためのかっこです
//   小田原市 江之浦海水浴場        観光の一覧が、市町村ごとの表を1つに
//                                  まとめたときに付けた市の名前
//   市営江之浦海水浴場（海水浴場） 分類を名前の後ろに書き足したもの
//
// 読む人には、どれも名前の一部に見えます。同じ浜が「小田原市 江之浦
// 海水浴場」と「市営江之浦海水浴場」の2件に見えるのも、このせいです。
//
// ■ 落とさないもの
//
//   ・かっこの中が名前の続き（三内丸山遺跡(縄文時遊館)、白山温泉(永井旅館)）
//   ・「休館中」のような、行く前に知りたいこと
//   ・市町村ではない「〇〇村」「〇〇市」（いこいの村、七街道風土市、
//     太秦映画村）
//   ・市町村を落とすと何か分からなくなるもの（渋川市 総合公園）は、
//     空白を詰めて「渋川市総合公園」にします
//   ・自然歩道の区間（吉野町 入野 ~ 吉野町 平尾）
//   ・かっこを落とすと2字以下になる記事名（本町 (室蘭市)）は、
//     落とさずに「室蘭市本町」と前に付けます
//
//   ・直すと、近く（同じエリア・5km 以内）の別の場所と同じ名前になるもの。
//     「氷川神社 (港区元麻布)」のかっこは、同じ区の5つの氷川神社を分けて
//     います。落とすと、旅程にも一覧にも同じ名前が並びます（cleanAll）
//
// 書き戻すのは tools/clean_names.mjs です。元の名前は listedAs に残し、
// Wikipedia の記事名だったものは wikipedia に移します（写真を引くのに使います）。

/** Wikipedia の曖昧さ回避: 「名前 (説明)」。半角かっこの前に空白があります。 */
const DISAMBIG = /^(.+?)[\s　]+\(([^()（）]+)\)$/;

/** 名前の後ろのかっこ（全角・半角）。 */
const TAIL_PAREN = /^(.+?)[\s　]*[（(]([^()（）]+)[）)]$/;

/** 1つの市町村の名前（「新得町・上士幌町」「北海道十勝支庁」は含みません）。 */
const ONE_MUNICIPALITY = /^[^\s・、,]+?[市町村区]$/u;

/** 前に付いた市町村の名前: 漢字1〜4字＋市・町・村、空白で区切られたもの。 */
const MUNICIPALITY_PREFIX = /^([\p{Script=Han}ヶケ]{1,4}[市町村])[\s　]+(.+)$/u;

/**
 * 市町村のように見えて、名前の一部のもの。
 *   金屋町 千本格子の家並み  高岡市の町の名前（その町並みの名前です）
 *   太秦映画村 …            映画村の中の施設
 *   龍神村 Dragon Museum    村を落とすと英語の名前だけになります
 *   青空市 ぶなの里          市場の名前
 */
const NOT_MUNICIPALITY = new Set(["金屋町", "太秦映画村", "龍神村", "青空市"]);

/**
 * 市町村を落とすと、どこの何か分からなくなる名前。落とさずに、空白を
 * 詰めて1つの名前にします（「渋川市 総合公園」→「渋川市総合公園」）。
 */
const GENERIC_REST = /^(総合|郷土|文化財|スポーツ|市民|歴史|民俗|まちなか|海辺|国道|観光)/;

/**
 * 読む人に見せる名前。直すところが無ければ、そのまま返します。
 *
 * @param {string} name
 */
export function cleanSpotName(name) {
  let out = String(name ?? "").trim();
  if (!out) return out;

  // 1. 名前の終わりと同じことを言うかっこ（分類を書き足したもの）。
  //    市営江之浦海水浴場（海水浴場） ／ 古牧温泉(温泉)
  //    かっこの中が名前の終わりと違うもの（信州新町(美術館)）は、
  //    かっこのほうが行き先なので残します。
  const tail = TAIL_PAREN.exec(out);
  if (tail && tail[1].trim().length > tail[2].length && tail[1].trim().endsWith(tail[2])) {
    out = tail[1].trim();
  }

  // 2. Wikipedia の曖昧さ回避。
  const dis = DISAMBIG.exec(out);
  if (dis) {
    const [, base, qualifier] = dis;
    const b = base.trim();
    if (b.length >= 3) out = b;
    else if (ONE_MUNICIPALITY.test(qualifier)) out = `${qualifier}${b}`;
    else if (b.length >= 2) out = b;
  }

  // 3. 前に付いた市町村の名前。
  const pre = MUNICIPALITY_PREFIX.exec(out);
  if (pre) {
    const [, place, rest] = pre;
    const r = rest.trim();
    if (!NOT_MUNICIPALITY.has(place) && r.length >= 3 && !/[~〜～]/.test(r)) {
      out = GENERIC_REST.test(r) ? `${place}${r}` : r;
    }
  }
  return out;
}

/**
 * 収録の1件の名前を直します（書き換えます）。直したら true。
 * 元の名前は listedAs に、Wikipedia の記事名だったものは wikipedia に残します。
 */
export function cleanSpot(spot) {
  if (!spot?.name) return false;
  const next = cleanSpotName(spot.name);
  if (next === spot.name) return false;
  const was = spot.name;
  // 読み込み（js/kb.js）は wikipedia が無ければ名前を記事名に使います。
  // 曖昧さ回避のかっこは記事名そのものなので、落とす前に移します。
  if (!spot.wikipedia && DISAMBIG.test(was) && /^wiki/.test(String(spot.src ?? ""))) {
    spot.wikipedia = was;
  }
  spot.listedAs ??= was;
  spot.name = next;
  return true;
}

/** 名前を比べる形（tests/kb-data.test.js・tools/dedupe_spots.py と同じ見かた）。 */
function nameParts(name) {
  const clean = (t) => t.normalize("NFKC")
    .replace(/[\s　・､,、\-−―/／]/g, "")
    .replace(/(市|町|村|区|県|都|府|道|国)立/g, "$1");
  const m = /[（(](.+?)[)）]/.exec(name);
  return {
    full: clean(name),
    base: clean(name.replace(/[（(].*?[)）]/g, "")),
    paren: m ? clean(m[1]) : null,
  };
}

/** 2つの名前が同じ場所を言っているように読めるか（括弧の中の別名・括弧を除いた名前）。 */
function readsSame(a, b) {
  const x = nameParts(a);
  const y = nameParts(b);
  if (x.full === y.full) return true;
  if ((x.paren && x.paren === y.full) || (y.paren && y.paren === x.full)) return true;
  if (x.paren && !y.paren && x.base === y.full) return true;
  if (y.paren && !x.paren && y.base === x.full) return true;
  return false;
}

function km(a, b) {
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return Infinity;
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  return 6371 * Math.hypot(x, (b.lat - a.lat) * rad);
}

/** 近くで、同じ名前・同じ場所と読める名前になってしまうか。 */
function collides(s, name, o, oName) {
  if (s.regionId && s.regionId === o.regionId && name === oName) return true;
  const d = km(s, o);
  if (d < 5 && name === oName) return true;
  return d <= 2 && readsSame(name, oName);
}

/** これより近く、直した名前が同じなら、同じ場所の2件です（km）。 */
const TWIN_KM = 0.1;

/**
 * 直した名前が同じで、座標もほぼ同じ2件（Wikidata と Wikipedia から1件ずつ
 * 入ったもの）。「厳島神社 (横浜市中区)」と「厳島神社 (横浜市中区羽衣町)」は
 * 同じ座標の同じ神社です。かっこの書きかたが違うだけで、二重に入っていました。
 * 説明を持つほう（無ければ Wikipedia の記事名を持つほう）を残します。
 *
 * @returns {Set<object>} 外すもの
 */
export function sameNamedTwins(spots) {
  const byName = new Map();
  for (const s of spots) {
    if (!s?.name) continue;
    const n = cleanSpotName(s.name);
    (byName.get(n) ?? byName.set(n, []).get(n)).push(s);
  }
  const rank = (s) => (s.description ? 2 : 0) + (s.wikipedia ? 1 : 0);
  const drop = new Set();
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (drop.has(a) || drop.has(b) || a.name === b.name || km(a, b) > TWIN_KM) continue;
        // 名前を直すものどうし（どちらも出どころの書きかたが残っているもの）だけ。
        if (cleanSpotName(a.name) === a.name || cleanSpotName(b.name) === b.name) continue;
        drop.add(rank(a) >= rank(b) ? b : a);
      }
    }
  }
  return drop;
}

/**
 * 収録ぜんたいについて、直してよい名前を決めます。
 *
 * 直すと近くの別の場所と同じ名前（または同じ場所と読める名前）になるものは
 * 直しません。1つ戻すと別のものがぶつからなくなることがあるので、
 * 動かなくなるまで繰り返します。
 *
 * @param {Array<{name:string, regionId?:string, lat?:number, lng?:number}>} spots
 * @returns {Map<object, string>} 直すもの → 新しい名前
 */
export function cleanAll(spots) {
  const next = new Map();
  for (const s of spots) {
    if (!s?.name) continue;
    const n = cleanSpotName(s.name);
    if (n !== s.name) next.set(s, n);
  }
  const nameOf = (s) => next.get(s) ?? s.name;
  // 近くを探す升（約 5.5km）。
  const cell = (s) => `${Math.round(s.lat / 0.05)},${Math.round(s.lng / 0.05)}`;
  const grid = new Map();
  const byRegion = new Map();
  for (const s of spots) {
    if (Number.isFinite(s?.lat) && Number.isFinite(s?.lng)) {
      const k = cell(s);
      (grid.get(k) ?? grid.set(k, []).get(k)).push(s);
    }
    if (s?.regionId) (byRegion.get(s.regionId) ?? byRegion.set(s.regionId, []).get(s.regionId)).push(s);
  }
  const neighbors = (s) => {
    const out = new Set(byRegion.get(s.regionId) ?? []);
    if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) {
      const gx = Math.round(s.lat / 0.05);
      const gy = Math.round(s.lng / 0.05);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const o of grid.get(`${gx + dx},${gy + dy}`) ?? []) out.add(o);
        }
      }
    }
    out.delete(s);
    return out;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [s, n] of [...next]) {
      for (const o of neighbors(s)) {
        if (collides(s, n, o, nameOf(o))) {
          next.delete(s);
          changed = true;
          break;
        }
      }
    }
  }
  return next;
}
