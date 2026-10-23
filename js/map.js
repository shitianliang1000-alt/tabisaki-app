// OpenStreetMap の地図（Leaflet）。
//
// 旅程を地図で見せるのは飾りではありません。「その順に回って本当に無理が
// ないか」は、線で結ばれた形を見た瞬間に分かります。数字の羅列では
// 気づけない遠回りが目で分かるので、時刻表と対にして置いています。
//
// Leaflet は CDN から読み込み、window.L として使います。

import { routeDiagram } from "./routemap.js";

const DEFAULT_CENTER = [35.681236, 139.767125];

/**
 * 「動きを減らす」設定にしているか。
 *
 * CSS の側は prefers-reduced-motion に対応済みでした。ところが
 * **地図の動きは JS が起こしています。** Leaflet の setView は
 * { animate: true } で滑らかに寄っていくので、設定に関わらず画面が
 * 流れます。旅程の行に触れるたびに地図が滑るのは、その設定にして
 * いる人にはいちばん困る動きです（酔う人がいます）。
 *
 * 毎回読み直します。設定はページを開いたままでも変えられるので、
 * 起動時に1回だけ見ると、変えたのに効かないことになります。
 *
 * @returns {boolean}
 */
function reduceMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
      ?.matches === true;
  } catch {
    // matchMedia が無い場（試験、古い環境）。動かして構いません。
    return false;
  }
}

export class TripMap {
  constructor(elementId) {
    this.el = document.getElementById(elementId);
    this.map = null;
    this.layer = null;
    this.markers = [];
    this.bySpot = new Map();   // spotId → マーカー（旅程との連動用）
    this.points = [];
  }

  get available() {
    return Boolean(this.el && window.L);
  }

  ensure() {
    if (!this.available) return false;
    if (this.map) return true;
    const L = window.L;
    this.map = L.map(this.el, {
      scrollWheelZoom: false,   // ページのスクロールを奪わない
      zoomControl: false,       // 日本語の名前で付け直します（下）
    }).setView(DEFAULT_CENTER, 9);
    japaneseControls(this.map);
    L.tileLayer(this.tileUrl, {
      attribution: this.attribution,
      maxZoom: 19,
      // 見たタイルを圏外でも出せるように、sw.js が取っておきます。
      // CORS で取らないと中身の見えない応答（opaque）になり、ブラウザは
      // 1枚を数MBとして容量に数えます。OSM のタイルは CORS に応じます。
      crossOrigin: true,
    }).addTo(this.map);
    this.layer = L.layerGroup().addTo(this.map);
    return true;
  }

  configure({ tileUrl, attribution }) {
    this.tileUrl = tileUrl;
    this.attribution = attribution;
  }

  clear() {
    this.layer?.clearLayers();
    this.markers = [];
    this.bySpot.clear();
  }

