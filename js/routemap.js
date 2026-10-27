// 圏外でも見られる、順路の図。
//
// 地図（js/map.js）はタイルを読みます。読めないところでは、いま一文が
// 出るだけです。
//
//   「地図を読み込めませんでした（インターネット接続を確認してください）。」
//
// 正しいのですが、**いちばん地図が要るときに出る一文**です。山の中、
// 島、地下、機内。旅程を組んだのが家で、見るのが現地なら、現地は
// たいてい電波が細い側です。
//
// 座標は手元にあります。旅程の中に入っています。タイルが無くても、
// **点と線だけなら描けます**。それを描きます。
//
// これは地図ではありません
// ------------------------
// ここがこの画面のいちばん大事なところです。描くのは
//
//   ・訪れる順に並んだ点（番号と時刻つき）
//   ・その点を順に結んだ**直線**
//   ・北の向きと、長さの目安（縮尺）
//
// 描かないのは、道・線路・海岸線・川・地形です。持っていないからです。
//
// 図の見た目は地図に似ます。似ているのに道が無いものを黙って出すと、
// **これを見て歩こうとする人が出ます**。線は道ではなく「次にここへ
// 行く」という順番です。実際の道は倍の距離を回るかもしれず、そもそも
// 海の上かもしれません。だから図には必ず
//
//   「道は描いていません。線は順番で、距離は直線です」
//
// を添えます。消さないでください。この一文がないと、この図は嘘に
// なります。
//
// 投影について
// ------------
// 緯度をそのまま縦、経度を cos(緯度) で縮めて横に使います（正距円筒）。
// 日本の緯度では横が7〜8割に縮みます。**縮めないと東西に伸びた図に
// なり**、「思ったより近い/遠い」の見当が狂います。
//
// 縦横の比は保ちます。枠に合わせて引き伸ばすと、同じ10kmが縦と横で
// 別の長さになり、縮尺が意味を失います。

import { haversineKm } from "../packages/core/src/feasibility.js";

const NS = "http://www.w3.org/2000/svg";

/** SVG は createElement では作れません（名前空間が要ります）。 */
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    // `instanceof Node` は使いません。**この図は圏外で描くもの**なので、
    // ブラウザ以外（試験、将来の書き出し）でも同じように動くほうが
    // 都合がよく、そこには Node という名前がありません。
    node.append(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** el() が渡されなかったときの、ふつうの DOM 作り。 */
function plainEl(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
  return node;
}


/**
 * 点の並びを、枠の中の座標に直します。
 *
 * @param {Array<{lat:number,lng:number}>} pts
 * @param {number} w 枠の幅
 * @param {number} h 枠の高さ
 * @param {number} pad ふち
 * @returns {{xy:(p:object)=>{x:number,y:number}, kmPerPx:number}}
 */
export function projector(pts, w, h, pad = 34) {
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180) || 1;

  // 経度は cos(緯度) で縮めてから比べます。縮める前に比べると、
  // 東西の広がりを実際より大きく見ます。
  const x0 = Math.min(...lngs) * kx;
  const x1 = Math.max(...lngs) * kx;
  const y0 = Math.min(...lats);
  const y1 = Math.max(...lats);

  // 1点だけ、あるいは全部同じ座標のとき。幅0で割らないように、
  // わずかな広がりを与えます（図は中央の1点になります）。
  const spanX = (x1 - x0) || 0.01;
  const spanY = (y1 - y0) || 0.01;

  const boxW = Math.max(1, w - pad * 2);
  const boxH = Math.max(1, h - pad * 2);
  // **縦横で同じ倍率**にします。片方に合わせて伸ばすと、同じ10kmが
  // 縦と横で違う長さになり、縮尺が読めなくなります。
  const scale = Math.min(boxW / spanX, boxH / spanY);
  const offX = pad + (boxW - spanX * scale) / 2;
  const offY = pad + (boxH - spanY * scale) / 2;

  const xy = (p) => ({
    x: offX + (p.lng * kx - x0) * scale,
    // 緯度は北が大きいので、上下をひっくり返します（画面は下が大きい）。
    y: offY + (y1 - p.lat) * scale,
  });

  // 1px が何kmか。縮尺の棒に使います。緯度1度 ≒ 111.32km。
  const kmPerPx = 111.32 / scale;
  return { xy, kmPerPx };
}

