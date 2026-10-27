// 点ではないものを、点として案内しない。
//
// 収録のスポットは、どれも「1つの座標」として入っています。お寺や
// 美術館ならそれで足りますが、次の2つは足りません。
//
//   道   山背古道、熊野古道、旧中山道、遊歩道、スカイライン …
//        道には入口と出口があります。座標1つでは、**どこから入って
//        どこへ抜けるのか**が言えません。しかも通り抜ける道では、
//        帰りに乗る場所は入口ではなく**出口の最寄り**です。
//
//   広い場所  舞洲、佐渡島、美ヶ原、十和田湖、国立公園 …
//        座標は代表の1点で、入口ではありません。「舞洲 40分」と
//        書かれても、島のどこへ行くのかが決まっていません。
//
// ■ 収録で分かること・分からないこと
//
// 道らしい名前のスポットは144件あります。そのうち**両端が分かるのは
// 1本だけ**でした（山背古道。13.4km離れた2点として入っています）。
// 残り143本は、道の上のどこか1点しか持っていません。
//
// だから、ここでは経路を組み替えません。組み替えるには道の形が要り、
// 持っていないものを推し量ると「行けない旅程」ができます。
// **持っているものを言い切り、持っていないものは持っていないと言います。**
//
//   両端が分かる  入口と出口、それぞれの最寄りを出します。
//                「歩き通すなら、帰りは□□から」と書きます。
//   1点しかない  「これは道の名前です。収録にあるのは道の上の1点だけで、
//                入口ではありません」と書きます。
//
// ■ 広い場所では、中の行き先を挙げます
//
// 舞洲の中には「舞洲スポーツアイランド」が収録にあります。名前が
// その場所から始まるものを挙げれば、**作り話をせずに**「中のどこへ
// 行くか」を選んでもらえます。

/**
 * 道らしい名前。
 *
 * 「〜道」で終わるものは、都道府県名（北海道）と行政の道路名
 * （国道○号、県道○号）を外します。前者は地方の名前で、後者は
 * 観光の対象ではありません。
 */
const TRAIL_NAME = /古道|街道|峠道|遊歩道|散策路|自然歩道|ウォーキング(コース)?|ハイキングコース|参道|旧道|並木道|小径|プロムナード|スカイライン|ロードパーク|ライン$|坂道|旧中山道|遍路道/;

/** 名前の終わりが「道」だけど、道ではないもの。 */
const NOT_TRAIL = /^北海道|国道|県道|道道|府道|市道|町道|鉄道|水道|書道|茶道|華道|柔道|剣道|報道|北海道立/;

/**
 * 広い場所の分類。
 *
 * 座標が代表の1点になるものです。中のどこへ行くかで、最寄りも
 * かかる時間も変わります。
 */
const WIDE_CATEGORY = new Set([
  "島", "高原", "山", "湖", "半島", "海岸", "湿原", "砂丘", "渓谷",
  "牧場", "スキー場", "海水浴場", "峠", "ダム",
]);

/**
 * 名前からも広い場所と分かるもの。
 *
 * 山地・山脈・湾・海峡・平野・盆地・流域・自然公園を足しました。
 * 収録に「飛騨山脈」「東京湾」「〇〇自然公園」を入れるようになったため
 * です（tools/import_wikipedia_lists.py の WIDE_BY_SUFFIX）。分類だけでは
 * 「自然」や「海岸」に落ちて、広い場所の案内（代表の1点で、入口では
 * ありません）が付きませんでした。
 *
 * 「湾」は語尾だけで見ます（「湾岸」「港湾」などを巻き込まないため）。
 */
const WIDE_NAME = /国立公園|国定公園|自然公園|半島|列島|諸島|高原|湿原|大草原|山地|山脈|山塊|海峡|平野|盆地|台地|流域|水系|湾$/;

/**
 * そのスポットの形。
 *
 * @param {{name?:string, category?:string}} spot
 * @returns {"trail"|"wide"|"point"}
 */
export function shapeOf(spot) {
  const name = String(spot?.name ?? "");
  if (!name) return "point";
  if (!NOT_TRAIL.test(name) && TRAIL_NAME.test(name)) return "trail";
  if (WIDE_NAME.test(name)) return "wide";
  if (WIDE_CATEGORY.has(spot?.category)) return "wide";
  return "point";
}

/** 道の名前から、ゆれを落とした核を取ります。 */
export function trailCore(name) {
  return String(name ?? "")
    .replace(/(ウォーキング|ウォーク|ハイキング|コース|散策|めぐり|入口|入り口|口)$/g, "")
    .trim();
}

/** 2点の距離（km）。 */
function km(a, b) {
  const R = 6371;
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * その道の、収録にある点をぜんぶ集めます。
 *
 * 同じ道が別の名前で入っていることがあります（「山背古道」と
 * 「山背古道ウォーキング」）。核が同じものを1本として扱います。
 *
 * @param {object} spot 道のスポット
 * @param {Array} spots 収録（同じ県ぶんで足ります）
 * @returns {Array} 近い順ではなく、収録の順のまま
 */
export function trailPoints(spot, spots) {
  const core = trailCore(spot?.name);
  if (!core) return [spot];
  const out = [];
  for (const s of spots ?? []) {
    if (!Number.isFinite(s?.lat)) continue;
    if (trailCore(s.name) === core) out.push(s);
  }
  return out.length ? out : [spot];
}

/**
 * 道の入口と出口。
 *
 * **収録に2点以上あるときだけ**返します。1点しか無い道では、どこから
 * 入ってどこへ抜けるのかを言えません（推し量ると、行けない旅程が
 * できます）。
 *
 * 入口は「来る方向にいちばん近い端」、出口は「その反対の端」です。
 *
 * @param {object} spot
 * @param {Array} spots 収録
 * @param {{lat:number,lng:number}|null} from どこから来るか
 * @returns {{entry:object, exit:object, km:number}|null}
 */
export function trailEnds(spot, spots, from = null) {
  const pts = trailPoints(spot, spots);
  if (pts.length < 2) return null;
  // いちばん離れた2点を、道の両端とみなします。
  let a = pts[0];
  let b = pts[1];
  let far = km(a, b);
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const d = km(pts[i], pts[j]);
      if (d > far) { far = d; a = pts[i]; b = pts[j]; }
    }
  }
  // 来る方向に近いほうが入口です。分からなければ収録の順のまま。
  const entry = from && km(b, from) < km(a, from) ? b : a;
  const exit = entry === a ? b : a;
  return { entry, exit, km: Math.round(far * 10) / 10 };
}