  /**
   * 旅程を描きます。
   * @param {Array<{lat,lng,label,kind,order}>} points 訪問順
   */
  render(points) {
    if (!points.length) return;
    // 紙のときだけ出る順路の図。**地図が出ていても作ります。**
    //
    // 紙にタイルは刷れません（@media print で .map を落としています）。
    // これまでは、印刷すると地図の場所がそのまま消えていました。旅程の
    // 座標から描く図なら刷れるので、刷れるほうを置きます。
    //
    // 紙は電池も電波も要りません。端末が濡れても、落としても、充電が
    // 切れても残ります。最後の受け皿です。
    this.renderPrint(points);
    if (!window.L) {
      // 地図が出せないときに、理由を書くだけで済ませていました。
      //
      //   「地図を読み込めませんでした（インターネット接続を確認して
      //     ください）。旅程はこのままご利用いただけます。」
      //
      // 正しいのですが、**いちばん地図が要るときに出る一文**です。
      // 山の中、島、地下、機内。組んだのは家で、見るのは現地なら、
      // 現地はたいてい電波が細い側です。
      //
      // 座標は手元にあります。旅程の中に入っています。タイルが無くても
      // 点と線だけなら描けるので、描きます（js/routemap.js）。
      // 図が作れなければ、これまでどおり一文にします。
      this.el.classList.add("map-fallback");
      this.el.textContent = "";
      const fig = routeDiagram(points, {
        // 箱の幅で描かせます。**渡さないと、携帯で字が6pxになります**
        // （viewBox の中の字は、枠の縮小と一緒に縮みます）。
        width: boxWidth(this.el),
        heading: "順路（電波が無くても見られます）",
        note: "地図（タイル）を読み込めなかったので、"
          + "旅程の座標から順路だけを描いています。",
      });
      if (fig) {
        this.el.classList.add("map-offline");
        this.el.append(fig);
        this.points = points;
        return;
      }
      this.el.textContent =
        "地図を読み込めませんでした（インターネット接続を確認してください）。"
        + "旅程はこのままご利用いただけます。";
      return;
    }
    this.el.classList.remove("map-fallback", "map-offline");
    // 圏内に戻って描き直すときは、図を片付けます。残すと Leaflet が
    // その上に地図を敷き、**順路の図が地図の下でずっと生きています**。
    this.el.querySelector?.(".routemap-fig")?.remove();
    this.points = points;
    if (!this.ensure()) return;
    const L = window.L;
    this.clear();

    const latlngs = [];
    points.forEach((p, i) => {
      const latlng = [p.lat, p.lng];
      latlngs.push(latlng);

      // 名前を付けます。Leaflet は押せるピンを role="button" にするので、
      // 名前が無いと読み上げでは「ボタン」としか言われません。
      const marker = L.marker(latlng, { icon: this.icon(p, i),
                                        title: p.label ?? "" })
        .addTo(this.layer);
      const popupContent = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = p.label;
      popupContent.append(strong);
      if (p.time) {
        popupContent.append(document.createElement("br"));
        const span = document.createElement("span");
        span.textContent = p.time;
        popupContent.append(span);
      }
      marker.bindPopup(popupContent);
      // 重なったときに、番号の若いほうを手前に出します。
      // Leaflet は既定で「南にあるものほど手前」なので、1 が 2 の
      // 後ろに隠れることがありました。どこから始まるかが読めません。
      marker.setZIndexOffset?.(1000 - i * 10);
      if (p.onClick) marker.on("click", p.onClick);
      if (p.spotId) this.bySpot.set(p.spotId, marker);
      this.markers.push(marker);
    });

    // 線は引きません。
    //
    // 太い線で結んでいたときは、それが**実際に通る道に見えました**。
    // こちらが持っているのは点の座標だけで、線は2点を直線でつないだ
    // ものです。海の上や山の中をまっすぐ横切ります。
    // 「その道を行く」と読まれてしまうものを、根拠なく描くべきでは
    // ありません。順番は、ピンの番号で足ります。
    //
    // 実際の道が要るときは、旅程から「経路を開く」で地図アプリへ
    // 渡します（そちらは本物の経路を持っています）。

    const bounds = L.latLngBounds(fitTargets(points).map((p) => [p.lat, p.lng]));
    this.map.fitBounds(bounds,
      { padding: [32, 32], maxZoom: 14, animate: !reduceMotion() });
  }

  icon(point, index) {
    const L = window.L;
    const isEndpoint = point.kind === "origin" || point.kind === "end";
    // 出発と終点は緑（systemGreen）、立ち寄りは青（systemBlue）。
    // 番号を中に入れます。
    const bg = isEndpoint ? "#555555" : "#111111";
    const label = isEndpoint ? "" : String(index);

    // HTML の文字列ではなく、要素そのものを渡します。
    // Leaflet は 1.4 から HTMLElement を受け取ります。文字列で組むと、
    // そこが innerHTML になります。いまは安全な値しか入りませんが、
    // 「いまは」で持たせる作りにしないためです。
    const pin = document.createElement("span");
    pin.style.background = bg;
    // 順に落ちてくる動きの順番（css/app.css の pin-drop）。
    pin.style.setProperty("--i", String(Math.min(Number(index) || 0, 12)));
    const num = document.createElement("b");
    num.textContent = label;
    pin.append(num);

    return L.divIcon({
      // 出発・終点は形も変えます。色だけで分けると、色の見分けが
      // つきにくい人には同じものに見えます。
      className: `trip-pin${isEndpoint ? " endpoint" : ""}`,
      html: pin,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
      popupAnchor: [0, -28],
    });
  }

  /** 指定の地点へ寄る（旅程からタップされたとき）。 */
  focus(lat, lng, zoom = 15) {
    if (!this.ensure()) return;
    // 動きを減らす設定なら、滑らずにそのまま移ります。**行く先は
    // 同じです。** 動きをやめるだけで、できることは減りません。
    this.map.setView([lat, lng], zoom, { animate: !reduceMotion() });
  }

  invalidate() {
    this.map?.invalidateSize();
  }
}





/**
 * 地図をどこに合わせるか。
 *
 * 出発地と終点まで入れて合わせていました。東京駅から鎌倉へ行くと、
 * 携帯の幅では東京湾ぜんぶが入る縮尺になり、**立ち寄りの4か所が
 * 1本のピンに重なって**、どこを回るのかが読めませんでした。地図で
 * 見たいのは立ち寄りの並びです。出発地は、近ければ枠に入りますし、
 * 遠ければ地図を引けば見えます。
 *
 * 立ち寄りが無い（出発と終点だけの）ときは、全部に合わせます。
 *
 * @param {Array<{kind?: string}>} points
 */
export function fitTargets(points) {
  const spots = points.filter((p) => p.kind === "spot");
  return spots.length ? spots : points;
}

/**
 * Leaflet の操作部品を日本語の名前にします。
 *
 * 既定は英語です（「Zoom in」「Close popup」）。読み上げでは、
 * この画面の中でそこだけ英語で読まれます。地図を作るたびに呼びます。
 *
 * @param {object} map Leaflet の地図（zoomControl: false で作ったもの）
 */