/** 縮尺の棒の長さ。読みやすい数（1/2/5の倍数）に丸めます。 */
export function scaleStep(kmPerPx, maxPx = 120) {
  const rough = kmPerPx * maxPx;
  if (!(rough > 0) || !Number.isFinite(rough)) return null;
  const pow = 10 ** Math.floor(Math.log10(rough));
  for (const m of [5, 2, 1]) {
    if (pow * m <= rough) return pow * m;
  }
  return pow;
}

/** 距離の書き方。1km を切ったら m にします。 */
function kmLabel(km) {
  if (km < 1) return `${Math.round(km * 1000)}m`;
  if (km < 10) return `${km.toFixed(1)}km`;
  return `${Math.round(km)}km`;
}

/**
 * 札（名前）の置き場所を決めます。
 *
 * はじめは「点の右に出す。近くに札があれば出さない」だけでした。
 * それで東京駅→草津温泉の日帰り（点が4つ）を描いたら、**4つのうち2つ
 * の名前が消えました。** 空きはいくらでもあるのに、右がふさがって
 * いただけです。
 *
 * 右が駄目なら左、左も駄目なら上、下、と順に試します。**どこにも
 * 置けないときだけ諦めます。** 諦めた数は図の下に書きます。
 *
 * @param {{x:number,y:number}} p
 * @param {number} r 点の半径
 * @param {number} w 図の幅
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} taken 既に使った枠
 * @param {number} textW 札のおおよその幅
 * @returns {{x:number, y:number, anchor:string}|null}
 */
function labelSpot(p, r, w, taken, textW) {
  const gap = r + 6;
  const lh = 15;   // 字の高さぶん
  const tries = [
    // 右・左・下・上。右から試すのは、横書きで読みやすいためです。
    { x: p.x + gap, y: p.y + 4, anchor: "start" },
    { x: p.x - gap, y: p.y + 4, anchor: "end" },
    { x: p.x, y: p.y + gap + lh - 4, anchor: "middle" },
    { x: p.x, y: p.y - gap, anchor: "middle" },
  ];
  for (const t of tries) {
    const half = t.anchor === "middle" ? textW / 2
      : t.anchor === "end" ? textW : 0;
    const x1 = t.x - half;
    const x2 = x1 + textW;
    // 図の外へはみ出す置き方は使いません。切れた名前は読めません。
    if (x1 < 2 || x2 > w - 2) continue;
    const y1 = t.y - lh + 3;
    const y2 = t.y + 3;
    const clash = taken.some(
      (q) => x1 < q.x2 && x2 > q.x1 && y1 < q.y2 && y2 > q.y1);
    if (clash) continue;
    taken.push({ x1, y1, x2, y2 });
    return t;
  }
  return null;
}

/** 札の幅の見当。和文はほぼ全角なので、字数×文字サイズで足ります。 */
function textWidth(text) {
  // 半角（数字・記号）は半分で数えます。
  let n = 0;
  for (const ch of text) n += /[\x20-\x7e]/.test(ch) ? 0.5 : 1;
  return n * 11;
}

/**
 * 幅をもらえなかったときの、画面からの見当。
 *
 * 呼ぶ側が箱の幅を測って渡すのが本筋です（js/map.js）。ここは
 * 渡されなかったときの受け皿で、画面の幅から引きます。
 */
function defaultWidth() {
  const vw = globalThis.document?.documentElement?.clientWidth;
  if (!Number.isFinite(vw) || vw <= 0) return 640;
  // 画面が広いときも、字が間延びしない幅で止めます。
  return Math.round(Math.max(280, Math.min(880, vw - 48)));
}


/** 点の広がりの形から、枠の高さを決めます。 */
function naturalHeight(pts, w, pad = 34) {
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180) || 1;
  const spanY = (Math.max(...lats) - Math.min(...lats)) || 0.01;
  const spanX = ((Math.max(...lngs) - Math.min(...lngs)) * kx) || 0.01;
  const inner = Math.max(1, w - pad * 2);
  return Math.round(
    Math.min(460, Math.max(200, inner * (spanY / spanX) + pad * 2)));
}


