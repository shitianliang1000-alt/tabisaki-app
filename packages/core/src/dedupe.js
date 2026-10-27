// 同じ場所を、2つの場所として並べない。
//
// 収録は3つの出どころを混ぜています（国土数値情報、手作業の収録、
// Wikidata）。同じものが、出どころごとに別の名前で入っています。
//
//   高徳院（鎌倉大仏）      35.3167, 139.5358   手作業の収録
//   鎌倉大仏 高徳院        35.3167, 139.5358   別の出どころ
//
//   観光神楽 高千穂神社     32.70667, 131.30167
//   高千穂神社            32.70667, 131.30167  Wikidata
//
//   舞洲                 34.66422, 135.39514  Wikidata（島）
//   舞洲スポーツアイランド    34.66422, 135.39514  Wikidata（公園）
//
// **座標が1桁も違いません。** それなのに別のスポットとして扱っていた
// ので、旅程に両方入り、「高徳院（鎌倉大仏）40分 → 移動0分 →
// 鎌倉大仏 高徳院 40分」のような並びができます。行った人は、同じ
// 大仏の前に80分立つことになります。
//
// ■ 座標が同じ＝同じ場所、ではない
//
// ここが難しいところです。全国に498組、1,204件の「座標が同じスポット」
// があります。そのなかには
//
//   小樽美術館 | 小樽文学館        同じ建物の、別の施設
//   黒石よされ | 旧正マッコ市      同じ会場の、別の祭り
//
// のように、**本当に別のもの**が含まれます。座標だけで潰すと、
// 行けたはずの場所が消えます。
//
// そこで2段に分けます。
//
//   ① 名前が同じことを言っている → **1つにまとめる**
//      「高徳院（鎌倉大仏）」と「鎌倉大仏 高徳院」は、語を並べ替えた
//      だけです。「高千穂神社」と「観光神楽 高千穂神社」は、片方に
//      飾りが付いているだけです。
//
//   ② 名前が違う → まとめないが、**同じ場所にあると書く**
//      「九重山」と「久住山」は、同じ座標の別名です。どちらが正しいかは
//      こちらでは決められません。決めずに、「同じ場所です」と伝えて
//      読む人に任せます。小樽美術館と小樽文学館なら、それは
//      「同じ建物なので続けて回れます」という役に立つ情報になります。
//
// **決められないことを決めません。** それがこのファイルの方針です。

/** これより近ければ、同じ地点とみなします（度。約11m）。 */
const SAME_POINT_DEG = 0.0001;

/**
 * 名前を、比べられる形にします。
 *
 * ・全角と半角、大文字と小文字をそろえます
 * ・かっこ・中黒・空白・記号を、語の区切りとして落とします
 * ・「市立」「町立」「県立」などの前置きは**残します**
 *   （「市立小樽文学館」と「小樽文学館」は同じものですが、
 *     「県立美術館」と「市立美術館」は別ものです。前置きを落とすと
 *     後者まで同じになってしまうので、落とさずに包含で見ます）
 */
export function normalizeName(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, " ")
    .trim();
}

