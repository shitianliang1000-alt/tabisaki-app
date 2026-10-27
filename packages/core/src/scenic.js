// 移動そのものを、旅の一部にする。
//
// これまで移動は「目的地と目的地のあいだの時間」でした。所要時間と
// 乗換回数は出ますが、**その道が、その路線が、どんなところを走るのか**
// はどこにも出ません。
//
//   ・車で来ている人は、走ること自体を目的にしています。同じ2時間なら、
//     峠と海沿いを抜ける2時間のほうがよい。
//   ・電車でも同じです。五能線の日本海沿いは、乗ることが目的になります。
//
// ここは2つに分かれます。**確かさが違うので、分けます。**
//
//   路線（公共交通）  Yahoo!路線情報が**実際の路線名**を返します。
//                     「一畑電車北松江線」と書いてあるなら、その路線に
//                     乗ります。推し量りは要りません。
//
//   道（車）          どの道を通るかは分かりません。分かるのは
//                     「この区間の近くに、名前のある道がある」ことだけ
//                     です。だから**寄り道の候補**として出し、
//                     経路に混ぜません。
//
// 書かないこと
// ------------
// ・通れるかどうか（冬期閉鎖・災害通行止め・工事）。毎年変わります。
//   閉まる道には「いつ閉まりやすいか」だけを書き、確かめ先へ渡します。
// ・走行時間や料金。実際の経路を引いていないので出せません。
// ・「絶景です」という評価。名前のある道であることと、何が見えるかを
//   書くだけにします。

/**
 * 名前のある道（車）。
 *
 * 座標は、その道のだいたいの位置です（端と真ん中を数点）。旅程の区間が
 * この近くを通るかどうかを見るためだけに使うので、道のりの形そのもの
 * ではありません。**この点を結んで経路にはしません。**
 *
 * closed は「閉まりやすい時期」です。年ごとに変わるので、月だけを
 * 書いて、確かめるよう添えます。
 */
export const SCENIC_ROADS = [
  { name: "知床横断道路", pref: "北海道",
    what: "知床連山を越えて、ウトロと羅臼を結びます。峠から国後島が見えます",
    closed: [11, 12, 1, 2, 3, 4],
    at: [{ lat: 44.0680, lng: 145.0430 }, { lat: 44.1020, lng: 145.1150 }] },
  { name: "宗谷サンセットロード（道道106号）", pref: "北海道",
    what: "稚内から利尻富士を正面に見ながら、電柱の無い直線が続きます",
    at: [{ lat: 45.2500, lng: 141.7000 }, { lat: 44.9500, lng: 141.6500 }] },
  { name: "磐梯吾妻スカイライン", pref: "福島県",
    what: "吾妻連峰の火山地帯を抜けます。浄土平の荒々しい景色が見どころです",
    closed: [11, 12, 1, 2, 3],
    at: [{ lat: 37.7300, lng: 140.2800 }, { lat: 37.7000, lng: 140.2450 }] },
  { name: "ビーナスライン", pref: "長野県",
    what: "霧ヶ峰から美ヶ原へ。高原の草原と、晴れていれば八ヶ岳と北アルプス",
    closed: [12, 1, 2, 3],
    at: [{ lat: 36.1000, lng: 138.1900 }, { lat: 36.2300, lng: 138.1100 }] },
  { name: "志賀草津道路（国道292号）", pref: "群馬県・長野県",
    what: "国道の最高地点（2,172m）を通ります。白根山の火山地形が続きます",
    closed: [11, 12, 1, 2, 3, 4],
    at: [{ lat: 36.6400, lng: 138.5300 }, { lat: 36.6200, lng: 138.5800 }] },
  { name: "伊豆スカイライン", pref: "静岡県",
    what: "伊豆半島の尾根を走ります。富士山と駿河湾を交互に見ながら進みます",
    at: [{ lat: 35.0800, lng: 139.0200 }, { lat: 34.9200, lng: 139.0300 }] },
  { name: "乗鞍エコーライン", pref: "長野県・岐阜県",
    what: "標高2,700mまで上がります（マイカー規制あり。時期と方法をご確認ください）",
    closed: [11, 12, 1, 2, 3, 4, 5],
    at: [{ lat: 36.1100, lng: 137.5500 }, { lat: 36.1400, lng: 137.5800 }] },
  { name: "越前海岸（国道305号）", pref: "福井県",
    what: "日本海の断崖と岩場が続きます。夕日の時間帯がよく知られています",
    at: [{ lat: 36.0300, lng: 135.9500 }, { lat: 35.8500, lng: 136.0500 }] },
  { name: "伊勢志摩パールロード", pref: "三重県",
    what: "リアス海岸を見下ろしながら、鳥羽と志摩を結びます",
    at: [{ lat: 34.4700, lng: 136.8600 }, { lat: 34.3300, lng: 136.8800 }] },
  { name: "瀬戸内しまなみ海道", pref: "広島県・愛媛県",
    what: "6つの島を7つの橋で渡ります。自転車でも渡れる橋として知られています",
    at: [{ lat: 34.4000, lng: 133.2000 }, { lat: 34.1000, lng: 133.0000 },
         { lat: 34.0700, lng: 132.9900 }] },
  { name: "角島大橋", pref: "山口県",
    what: "エメラルドグリーンの海の上を、1,780mの橋で渡ります",
    at: [{ lat: 34.3500, lng: 130.8800 }] },
  { name: "四国カルスト（県道383号）", pref: "愛媛県・高知県",
    what: "標高1,400mの草原に石灰岩が点在します。牛が放牧されています",
    closed: [12, 1, 2, 3],
    at: [{ lat: 33.4700, lng: 132.9000 }, { lat: 33.4500, lng: 133.0300 }] },
  { name: "やまなみハイウェイ", pref: "大分県・熊本県",
    what: "阿蘇と九重をつなぎます。草原とカルデラの縁を走ります",
    at: [{ lat: 33.1000, lng: 131.2000 }, { lat: 32.9000, lng: 131.1000 }] },
  { name: "阿蘇パノラマライン", pref: "熊本県",
    what: "外輪山の内側からカルデラへ。草千里と中岳の火口が見どころです",
    at: [{ lat: 32.8900, lng: 131.0600 }] },
  { name: "日南海岸ロードパーク（国道220号）", pref: "宮崎県",
    what: "亜熱帯の植物と、洗濯板のような岩（鬼の洗濯板）が続きます",
    at: [{ lat: 31.7500, lng: 131.4700 }, { lat: 31.5500, lng: 131.4000 }] },
];