export function japaneseControls(map) {
  const L = window.L;
  if (!map || !L) return;
  L.control.zoom({ zoomInTitle: "拡大", zoomOutTitle: "縮小" }).addTo(map);
  // 吹き出しの「×」は、名前が中に書き込まれていて設定では変えられません。
  // 開いたときに付け直します。
  map.on("popupopen", (e) => {
    e.popup?.getElement?.()?.querySelector(".leaflet-popup-close-button")
      ?.setAttribute("aria-label", "閉じる");
  });
}

/** その箱に実際に描ける幅。まだ measure できないときは既定に任せます。 */
function boxWidth(node) {
  const w = node?.clientWidth;
  if (!Number.isFinite(w) || w <= 0) return undefined;
  return Math.round(Math.max(280, Math.min(880, w - 24)));
}

/**
 * 紙用の順路の図を、画面の外の箱に作っておきます。
 *
 * 画面では隠します（css の .map-print）。地図が出ているのに同じものが
 * 2つ並ぶと、どちらを見ればよいのか分かりません。
 */
TripMap.prototype.renderPrint = function renderPrint(points) {
  const box = document.getElementById("map-print");
  if (!box) return;
  box.textContent = "";
  const fig = routeDiagram(points, {
    // 紙の刷り幅（A4 の左右余白を引いたぶん）。
    width: 700,
    heading: "順路",
    // 紙には「電波が無くても」は書きません。紙はそもそも電波と
    // 関係がありません。
  });
  if (fig) box.append(fig);
};

/** 旅程から、地図に落とす点の並びを作ります。 */
export function pointsFromItinerary(itin, trip, opts = {}) {
  const points = [];
  if (trip?.origin) {
    points.push({ lat: trip.origin.lat, lng: trip.origin.lng,
                  label: trip.origin.name, kind: "origin" });
  }
  let n = 0;
  for (const [di, day] of itin.days.entries()) {
    for (const item of day.items) {
      if (item.kind !== "spot" || !item.place) continue;
      n++;
      points.push({
        lat: item.place.lat, lng: item.place.lng,
        label: item.title, kind: "spot", order: n,
        time: fmtTime(item.start),
        spotId: item.spotId, day: di,
        // ピンを押しても、旅程の行を押したときと同じものが開きます。
        // 片方向だけだと、地図で見つけた場所の説明に辿りつけません。
        onClick: opts.onSpot ? () => opts.onSpot(item) : undefined,
      });
    }
  }
  const last = itin.days.at(-1)?.items.at(-1);
  if (last?.to) {
    points.push({ lat: last.to.lat, lng: last.to.lng,
                  label: last.to.name ?? "終点", kind: "end" });
  }
  return points;
}

function fmtTime(d) {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 旅程の行と地図のピンをつなぐ。
 *
 * 数字が並んでいるだけでは、その場所が地図のどこなのか分かりません。
 * 旅程に触れたらピンが目立ち、逆も同じ、という往復ができると、
 * 「この順で無理がないか」がひと目で確かめられます。
 */
TripMap.prototype.highlight = function highlight(spotId, on) {
  const marker = spotId && this.bySpot.get(spotId);
  if (!marker) return;
  const node = marker.getElement?.();
  if (node) node.classList.toggle("hl", Boolean(on));
  if (on) marker.openPopup?.();
};

/** その日の地点だけを表示する（-1 で全日）。 */
TripMap.prototype.showDay = function showDay(dayIndex) {
  if (!this.points.length) return;
  const pts = dayIndex < 0
    ? this.points
    : this.points.filter((p) => p.day === undefined || p.day === dayIndex
        || p.kind !== "spot");
  const target = fitTargets(pts.length ? pts : this.points);
  if (!window.L || !this.map) return;
  const bounds = window.L.latLngBounds(target.map((p) => [p.lat, p.lng]));
  this.map.fitBounds(bounds,
    { padding: [32, 32], maxZoom: 14, animate: !reduceMotion() });
};

/**
 * いま読んでいる立ち寄りを、地図の上でも示す（js/follow.js から）。
 *
 * 触れたとき（highlight）とは分けます。読んでいるだけで吹き出しが
 * 次々に開くと、地図が文字で埋まります。ここでは印を濃くして、
 * 画面の外にあるときだけ地図を寄せます。縮尺は変えません。
 */
TripMap.prototype.follow = function follow(spotId) {
  if (this.following === spotId) return;
  const prev = this.following && this.bySpot.get(this.following);
  prev?.getElement?.()?.classList.remove("reading");
  this.following = spotId ?? null;
  const marker = spotId && this.bySpot.get(spotId);
  if (!marker || !this.map) return;
  marker.getElement?.()?.classList.add("reading");
  const at = marker.getLatLng?.();
  if (at && !this.map.getBounds().pad(-0.1).contains(at)) {
    this.map.panTo(at, { animate: !reduceMotion() });
  }
};