/**
 * 定番の広い場所が届く範囲（km）。
 *
 * 琵琶湖は南北に60kmあります。代表の1点（湖のまん中）から6kmでは、
 * 岸のどこにも届きません。定番になるほどの広い場所は、それだけ大きい
 * ものが多いので、まわりのエリアと「中の行き先」を広く取ります
 * （packages/core/src/areas.js の namedSpotAreas も同じ範囲を使います）。
 */
export const WIDE_REACH_KM = 25;

/**
 * 広い場所の中にある、名前のついた行き先。
 *
 * 「舞洲」の中には「舞洲スポーツアイランド」があります。名前がその
 * 場所から始まるものを挙げれば、**作り話をせずに**「中のどこへ行くか」
 * を選んでもらえます。
 *
 * 名前が違うだけの近所は拾いません（「舞洲」から始まらない別の施設を
 * 挙げると、島の中にあるとは限りません）。
 *
 * 定番の広い場所（琵琶湖）は、範囲を WIDE_REACH_KM に広げ、名前を
 * **途中に含む**ものも拾います（「滋賀県立琵琶湖博物館」「奥琵琶湖
 * パークウェイ」）。名前に琵琶湖と入れるのは、琵琶湖のほとりにある
 * ものです。
 *
 * @param {object} spot
 * @param {Array} spots 収録
 * @param {number} [maxKm] この距離までを「中」とみなします
 * @returns {Array} 近い順。多くても5件
 */
export function insideOf(spot, spots, maxKm) {
  const name = String(spot?.name ?? "").trim();
  if (!name || !Number.isFinite(spot?.lat)) return [];
  const major = spot?.fame_tier === "major" && name.length >= 3;
  const reach = maxKm ?? (major ? WIDE_REACH_KM : 6);
  const out = [];
  for (const s of spots ?? []) {
    if (s === spot || s.id === spot.id) continue;
    if (!Number.isFinite(s?.lat)) continue;
    const n = String(s.name ?? "");
    if (n === name) continue;
    if (!(n.startsWith(name) || (major && n.includes(name)))) continue;
    const d = km(spot, s);
    if (d > reach) continue;
    out.push({ spot: s, km: Math.round(d * 10) / 10 });
  }
  out.sort((x, y) => x.km - y.km);
  return out.slice(0, 5);
}

/**
 * 旅程に書き足す案内。
 *
 * 時刻も経路も変えません。**変えるのは説明だけ**です。
 * 道の形も、広い場所の入口も持っていないので、持っていないまま
 * 経路を組み替えると「行けない旅程」ができます。
 *
 * @param {object} itin
 * @param {{spots?:Array, nearestStop?:Function}} opts
 *   nearestStop は非同期で「その地点の最寄りの停留所」を返す関数です
 *   （packages/core/src/stops.js の nearestStop）。渡さなければ、最寄りは書きません。
 * @returns {Promise<number>} 書き足した立ち寄りの数
 */
export async function attachShapes(itin, opts = {}) {
  const spots = opts.spots ?? [];
  let n = 0;
  for (const day of itin?.days ?? []) {
    const items = day?.items ?? [];
    for (const [i, item] of items.entries()) {
      if (item.kind !== "spot" || !item.place) continue;
      const shape = shapeOf(item.place);
      if (shape === "point") continue;

      if (shape === "trail") {
        // どこから来たか。入口を決めるのに使います。
        const prev = items.slice(0, i).reverse()
          .find((x) => x.place ?? x.to)?.place
          ?? items.slice(0, i).reverse().find((x) => x.to)?.to
          ?? null;
        const ends = trailEnds(item.place, spots, prev);
        item.shape = ends
          ? {
            kind: "trail",
            entry: { name: ends.entry.name, lat: ends.entry.lat,
                     lng: ends.entry.lng },
            exit: { name: ends.exit.name, lat: ends.exit.lat,
                    lng: ends.exit.lng },
            km: ends.km,
            entryStop: await stopName(opts, ends.entry),
            exitStop: await stopName(opts, ends.exit),
          }
          : { kind: "trail", entry: null, exit: null, km: 0,
              entryStop: await stopName(opts, item.place), exitStop: null };
        n += 1;
        continue;
      }

      const inside = insideOf(item.place, spots);
      item.shape = {
        kind: "wide",
        inside: inside.map((x) => ({ name: x.spot.name, km: x.km })),
        stop: await stopName(opts, item.place),
      };
      n += 1;
    }
  }
  return n;
}

/** その地点の最寄りの停留所の名前。分からなければ null。 */
async function stopName(opts, at) {
  if (typeof opts.nearestStop !== "function") return null;
  try {
    const s = await opts.nearestStop(at, 6);
    if (!s?.name) return null;
    return { name: s.name, km: Math.round((s.km ?? 0) * 10) / 10 };
  } catch {
    // 停留所が引けなくても、案内そのものは出します。
    return null;
  }
}