/**
 * 順路の図を1枚作ります。
 *
 * @param {Array<object>} points pointsFromItinerary() が返す並び
 * @param {object} [opts]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {string} [opts.title] 図の名前（読み上げ用）
 * @returns {{node: SVGElement, hidden: number, spanKm: number}|null}
 */
export function routeSvg(points, opts = {}) {
  const pts = (points ?? []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  if (!pts.length) return null;

  // 幅は、実際に置かれる箱の幅をもらいます。
  //
  // 640 で固めて CSS で width:100% にしていたら、携帯（箱の幅 366px）
  // で **0.57倍に縮み、11px の札が6px になりました。** 読めません。
  // viewBox の中の字は、枠の縮小と一緒に縮みます。縮めないためには、
  // はじめから箱の幅で描くしかありません。
  const w = opts.width ?? defaultWidth();
  // 高さは、点の広がりの形から決めます。
  //
  // 420px に固めていたら、草津の1日目（784m を横切るだけ）が縦長の
  // 枠の中でほとんど空白になりました。**縮尺は縦横で同じ**にしている
  // ので、枠を余らせるぶんは、ただの空きです。
  //
  // 点の南北と東西の比をそのまま高さにします。上下に寄りすぎないよう、
  // 200〜460px に収めます（低すぎると札が置けず、高すぎると空きます）。
  const h = opts.height ?? naturalHeight(pts, w);
  const { xy, kmPerPx } = projector(pts, w, h);
  const at = pts.map((p) => ({ ...p, ...xy(p) }));

  const node = svg("svg", {
    class: "routemap", viewBox: `0 0 ${w} ${h}`,
    // 幅は親に合わせます。図なので、読み上げには一言で足ります。
    role: "img",
    "aria-label": opts.title
      ?? `順路の図（${pts.length}か所を訪れる順に結んだもの。`
         + "道は描いていません）",
  });

  // 1. 線。順に結ぶだけです。**道ではありません。**
  const d = at.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  node.append(svg("path", { class: "rm-leg", d }));

  // 2. 点。訪れる順の番号を入れます。
  //
  // 札（名前）は、近すぎるものを出しません。重ねて出すと、どちらの
  // 名前なのか分からない字の塊になります。**出さなかった数は下に
  // 書きます**——黙って消すと、図に無い場所は旅程にも無いと読まれます。
  let hidden = 0;
  // 北の矢印と縮尺の棒が置かれる場所を、先に押さえます。
  //
  // 押さえていなかったら、草津の図で **② の札が「北」の字に重なり**
  // ました。矢印は決まった隅に描くので、点がそこに来ることはあります。
  const step0 = scaleStep(kmPerPx, Math.min(140, w * 0.28));
  const taken = [
    { x1: 4, y1: 8, x2: 44, y2: 52 },                        // 北の矢印
  ];
  if (step0) {
    taken.push({ x1: 14, y1: h - 40, x2: 30 + step0 / kmPerPx, y2: h - 8 });
  }
  for (const p of at) {
    const r = p.kind === "spot" ? 8 : 6;
    node.append(svg("circle", {
      class: `rm-dot rm-${p.kind}`, cx: p.x.toFixed(1), cy: p.y.toFixed(1),
      r,
    }));
    if (p.kind === "spot" && p.order !== undefined) {
      node.append(svg("text", {
        class: "rm-no", x: p.x.toFixed(1), y: (p.y + 3.6).toFixed(1),
        "text-anchor": "middle",
      }, String(p.order)));
      // 番号の丸のぶんは、札を置けない場所として押さえます。
      taken.push({ x1: p.x - r, y1: p.y - r, x2: p.x + r, y2: p.y + r });
    }
  }
  // 札は、点をぜんぶ描いたあとに置きます。先に置くと、あとから来る点の
  // 丸の上に札が乗ります。
  const said = new Set();
  for (const p of at) {
    const text = p.time ? `${p.label}（${p.time}）` : p.label;
    // 同じ名前を2度書きません。出発地と終点はふつう同じ駅で、
    // **「東京駅」が2つ重なって出ていました。**
    if (said.has(text)) continue;
    said.add(text);
    const at_ = labelSpot(p, p.kind === "spot" ? 8 : 6, w, taken,
                          textWidth(text));
    if (!at_) {
      hidden++;
      continue;
    }
    node.append(svg("text", {
      class: "rm-name", x: at_.x.toFixed(1), y: at_.y.toFixed(1),
      "text-anchor": at_.anchor,
    }, text));
  }

  // 3. 北の向き。上が北です（緯度をそのまま縦に使っています）。
  node.append(svg("path", { class: "rm-axis", d: "M22 34 L22 14 M17 20 L22 14 L27 20" }));
  node.append(svg("text", { class: "rm-axis-t", x: 22, y: 46,
                            "text-anchor": "middle" }, "北"));

  // 4. 縮尺。これが無いと「近い」「遠い」が読めません。
  const step = step0;
  if (step) {
    const px = step / kmPerPx;
    const y = h - 18;
    const x = 22;
    node.append(svg("path", { class: "rm-scale",
      d: `M${x} ${y - 5} L${x} ${y} L${x + px} ${y} L${x + px} ${y - 5}` }));
    node.append(svg("text", { class: "rm-axis-t", x: x + px / 2, y: y - 9,
                              "text-anchor": "middle" }, kmLabel(step)));
  }

  // いちばん離れた2点の直線距離。図がどれくらいの広さなのかの目安です。
  let spanKm = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      spanKm = Math.max(spanKm, haversineKm(pts[i], pts[j]));
    }
  }
  return { node, hidden, spanKm };
}