/**
 * 名前のある路線（公共交通）。
 *
 * **ここは推し量りません。** Yahoo!路線情報が返す区間の路線名に、この
 * 名前が含まれていたら、その路線に乗ります。
 *
 * match は路線名に当てる言葉です。Yahoo!の表記ゆれ（「ＪＲ五能線」
 * 「五能線」）に当たるよう、短く取ります。
 */
export const SCENIC_LINES = [
  { name: "五能線", match: /五能線/,
    what: "日本海のすぐそばを走ります。冬は波が線路まで来ます" },
  { name: "只見線", match: /只見線/,
    what: "第一只見川橋梁など、川を何度も渡ります" },
  { name: "三陸鉄道", match: /三陸鉄道/,
    what: "リアス海岸を高いところから見下ろす区間があります" },
  { name: "小海線", match: /小海線/,
    what: "JR最高地点（1,375m）を通ります。八ヶ岳の裾を回ります" },
  { name: "大井川鐵道", match: /大井川鐵道|大井川鉄道/,
    what: "大井川に沿って上ります（SLは運転日が限られます）" },
  { name: "黒部峡谷鉄道", match: /黒部峡谷/,
    what: "トロッコで峡谷を上ります（冬期運休）" },
  { name: "嵯峨野観光鉄道", match: /嵯峨野観光|トロッコ嵯峨|保津川/,
    what: "保津峡に沿って走ります（運転日にご注意ください）" },
  { name: "予讃線（愛ある伊予灘線）", match: /予讃線/,
    what: "下灘駅など、伊予灘を正面に見る区間があります" },
  { name: "山陰本線", match: /山陰本線/,
    what: "日本海に沿う区間が長く、餘部橋梁などを通ります" },
  { name: "肥薩線", match: /肥薩線/,
    what: "ループ線とスイッチバックで山を越えます（区間により運休あり）" },
  { name: "日豊本線", match: /日豊本線/,
    what: "日向灘に沿う区間があります" },
  { name: "根室本線", match: /根室本線|花咲線/,
    what: "湿原と海岸を抜けます。落石海岸の区間が知られています" },
  { name: "釧網本線", match: /釧網本線/,
    what: "釧路湿原とオホーツク海を、1本で結びます" },
  { name: "由比ヶ浜・江ノ電", match: /江ノ島電鉄|江ノ電/,
    what: "鎌倉高校前など、海のすぐ前を通ります" },
  { name: "南阿蘇鉄道", match: /南阿蘇鉄道/,
    what: "阿蘇のカルデラの中を走ります" },
  { name: "由布院・久大本線", match: /久大本線/,
    what: "由布岳を見ながら走ります" },
  { name: "富良野線", match: /富良野線/,
    what: "丘のあいだを抜けます（花の時期は限られます）" },
  { name: "氷見線", match: /氷見線/,
    what: "富山湾ごしに立山連峰が見える区間があります" },
  { name: "紀勢本線", match: /紀勢本線/,
    what: "熊野灘に沿う区間があります" },
  { name: "内房線・外房線", match: /内房線|外房線/,
    what: "房総の海沿いを走る区間があります" },
];