/** 名前を語に割ります（かっこ・中黒・空白で切ります）。 */
export function tokensOf(name) {
  return normalizeName(name)
    .split(/[()（）「」【】・,、,/／\-–—\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 2つの名前が「同じことを言っている」か。
 *
 * 当てはまるのは、次のどれかです。
 *
 *   ・同じ（正規化して一致）
 *   ・語の集合が同じ（並べ替えただけ）
 *       高徳院（鎌倉大仏） ／ 鎌倉大仏 高徳院
 *   ・片方の語の集合が、もう片方に含まれる（飾りが付いただけ）
 *       高千穂神社 ／ 観光神楽 高千穂神社
 *       舞洲 ／ 舞洲スポーツアイランド …は語が続いているので下の包含で
 *   ・片方の文字列が、もう片方に丸ごと含まれる
 *       小樽文学館 ／ 市立小樽文学館
 *       舞洲 ／ 舞洲スポーツアイランド
 *
 * **短すぎる名前では、包含を使いません。** 「山」が「高尾山」に
 * 含まれるからといって、同じものではありません。
 */
export function sameThing(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (!ta.length || !tb.length) return false;

  // 語の集合が同じ、または片方がもう片方に含まれる。
  const sa = new Set(ta);
  const sb = new Set(tb);
  const subset = (x, y) => [...x].every((t) => y.has(t));
  if (subset(sa, sb) || subset(sb, sa)) return true;

  // 文字列の包含。短い名前では使いません（「山」「駅」「城」のような
  // 1〜2字の名前は、いくらでも別のものに含まれます）。
  const short = na.length < nb.length ? na : nb;
  const long = na.length < nb.length ? nb : na;
  if (short.length >= 3 && long.includes(short)) return true;

  return false;
}

/** 2点が同じ地点か（約11m以内）。 */
export function samePoint(a, b) {
  return Number.isFinite(a?.lat) && Number.isFinite(b?.lat)
    && Math.abs(a.lat - b.lat) < SAME_POINT_DEG
    && Math.abs(a.lng - b.lng) < SAME_POINT_DEG;
}

/**
 * どちらの名前を残すか。
 *
 * 残すのは「読んだ人がいちばん分かるもの」です。
 *
 *   ・手作業で収録したもの（営業時間と料金を持っています）を先に
 *   ・次に、説明のあるもの
 *   ・次に、長いほう（「舞洲」より「舞洲スポーツアイランド」のほうが、
 *     どこへ行くのかが分かります）
 */
export function betterOf(a, b) {
  // まず、名前のかたちで決めます。**長いほうが良い、ではありません。**
  //
  //   「観光神楽 高千穂神社」と「高千穂神社」
  //     長いほうは、神社の名前の**前に**催しの名前が付いています。
  //     残すべきは神社のほうです（催しは毎日あるとは限りません）。
  //
  //   「舞洲」と「舞洲スポーツアイランド」
  //     長いほうは、地名の**後ろに**続いて場所を細かくしています。
  //     残すべきは長いほうです（どこへ行くのかが分かります）。
  //
  // 前に付いたか、後ろに続いたかで決まります。
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  const [shortS, longS] = na.length <= nb.length ? [na, nb] : [nb, na];
  const shortOne = na.length <= nb.length ? a : b;
  const longOne = na.length <= nb.length ? b : a;
  if (shortS !== longS && longS.includes(shortS)) {
    // 前置き（「観光神楽 …」「市立…」）なら、核のほうを残します。
    if (longS.endsWith(shortS)) return shortOne;
    // 後ろに続くなら、細かいほうを残します。
    if (longS.startsWith(shortS)) return longOne;
  }
  // かたちで決まらないときは、持っている情報の多いほうを残します。
  const rank = (s) => (s.source === "external" ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? a : b;
  const hasDesc = (s) => (s.description ? 0 : 1);
  if (hasDesc(a) !== hasDesc(b)) return hasDesc(a) < hasDesc(b) ? a : b;
  return String(a.name ?? "").length >= String(b.name ?? "").length ? a : b;
}

/**
 * 同じ場所を1つにまとめます。
 *
 * まとめるのは「座標が同じ **かつ** 名前が同じことを言っている」ものだけ
 * です。名前が違うものは残します（別のものかもしれないからです）。
 *
 * まとめた側の名前は aka に残します。検索で「鎌倉大仏」と打った人が
 * 「高徳院（鎌倉大仏）」にたどり着けなくなると、直したつもりで壊れます。
 *
 * 持っている情報は**多いほうを残します**。手作業の収録は営業時間と料金を
 * 持ち、Wikidata は説明とリンクを持っています。どちらかを捨てると、
 * まとめたことで情報が減ります。
 *
 * @param {Array} spots
 * @returns {{spots:Array, merged:number}}
 */
export function dedupeSpots(spots) {
  const list = Array.isArray(spots) ? spots : [];
  // 同じ地点のものを集めます（格子で当たりを付けます）。
  const cell = (s) => `${Math.round(s.lat / SAME_POINT_DEG)},`
    + `${Math.round(s.lng / SAME_POINT_DEG)}`;
  const buckets = new Map();
  for (const s of list) {
    if (!Number.isFinite(s?.lat) || !Number.isFinite(s?.lng)) continue;
    const k = cell(s);
    const b = buckets.get(k);
    if (b) b.push(s); else buckets.set(k, [s]);
  }

  const dropped = new Set();
  let merged = 0;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      const a = bucket[i];
      if (dropped.has(a.id)) continue;
      for (let j = i + 1; j < bucket.length; j += 1) {
        const b = bucket[j];
        if (dropped.has(b.id)) continue;
        if (!samePoint(a, b) || !sameThing(a.name, b.name)) continue;
        const keep = betterOf(a, b);
        const gone = keep === a ? b : a;
        absorb(keep, gone);
        dropped.add(gone.id);
        merged += 1;
        if (gone === a) break;   // a が消えたら、a の比較は終わりです
      }
    }
  }
  return { spots: list.filter((s) => !dropped.has(s.id)), merged };
}

/** 消すほうが持っていて、残すほうが持っていないものを移します。 */
function absorb(keep, gone) {
  // 別名。検索でたどり着けなくならないように。
  const aka = new Set(keep.aka ?? []);
  if (gone.name && gone.name !== keep.name) aka.add(gone.name);
  for (const n of gone.aka ?? []) aka.add(n);
  if (aka.size) keep.aka = [...aka];
  // 持っている情報は、多いほうを残します。
  for (const f of ["description", "wikipedia", "wikidata", "url", "tel",
                   "open", "close", "fee", "dwell", "closedDays"]) {
    if (keep[f] === undefined || keep[f] === null || keep[f] === "") {
      if (gone[f] !== undefined && gone[f] !== null && gone[f] !== "") {
        keep[f] = gone[f];
      }
    }
  }
  // 分類は、残すほうを優先しますが、無ければもらいます。
  keep.category ??= gone.category;
  // 知られかたは高いほうに寄せます（まとめたことで無名になると、
  // 「定番と穴場のまぜかた」の割り振りが変わります）。
  if (Number.isFinite(gone.fame_score)
      && gone.fame_score > (keep.fame_score ?? 0)) {
    keep.fame_score = gone.fame_score;
    keep.fame_tier = gone.fame_tier ?? keep.fame_tier;
  }
}

/**
 * まとめなかったけれど、同じ場所にあるもの。
 *
 * 「九重山」と「久住山」は、同じ座標の別名です。どちらが正しいかは
 * こちらでは決められません。**決めずに、同じ場所にあると伝えます。**
 * 小樽美術館と小樽文学館なら、「同じ建物なので続けて回れます」という
 * 役に立つ情報になります。
 *
 * @param {Array} spots 旅程に入っているスポット
 * @returns {Array<Array>} 同じ地点にある2件以上の組
 */
export function coLocated(spots) {
  const list = (Array.isArray(spots) ? spots : [])
    .filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    if (seen.has(i)) continue;
    const group = [list[i]];
    for (let j = i + 1; j < list.length; j += 1) {
      if (seen.has(j)) continue;
      if (!samePoint(list[i], list[j])) continue;
      group.push(list[j]);
      seen.add(j);
    }
    if (group.length > 1) out.push(group);
  }
  return out;
}
