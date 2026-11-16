// 外部サービスへのリンク。
//
// 食事と宿泊は、このアプリが在庫や価格を持たない領域です。名前を推測して
// 表示するより、その場所・その時間帯で実際に開いている店を Google マップ側で
// 見てもらうほうが確実なので、該当ページを直接開きます。
//
// いずれも公開されている URL 形式で、API キーは不要です。

/** 座標を Google マップで開く（スポットの詳細から）。 */
export function mapsPlaceUrl(place) {
  const q = encodeURIComponent(`${place.lat},${place.lng}`);
  const label = place.name ? `&query_place_id=` : "";
  void label;
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/** 名前で検索して開く（座標より名前のほうが当たりが良い施設向け）。 */
export function mapsSearchUrl(query, near) {
  const q = encodeURIComponent(query);
  if (near) {
    // /@lat,lng,zoom を付けるとその周辺が中心になる
    return `https://www.google.com/maps/search/${q}/@${near.lat},${near.lng},15z`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/**
 * 食事どころを探す。周辺の飲食店一覧を地図で開きます。
 * 昼食・夕食の項目から呼びます。
 */
export function restaurantsUrl(near, kind = "レストラン") {
  const where = near?.regionName ? `${near.regionName} ${kind}` : kind;
  return mapsSearchUrl(where, near);
}

/**
 * 宿を探す。Google のホテル検索（トラベル）を、日付付きで開きます。
 * 日付が入るぶん、素の地図検索より実用的です。
 */
export function hotelsUrl(near, checkIn, checkOut) {
  const parts = [];
  if (near?.regionName) parts.push(near.regionName);
  parts.push("ホテル");
  const q = encodeURIComponent(parts.join(" "));

  const url = new URL("https://www.google.com/travel/search");
  url.searchParams.set("q", decodeURIComponent(q));
  if (checkIn && checkOut) {
    // Google Travel は ISO の日付を受け取ります
    url.searchParams.set("checkin", isoDate(checkIn));
    url.searchParams.set("checkout", isoDate(checkOut));
  }
  return url.toString();
}

/**
 * 地図アプリに渡す場所の書きかた。
 *
 * 駅は**名前で**渡します。旅程の「難波駅」の位置は、エリアの代表点
 * （駅の近く）で、座標のまま渡すと地図は付近の名もない建物に旗を立てます。
 * 「難波→住吉大社」を開いたら、知らないビルから始まっていた、の原因です。
 * 名前なら地図が駅の出入口に当ててくれます。スポットの座標は正確なので、
 * そのまま渡します。
 */
function placeParam(p) {
  const name = String(p?.name ?? "").trim();
  if (/駅$/.test(name)) return name;
  return `${p.lat},${p.lng}`;
}

/** 経路を Google マップで開く（実際に移動するときに使う想定）。 */
export function directionsUrl(from, to, mode = "transit") {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", placeParam(from));
  url.searchParams.set("destination", placeParam(to));
  url.searchParams.set("travelmode", mode);
  return url.toString();
}

/**
 * いまいる場所から、その場所への経路。
 *
 * `origin` を空にすると、Google マップ側が現在地を使います。
 * 旅行中はそれが正しい起点です。旅程に書かれた「前の場所」から
 * 案内しても、すでに動いてしまった人には合いません。
 *
 * 位置情報をこちらで取る必要はありません。地図アプリに渡すだけです。
 */
export function directionsFromHereUrl(to, mode = "transit") {
  if (!Number.isFinite(to?.lat) || !Number.isFinite(to?.lng)) return "";
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", "");
  url.searchParams.set("destination", `${to.lat},${to.lng}`);
  url.searchParams.set("travelmode", mode);
  return url.toString();
}

/**
 * 公式サイト。https のものだけを通します。
 *
 * http のままだと、開いた先で通信の中身が読まれます。Wikidata には
 * 古い http の登録が残っていることがあるので、https に書き換えて
 * 通します（多くのサイトは https に転送します。転送しないサイトは
 * 開けませんが、平文で開かせるよりはましです）。
 */
export function officialUrl(place) {
  // 収録の公式サイトが無ければ、OpenStreetMap に書かれたサイト（osmInfo）。
  const raw = String(place?.url ?? place?.osmInfo?.website ?? "").trim();
  if (!raw) return "";
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^http:\/\//i.test(raw)) return raw.replace(/^http:/i, "https:");
  return "";
}

/**
 * 電話番号。Wikidata の形（+81-982-72-2413）を、日本の形に直します。
 *
 *   表示   0982-72-2413      （国内からかける形）
 *   リンク tel:+81982722413  （携帯がそのままかけられる形）
 *
 * 出どころの形はデータに残し、直すのは画面に出すときだけです。
 *
 * @returns {{display:string, href:string}|null}
 */
export function phoneOf(place) {
  const raw = String(place?.tel ?? place?.osmInfo?.phone ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (!/^\+?\d{6,}$/.test(digits)) return null;
  let display = raw;
  if (/^\+81/.test(digits)) {
    // 国番号を落として、頭に 0 を足します。区切りは元のまま使います。
    display = raw.replace(/^\+81[-\s]?/, "0");
  }
  const href = `tel:${digits.startsWith("+") ? digits : digits}`;
  return { display, href };
}

/** 日本語 Wikipedia の記事。 */
export function wikipediaUrl(title) {
  const enc = encodeURIComponent(String(title ?? "").replace(/ /g, "_"));
  return `https://ja.wikipedia.org/wiki/${enc}`;
}

/** OpenStreetMap 上で見る。 */
export function osmUrl(place, zoom = 17) {
  return `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}`
    + `#map=${zoom}/${place.lat}/${place.lng}`;
}

function isoDate(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/**
 * 旅程の1項目に対して、開くべき外部リンクを返します。
 * UI はこの結果をそのままボタンにします。
 */
export function linksForItem(item, ctx = {}) {
  const out = [];
  const near = { lat: ctx.lat, lng: ctx.lng, regionName: ctx.regionName };

  switch (item.kind) {
    case "meal": {
      const kind = item.title.includes("夕") ? "ディナー" : "ランチ";
      // 何を食べる土地かが分かっているなら、その言葉で探します。
      // 「レストラン」で開くより、「讃岐うどん」で開くほうが当たります
      // （meals.js が決めています。店名はこちらで作りません）。
      const what = String(item.food?.query ?? "").trim();
      out.push({
        label: what ? `${what}のお店を地図で探す` : `${kind}のお店を地図で探す`,
        url: what ? mapsSearchUrl(
          [near.regionName, what].filter(Boolean).join(" "), near)
          : restaurantsUrl(near, "レストラン"),
        primary: true,
      });
      break;
    }
    case "lodging": {
      out.push({
        label: "この日の宿を探す",
        url: hotelsUrl(near, ctx.checkIn, ctx.checkOut),
        primary: true,
      });
      break;
    }
    case "spot": {
      if (ctx.place) {
        out.push({ label: "地図で開く", url: mapsPlaceUrl(ctx.place), primary: true });
        // 公式サイトと電話。
        //
        // 収録の半分は Wikidata から来ていて、そこには公式サイト（P856）と
        // 電話番号（P1329）があります。tools/enrich_wikidata.py が段に
        // 書き戻したものをそのまま出します（作り話ではなく、あるものを
        // 取りに行っただけです）。
        //
        // 圏外で地図アプリが重いとき、電話は命綱です。予約が要るかどうかも
        // 公式でしか確かめられません。
        const site = officialUrl(ctx.place);
        if (site) out.push({ label: "公式サイト", url: site });
        const tel = phoneOf(ctx.place);
        if (tel) out.push({ label: `電話 ${tel.display}`, url: tel.href });
        if (ctx.wikipedia) {
          out.push({ label: "Wikipedia", url: wikipediaUrl(ctx.wikipedia) });
        }
        out.push({ label: "OpenStreetMap", url: osmUrl(ctx.place) });
      }
      break;
    }
    case "transit": {
      if (ctx.from && ctx.to) {
        // 経路は Google マップで開きます。アプリ内で経路が組めた区間は
        // その確認に、組めなかった区間（フェリー・未収録のバス等）は
        // 実際の便の確認に使います（Maps URLs。#367）。
        out.push({ label: "経路を開く", url: directionsUrl(ctx.from, ctx.to) });
      }
      break;
    }
    default:
      break;
  }
  return out;
}