/** 2点の距離（km）。ここでしか使わないので、持っておきます。 */
function km(a, b) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** その道が、a と b のどちらかから何km以内にあるか（いちばん近い点）。 */
function nearestKm(road, a, b) {
  let best = Infinity;
  for (const p of road.at) {
    best = Math.min(best, km(p, a), km(p, b));
  }
  return best;
}

/**
 * その区間で寄れそうな、名前のある道。
 *
 * **経路には混ぜません。** 実際にその道を通るかどうかは分からないので、
 * 「この辺りにこういう道があります」と言うだけです。判断は本人に
 * 任せます。
 *
 * @param {{lat:number,lng:number}} a 区間の出発
 * @param {{lat:number,lng:number}} b 区間の到着
 * @param {{month?:number, maxKm?:number}} [opts]
 *   month は出かける月（1〜12）。閉まりやすい時期なら、そう書きます。
 * @returns {Array<{name:string, what:string, note:string, km:number}>}
 */
export function roadsNear(a, b, opts = {}) {
  if (!Number.isFinite(a?.lat) || !Number.isFinite(b?.lat)) return [];
  // 区間そのものが短いなら、寄り道の話はしません（街なかの移動です）。
  const legKm = km(a, b);
  if (legKm < 8) return [];
  // 寄り道として成り立つ範囲。区間の長さに合わせて広げますが、
  // 上限は置きます（300km 先の道を「寄れます」とは言えません）。
  const reach = Math.min(40, Math.max(15, legKm * 0.6));
  const month = Number.isFinite(opts.month) ? opts.month : null;
  const out = [];
  for (const road of SCENIC_ROADS) {
    const d = nearestKm(road, a, b);
    if (d > (opts.maxKm ?? reach)) continue;
    // 閉まりやすい時期かどうか。**閉まっているとは言いません**
    // （年ごとに変わります）。確かめるよう添えます。
    const shut = month && road.closed?.includes(month);
    out.push({
      name: road.name,
      what: road.what,
      km: Math.round(d),
      note: shut
        ? "この時期は冬期閉鎖のことが多い道です。出発前に道路管理者の"
          + "発表をご確認ください。"
        : "",
    });
  }
  out.sort((x, y) => x.km - y.km);
  // 1区間に3つも4つも並べると、どれも読まれません。
  return out.slice(0, 2);
}

/**
 * その区間で乗る路線が、名前のある路線か。
 *
 * **推し量りません。** 調べた結果の路線名に当てるだけです。
 *
 * @param {string} line 区間の路線名（Yahoo!が返したもの）
 * @returns {{name:string, what:string}|null}
 */
export function scenicLine(line) {
  const s = String(line ?? "");
  if (!s) return null;
  for (const item of SCENIC_LINES) {
    if (item.match.test(s)) return { name: item.name, what: item.what };
  }
  return null;
}

/**
 * 旅程に、移動の楽しみを書き足します。
 *
 * 時刻も費用も経路も変えません。変えるのは**説明だけ**です。
 *
 * @param {object} itin buildItinerary の結果
 * @param {{transport?:string}} [opts]
 * @returns {number} 書き足した区間の数
 */
export function attachScenic(itin, opts = {}) {
  let n = 0;
  const byCar = opts.transport === "car" || opts.transport === "transit+car"
    || opts.transport === "air+car";
  for (const day of itin?.days ?? []) {
    const month = new Date(day.date).getMonth() + 1;
    for (const item of day.items ?? []) {
      if (item.kind !== "transit" || item.walk) continue;

      // ① 乗る路線が分かっているなら、そちらが先です（確かなので）。
      const line = scenicLine(item.detail ?? item.line ?? "");
      if (line) {
        item.scenic = { kind: "line", name: line.name, what: line.what };
        n += 1;
        continue;
      }

      // ② 車の区間なら、近くの名前のある道を候補として出します。
      const drive = item.drive === true || (byCar && item.taxi !== true);
      if (!drive || !item.from || !item.to) continue;
      const roads = roadsNear(item.from, item.to, { month });
      if (!roads.length) continue;
      item.scenic = { kind: "road", roads };
      n += 1;
    }
  }
  return n;
}