/**
 * 図と、その読み方をひとまとめにした塊を作ります。
 *
 * 添える一文は飾りではありません。**この図は地図に似ていて、地図では
 * ない**ので、そう書いていないと嘘になります。
 *
 * @param {Array<object>} points
 * @param {object} [opts]
 * @param {(tag:string, attrs?:object, ...kids:any[])=>HTMLElement} opts.el
 * @param {string} [opts.heading]
 * @param {string} [opts.note] 事情の説明（圏外である、など）
 * @returns {HTMLElement|null}
 */
export function routeDiagram(points, opts = {}) {
  // el() を渡せるのは、ui.js を持ち込まずに済ませるためです（試験と、
  // 読み込みの輪を避けるため）。渡されなければ自分で作ります——
  // **圏外で出す図が、他の画面の都合で出ないのは困ります。**
  const el = typeof opts.el === "function" ? opts.el : plainEl;
  if (typeof document === "undefined" && opts.el === undefined) return null;

  const pts = (points ?? []).filter(
    (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  if (!pts.length) return null;

  const kids = [];
  if (opts.heading) {
    // 見出しの段は、置かれる場所で決まります。
    //
    // はじめは h3 で決め打ちにしていました。地図は旅程の h2 より**前**に
    // あるので、画面の見出しは h1 → h3 と飛びます。axe が拾いました
    // （heading-order）。読み上げで見出しを辿る人は、そこで1段抜けた
    // ように聞こえます。
    //
    // 既定は h2 です。別の深さに置くなら、置く側が指定します。
    kids.push(el(opts.headingLevel ?? "h2", { class: "rm-head" },
                 opts.heading));
  }
  if (opts.note) kids.push(el("p", { class: "rm-why" }, opts.note));

  // 日ごとに分けて描きます。
  //
  // はじめは旅ぜんぶを1枚に描いていました。東京駅→草津温泉の日帰りで
  // 試したら、**149km の移動が図を占めて、草津の中の2か所が1つの点に
  // 潰れました。** 縮尺は 20km、知りたかった「宿から湯畑まで歩けるか」
  // は読めません。
  //
  // 3泊の旅なら、なおさらです。日ごとに分ければ、その日の広がりで
  // 描けます。日をまたぐ移動は1本の線で足ります（それは旅程の表に
  // 時刻つきで書いてあります）。
  const byDay = groupByDay(pts);
  let hidden = 0;
  let drew = 0;
  for (const group of byDay) {
    const made = routeSvg(group.points, opts);
    if (!made) continue;
    drew++;
    hidden += made.hidden;
    if (byDay.length > 1) {
      kids.push(el("p", { class: "rm-day" },
        `${group.label}（直線で ${kmLabel(made.spanKm)}）`));
    }
    kids.push(made.node);
    group.spanKm = made.spanKm;
  }
  if (!drew) return null;

  const lines = [
    "道は描いていません。線は訪れる順で、長さは直線の距離です。",
  ];
  if (byDay.length === 1 && byDay[0].spanKm >= 0.1) {
    lines.push(`いちばん離れた2か所は直線で ${kmLabel(byDay[0].spanKm)} です。`);
  } else if (byDay.length > 1) {
    lines.push("日をまたぐ移動は、この図には入れていません"
      + "（旅程の表に時刻つきで出ています）。");
  }
  const dropped = byDay.reduce((n, g) => n + (g.dropped ?? 0), 0);
  if (dropped) {
    // 出発地や終点を外したことを書きます。書かないと「図にあるのが
    // その日ぜんぶ」と読まれます。
    lines.push("出発地・終点はその日の範囲から遠いため、"
      + "図には入れていません。");
  }
  if (hidden) {
    // 出さなかったことを書きます。図に無い場所は旅程にも無い、と
    // 読まれないようにするためです。
    lines.push(`近くに重なるため、${hidden}か所の名前は`
      + "出していません（旅程の一覧には残っています）。");
  }
  kids.push(el("p", { class: "rm-limits" }, lines.join(" ")));
  return el("figure", { class: "routemap-fig" }, ...kids);
}

/**
 * 点を日ごとに分けます。
 *
 * 出発地と終点（day を持たないもの）は、いちばん近い日に付けます。
 * どこにも付けないと、初日の図に出発した駅が出ません。
 */
export function groupByDay(pts) {
  const days = [...new Set(pts.filter((p) => p.day !== undefined)
    .map((p) => p.day))].sort((a, b) => a - b);
  if (days.length <= 1) {
    return [{ label: "順路", points: pts, dropped: 0 }];
  }
  const out = days.map((d) => ({
    label: `${d + 1}日目`,
    points: pts.filter((p) => p.day === d),
    dropped: 0,
  }));

  // 出発地と終点（day を持たないもの）を、どちらかの端に付けます。
  //
  // **ただし、遠すぎるものは付けません。** はじめは無条件に付けて
  // いましたが、東京駅→草津の2泊で描いたら、1日目の図も2日目の図も
  // 148km の直線が1本走るだけになりました。日ごとに分けた意味が
  // ありません。
  //
  // この図で知りたいのは「その日、どれくらい歩くのか」です。前の晩に
  // 乗った新幹線は、旅程の表に時刻つきで出ています。**その日の広がり
  // より大きく離れている端は、図に入れません。**
  const loose = pts.filter((p) => p.day === undefined);
  for (const p of loose) {
    const g = p.kind === "origin" ? out[0] : out.at(-1);
    const span = spanKmOf(g.points);
    const near = Math.min(...g.points.map((q) => haversineKm(p, q)));
    // その日の広がりの1.5倍、または8km より遠ければ入れません。
    //
    // はじめは「その日の広がり、最低2km」にしていました。それだと
    // **京都駅（清水寺から2.6km）まで外れました。** 街なかの駅は、
    // その日の絵の一部です。そこからバスに乗るのだとしても、
    // 「駅からどれくらいの所を歩く日なのか」が読めます。
    //
    // 8km にしたのは、この2つがきれいに分かれる幅だからです。
    //
    //   街の中の駅と立ち寄り     1〜8km    入れたい
    //   拠点を移す移動           50km〜    入れたくない
    if (near > Math.max(span * 1.5, 8)) {
      g.dropped++;
      continue;
    }
    if (p.kind === "origin") g.points.unshift(p);
    else g.points.push(p);
  }

  // その日に1か所しか無いと、図は点1つになります。**点1つの図は
  // 何も伝えません。** 前の日に足して、移動として見せます。
  const merged = [];
  for (const g of out) {
    if (g.points.length < 2 && merged.length) {
      const prev = merged.at(-1);
      prev.points = prev.points.concat(g.points);
      prev.dropped += g.dropped;
      prev.label = `${prev.label}〜${g.label}`;
      continue;
    }
    merged.push(g);
  }
  return merged.filter((g) => g.points.length >= 1);
}

/** その並びの、いちばん離れた2点の直線距離。 */
function spanKmOf(pts) {
  let km = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      km = Math.max(km, haversineKm(pts[i], pts[j]));
    }
  }
  return km;
}
