// エリア別のページ（areas/）を、kb/ から作る道具。
//
// 旅さき本体は1ページのアプリです。検索から来る人は「箱根 日帰り
// モデルコース」「金沢 観光地」のように**場所の名前で**探しますが、
// アプリの1ページにはその言葉がありません。場所ごとに、読める
// ページを置きます。
//
//   areas/index.html              都道府県とエリアの一覧
//   areas/<県>/index.html         その県の定番・穴場・エリア
//   areas/<県>/<エリア>.html      そのエリアの1日のモデルコース
//   about.html                    旅さきの紹介（何ができるか・組んだ例）
//   404.html                      無い URL を開いたときのページ
//
// モデルコースは、アプリと**同じエンジン**（js/pipeline.js）で組みます。
// 中継（AI・経路検索）へは出ないので、移動時間は距離からの目安です。
// ページにもそう書きます。
//
// リポジトリには入れません。公開のたびに tools/build_site.sh（Cloudflare・PHP 版の組み立て）が
// 作ります（収録が変わるたびに作り直し忘れる、ということが起きません）。
// 手元で見るときは:
//
//     node tools/build_area_pages.mjs dist
//     # dist/areas/index.html を開く
//
// どこにも送りません。読むのは kb/ だけです。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

import { renderAreaCard } from "./area_card.mjs";
import { artFor } from "../js/art.js";
import { normalizeName, sameThing } from "../js/dedupe.js";
import { iconPath, STROKE_WIDTH } from "../js/icons.js";
import { fitsHiddenList, gemScore } from "./gem.mjs";
import { onlySpots } from "../js/notaspot.js";

const ROOT = new URL("../", import.meta.url).pathname;

/** 公開URLの根。sitemap.xml の1件目から読みます（無ければこれ）。 */
const DEFAULT_BASE = "https://tabisaki-github-io.shitianliang1000.workers.dev/";

/** 1ページに並べる数。多すぎると読まれず、少なすぎると探しに来た場所がありません。 */
const PREF_MAJOR = 12;
const PREF_HIDDEN = 12;
/** 穴場の欄が、これより少なくならないように足す数（見どころの語の無い説明から）。 */
const PREF_HIDDEN_MIN = 6;
const REGION_SPOTS = 24;
/**
 * エリアのページに「〇〇の観光地」として並べるのは、エリアの中心からこの距離まで。
 *
 * 収録のエリア分けは市町村ぐらいの粗さで、江の島のページに伊勢原や厚木の
 * 資料館（20km 先）が並んでいました。検索から来た人にも検索エンジンにも、
 * 「江の島の観光地」として出すのは誤りです。近くに少ししか無いエリアだけは、
 * 近い順に並べます。
 */
const REGION_RADIUS_KM = 6;
const REGION_MIN_NEAR = 8;
/**
 * モデルコースで寄ってよいのは、エリアの中心からこの距離まで。
 * 鎌倉のコースが横須賀の記念艦三笠（12km）へ、松本のコースが上高地の
 * 河童橋（40km 先）へ行っていました（上高地は今は別のエリアです）。
 */
const COURSE_RADIUS_KM = 10;

/**
 * 名所が中心にかたまっているエリアでは、寄ってよい範囲を狭めます。
 * 松本のコースが、城と旧開智学校のあと、片道1時間の四賀化石館（9km 先）へ
 * バスで往復していました。歩いて回れる城下町なのに、10km の枠の中なら
 * どこでも入れていたためです。いちばん知られた3か所が中心からどこまで
 * 散らばっているか（2番目に遠いもの）を見て、その2.5倍（3〜10km）を枠にします。
 * 町歩きのエリア（genres に city）だけに効かせます。箱根や草津のように
 * 名所が離れているエリアは、これまでどおり 10km です。
 * 名の通った場所（fame_tier が major）は、枠が狭まっても外しません。
 */
const COURSE_MIN_RADIUS_KM = 3;
const COURSE_SPREAD = 2.5;

export function courseRadiusKm(region, own = []) {
  if (![region?.lat, region?.lng].every(Number.isFinite)) return COURSE_RADIUS_KM;
  // 町を歩いて回るエリア（genres に city）だけです。山や温泉地のエリアは、
  // 離れた滝や展望台へ足を延ばすのがふつうの1日です。
  if (!(region.genres ?? []).includes("city")) return COURSE_RADIUS_KM;
  const dist = (s) => distanceKm(region.lat, region.lng, s.lat, s.lng);
  const top = own.filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng)
                                && dist(s) <= COURSE_RADIUS_KM)
    .sort(byFame).slice(0, 3);
  if (top.length < 3) return COURSE_RADIUS_KM;
  // 3か所の中ほど（2番目に遠いもの）で見ます。1か所だけ山の上にある
  // （松本の冠着山）ようなエリアで、枠が広がりきらないようにします。
  const spread = top.map(dist).sort((a, b) => a - b)[1];
  return Math.min(COURSE_RADIUS_KM, Math.max(COURSE_MIN_RADIUS_KM, spread * COURSE_SPREAD));
}

/** モデルコースに入れるには遠すぎる場所か。座標の無いものは判断せず、遠いとはしません。 */
export function isFar(region, spot, radiusKm = COURSE_RADIUS_KM) {
  if (![region?.lat, region?.lng, spot?.lat, spot?.lng].every(Number.isFinite)) return false;
  return distanceKm(region.lat, region.lng, spot.lat, spot.lng) > radiusKm;
}

export function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** `spots-jp13-tokyo.json` → `tokyo`。 */
export function shardSlug(file) {
  const m = /^spots-jp\d{2}-([a-z]+)\.json$/.exec(String(file ?? ""));
  return m ? m[1] : null;
}

/** 次の土曜（その日が土曜なら翌週）。曜日で休館と混雑が変わるので、例は土曜で揃えます。 */
export function nextSaturday(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() + (((6 - d.getDay()) + 7) % 7 || 7));
  return d;
}

/**
 * アプリへのリンク。`?q=` は「どんな旅にしたい？」の欄に入るだけです。
 * チャットの画面の正式なアドレスは /app です（canonical と同じにして、
 * 内部リンクの評価が index.html と /app に割れないようにします）。
 */
export function appLink(rel, text) {
  return `${rel}app?q=${encodeURIComponent(text)}`;
}

/**
 * モデルコースを、アプリで開くリンク。
 *
 * 「どんな旅にしたい？」の文に加えて、コースで寄る場所を「必ず行く」に
 * 入れた状態で開きます（`pin`）。`area` は、その場所の入っている県の段を
 * 先に読むためのものです（js/app.js の restorePinned）。日付と出発地は
 * 入れません。その人の保存済みの条件のほうが合っています。
 */
export function courseLink(rel, text, regionId, spotIds) {
  const q = new URLSearchParams({ q: text });
  if (spotIds?.length) {
    q.set("pin", spotIds.join(","));
    q.set("area", regionId);
  }
  return `${rel}app?${q.toString().replace(/\+/g, "%20")}`;
}

const GENRE_PROMPT = {
  onsen: "温泉でゆっくり",
  nature: "自然の中を歩く",
  history: "歴史ある街並みと寺社をめぐる",
  art: "美術館と建築を見てまわる",
  sea: "海をながめてのんびり",
  food: "名物を食べ歩く",
  view: "景色のいい場所を訪ねる",
  city: "街歩きを楽しむ",
};

/** そのエリアで書けそうな「どんな旅にしたい？」の例。 */
export function examplePrompts(region) {
  const out = [`${region.name}を1日でめぐる`];
  for (const g of region.genres ?? []) {
    if (GENRE_PROMPT[g]) out.push(`${region.name}で${GENRE_PROMPT[g]}`);
    if (out.length >= 4) break;
  }
  return out;
}

const TIER_LABEL = { major: "定番", known: "知る人ぞ知る", hidden: "穴場" };

/** 2点のおおよその距離（km）。ページの絞り込みに使うだけなので、平面近似で足ります。 */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const x = (lng2 - lng1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return 6371 * Math.hypot(x, y);
}

/**
 * エリアの観光地として出してよいもの。中心から REGION_RADIUS_KM 以内。
 * それが REGION_MIN_NEAR に満たないエリアは、中心に近い順に並べ直します。
 * 中心の座標が無いエリアは、そのまま返します。
 */
export function nearbySpots(region, spots) {
  if (!Number.isFinite(region?.lat) || !Number.isFinite(region?.lng)) return [...spots];
  const withDist = spots.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    .map((s) => ({ s, km: distanceKm(region.lat, region.lng, s.lat, s.lng) }));
  const near = withDist.filter((x) => x.km <= REGION_RADIUS_KM).map((x) => x.s);
  if (near.length >= REGION_MIN_NEAR) return near;
  return withDist.sort((a, b) => a.km - b.km).slice(0, REGION_SPOTS).map((x) => x.s);
}

/** パンくず（エリア › 県 › …）の構造化データ。検索結果の URL の代わりに出ることがあります。 */
export function breadcrumbLd(trail) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({
      "@type": "ListItem", position: i + 1, name: t.name, ...(t.url ? { item: t.url } : {}),
    })),
  };
}

function byFame(a, b) {
  return (b.fame_score ?? 0) - (a.fame_score ?? 0)
    || String(a.name).localeCompare(String(b.name), "ja");
}

/**
 * 有名な順。有名さの点が同じもの（点の無い収録の大半）は、名前の順ではなく
 * 説明から見どころが読み取れる順（tools/gem.mjs）にします。
 */
function byFameThenGem(a, b) {
  return (b.fame_score ?? 0) - (a.fame_score ?? 0)
    || gemScore(b, readableDescription(b)) - gemScore(a, readableDescription(a))
    || String(a.name).localeCompare(String(b.name), "ja");
}

/** 説明として長すぎる目安（字）。Wikipedia の書き出しは数百字のことがあります。 */
const DESC_MAX = 110;

/**
 * 文に分けます。かっこの中の句点では切りません。
 *
 * 「。」だけで切っていたころは、Wikipedia の書き出しのかっこの中で切れて、
 * 「…豊国神社（「とよくにじんじゃ」または「ほうこくじんじゃ」と読む。」の
 * ように、閉じないかっこで終わる説明が出ていました。最後まで閉じない
 * 文は、読めないので捨てます。
 */
export function sentencesOf(text) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of String(text)) {
    cur += ch;
    if ("（(「『".includes(ch)) depth++;
    else if ("）)」』".includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === "。" && depth === 0) { out.push(cur); cur = ""; }
  }
  return out;
}

/**
 * ページに載せられる説明。載せられなければ空。
 *
 * 収録の説明には、読んでも何も分からないものが混ざっています。
 *
 *   アイヌ民族博物館（博物館）。若草町2-3-4      名前と分類と住所を並べただけ
 *   河井町4-66-1                                住所だけ
 *   北海道小樽市に所在するダム。型式:gravity …   機械で作った文
 *   扇町公園は、大阪府大阪市北区扇町にある都市公園である。
 *                                               「どこにある何か」だけ
 *
 * 穴場の欄がこれで埋まり、名前の繰り返しと住所が並んでいました。
 * 載せずに、名前と分類だけにします。Wikipedia の書き出しは、読みがな
 * のかっこを落とし、文の切れ目で短くします（途中で切りません）。
 */
export function readableDescription(spot) {
  const name = String(spot?.name ?? "").trim();
  let d = String(spot?.description ?? "").replace(/\s+/g, " ").trim();
  if (!d) return "";
  if (name && d.startsWith(name) && /^(（[^）]*）)+。/.test(d.slice(name.length))) return "";
  if (aboutSomethingElse(name, d)) return "";
  // 書き出しの読みがな:「胎内スキー場（たいないスキーじょう）は、」
  d = d.replace(/^([^（。]{1,40})（[^）]*）(は)/, "$1$2");
  // 句点の無い説明は、国土数値情報の住所の欄です（収録の8,121件がすべてそう）。
  const parts = d.includes("。") ? sentencesOf(d) : (spot?.src === "kokudo" ? [] : [d]);
  const sentences = parts
    .map((x) => x.trim())
    // 「型式:gravity 管理者:北海道」のような、項目を並べただけの文。
    .filter((x) => !/[:：]/.test(x))
    // 決まり文句（城跡の記事の2文目に必ず付いています）。
    .filter((x) => !/^日本の城郭・城館跡のひとつ。$/.test(x));
  if (!sentences.length) return "";
  const generic = /^([^。、]{0,40}は、)?[^。]{0,40}(にある|に所在する|に位置する)[^。、]{0,30}?(である)?。$/;
  if (sentences.length === 1 && generic.test(sentences[0])) return "";
  let out = "";
  for (const x of sentences) {
    if (out && (out + x).length > DESC_MAX) break;
    out += x;
    if (out.length >= DESC_MAX * 0.6) break;
  }
  if (out.length > DESC_MAX) {
    const cut = out.lastIndexOf("、", DESC_MAX);
    out = `${out.slice(0, cut > 40 ? cut : DESC_MAX)}…`;
  }
  return out;
}

/** 名前を比べるための形。かっこ・空白・「の」を落とします（「暗門の滝」と「暗門滝」）。 */
function looseName(name) {
  return String(name ?? "").normalize("NFKC").replace(/[(（][^)）]*[)）]/g, "")
    .replace(/[\s・の]/g, "").toLowerCase();
}

/**
 * 説明が、別のものの記事か。「CIAL鎌倉」に「鎌倉駅は、…」、「宮ノ下温泉」に
 * 「箱根温泉は、…」が付いています。その場所の説明として読むと誤りです。
 * 書き出しの「〇〇は」と名前が、どちらにも含まれないときだけそう見ます。
 */
function aboutSomethingElse(name, d) {
  const m = /^([^、。（(]{1,30})(?:[（(][^）)]*[）)])?は/.exec(d);
  if (!m) return false;
  const a = looseName(name);
  const b = looseName(m[1]);
  if (!a || !b) return false;
  return !a.includes(b) && !b.includes(a);
}

const PREFS = /北海道|東京都|京都府|大阪府|(青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県/;

/**
 * 説明の1文目に出てくる都道府県が、その県でない。県の境の近くの場所が、
 * 隣の県の収録に入っています（京都府のページに大阪の「くずはモール」）。
 */
function inOtherPrefecture(spot, prefName = spot?.prefecture) {
  const first = String(spot?.description ?? "").split("。")[0];
  const m = PREFS.exec(first);
  return Boolean(m && prefName && m[0] !== prefName);
}

/** 行き先として並べないもの（駐車場・ゴルフ場）。収録の観光施設の表に入っています。 */
const NOT_DESTINATION = /駐車場|ゴルフ|カントリークラブ/;

/**
 * もう無い場所の説明（「〜にあった温泉」「閉館」）。穴場として勧めると、行っても
 * 何もありません。定番の欄は手で選んだものが多いので、穴場の欄だけで見ます。
 */
const GONE = /^[^。]*(にあった|に存在した)[^。]{0,24}。|かつて(あった|存在した)|閉館|閉園|廃業|休館中|営業を終了/;

/** 同じ分類を、1つの欄にいくつまで並べるか。穴場がスキー場と資料館だけになっていました。 */
const PER_CATEGORY = 3;

/**
 * 2つが同じ場所の別名か。名前が同じことを言っていて、2km 以内（座標が無ければ名前だけ）。
 * 名前がまったく同じものは、離れていても1つしか並べません。長野県の定番に
 * 「諏訪大社」が2件（上社と下社の座標の2件）並んでいました。読む人には
 * 同じ名前が2回出ているだけに見えます。
 */
function sameSpot(a, b) {
  if (a.id && a.id === b.id) return true;
  if (normalizeName(a.name) === normalizeName(b.name)) return true;
  // 同じ記事を、別の名前の2件が持っていることがあります（「住金鉱業」と「八戸鉱山」）。
  if (a.description && a.description === b.description) return true;
  if (!sameThing(a.name, b.name)) return false;
  if (!Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return true;
  return distanceKm(a.lat, a.lng, b.lat, b.lng) <= 2;
}

/** 有名な順に、同じ場所の別名と、同じ分類の出すぎを除いて n 件。 */
function pickDistinct(list, n, taken, perCategory = PER_CATEGORY) {
  const out = [];
  const perCat = new Map();
  for (const s of list) {
    if (out.length >= n) break;
    if (taken.some((t) => sameSpot(t, s))) {
      // 外したものも「出したもの」の別名として覚えます。下社の座標の「諏訪大社」を
      // 出したあと、上社の座標の「諏訪大社」を外しても、その隣の「諏訪大社 上社本宮」が
      // 同じ神社として並んでいました。
      taken.push(s);
      continue;
    }
    const cat = s.category ?? "";
    if ((perCat.get(cat) ?? 0) >= perCategory) continue;
    perCat.set(cat, (perCat.get(cat) ?? 0) + 1);
    out.push(s);
    taken.push(s);
  }
  return out;
}

/**
 * 県のページに並べる場所。定番は有名な順、穴場は読める説明のあるものから。
 * 説明の無い穴場を並べても、読む人には名前しか分かりません。
 * 定番に出した場所を、表記違いで穴場にもう一度出すことはしません。
 */
export function pickPrefSpots(spots, prefName) {
  const list = onlySpots(spots).filter((s) => s?.name && !NOT_DESTINATION.test(s.name))
    .sort(byFame);
  const taken = [];
  // 「定番」の欄の頭には、本当に定番のもの（major）を先に出します。
  // 有名さの点だけで並べると、佐賀県の頭が加唐島・加部島になり、
  // 吉野ヶ里遺跡や虹の松原が下に沈んでいました。
  const tierRank = (s) => (s.fame_tier === "major" ? 0 : 1);
  const major = pickDistinct(
    list.filter((s) => s.fame_tier === "major" || s.fame_tier === "known")
      .sort((a, b) => tierRank(a) - tierRank(b) || byFame(a, b)), PREF_MAJOR, taken);
  // 穴場は、説明から見どころが読み取れる順（tools/gem.mjs）。以前は有名さの
  // 点の無いものが名前の順に並び、長野県の穴場がスキー場・温水プール・
  // 中央道のトンネル、神奈川県が横穴墓群と準用河川になっていました。
  //
  // 点が1以上のものを先に並べます。それが PREF_HIDDEN_MIN に満たない県
  // （説明の短い収録が多い県）だけ、点が0のもの（悪い語も無いもの）を
  // 説明の長い順に足します。点が負のものは並べません。
  const scored = list
    .filter((s) => s.fame_tier === "hidden" && fitsHiddenList(s)
                   && !GONE.test(s.description) && !inOtherPrefecture(s, prefName))
    .map((s) => ({ s, text: readableDescription(s) }))
    .filter((x) => x.text)
    .map((x) => ({ ...x, score: gemScore(x.s, x.text) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length || byFame(a.s, b.s));
  const hidden = pickDistinct(scored.filter((x) => x.score > 0).map((x) => x.s), PREF_HIDDEN, taken);
  if (hidden.length < PREF_HIDDEN_MIN) {
    hidden.push(...pickDistinct(scored.filter((x) => x.score === 0).map((x) => x.s),
      PREF_HIDDEN_MIN - hidden.length, taken));
  }
  return { major, hidden };
}

/**
 * 分類の記号（アプリの旅程と同じ形。js/art.js が分類から選び、js/icons.js が描きます）。
 * 読み上げません。分類は横に字で書いてあります。
 */
export function spotIcon(spot) {
  const d = iconPath(artFor(spot).icon) || iconPath("spot");
  return `<svg class="sp-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true" focusable="false"><path d="${esc(d)}"/></svg>`;
}

function fmtDate(d) {
  const w = "日月火水木金土"[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日（${w}）`;
}

function fmtTime(d) {
  const x = new Date(d);
  return `${x.getHours()}:${String(x.getMinutes()).padStart(2, "0")}`;
}

/**
 * 「旅さき」（ロゴ・パンくず）の行き先。トップ（/。紹介と入口のページ）です。
 * チャットの画面は「旅程をつくる」のリンク（/app）から開きます。
 */
function home(rel) {
  return rel || "./";
}

/**
 * 1ページの枠。`rel` はページから根までの相対パスです。404.html だけは
 * どの深さの URL でも同じものが出るので、`rel` に根（"/"）を渡し、
 * `canonical` を持たせず `noindex` にします（OGP の絵の URL は `origin` から作ります）。
 */
function page({ title, description, canonical, rel, body, jsonLd, noindex = false, image = null, origin = null }) {
  const ogUrl = canonical ?? origin ?? rel;
  const img = image ?? { path: "og.png", alt: "旅さき — 行きたい、から旅程をつくる。" };
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'none'; base-uri 'self'; form-action 'none'">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(canonical)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="旅さき">
<meta property="og:locale" content="ja_JP">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(ogUrl)}">
<meta property="og:image" content="${esc((origin ? new URL(img.path, origin) : new URL(`${rel}${img.path}`, ogUrl)).href)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(img.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="theme-color" content="#FFFFFF">
<link rel="icon" href="${rel}icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${rel}css/hig-tokens.css">
<link rel="stylesheet" href="${rel}css/hig.css">
<link rel="stylesheet" href="${rel}css/area.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>\n` : ""}</head>
<body>
<header class="area-bar">
  <a class="brand" href="${home(rel)}"><img src="${rel}icon.svg" alt="" width="22" height="22">旅さき</a>
  <a class="bar-link" href="${rel}areas/index.html">エリアから探す</a>
</header>
<main class="area">
${body}
</main>
<footer class="area-foot">
  <p>収録データ: 国土数値情報・OpenStreetMap・Wikipedia ほか（出典は<a href="${rel}credits.html">著作権表記</a>のページにまとめています）。営業時間や料金は変わることがあります。お出かけ前に公式の情報をご確認ください。</p>
  <p><a href="${home(rel)}">旅さき</a> — 行きたいことから旅程をつくる・<a href="${rel}about.html">旅さきとは</a></p>
</footer>
</body>
</html>
`;
}

function spotList(spots) {
  if (!spots.length) return "";
  return `<ul class="spots">
${spots.map((s) => {
    const desc = readableDescription(s);
    return `  <li>${spotIcon(s)}<span class="sp-name">${esc(s.name)}</span>`
      + `<span class="sp-meta">${esc(s.category ?? "")}`
      + `${s.fame_tier ? `・${esc(TIER_LABEL[s.fame_tier] ?? "")}` : ""}</span>`
      + (desc ? `<span class="sp-desc">${esc(desc)}</span>` : "")
      + "</li>";
  }).join("\n")}
</ul>`;
}

function promptLinks(rel, prompts) {
  return `<ul class="prompts">
${prompts.map((p) => `  <li><a class="cta" href="${esc(appLink(rel, p))}">「${esc(p)}」で旅程をつくる</a></li>`).join("\n")}
</ul>`;
}

/** モデルコース（その日の行）。旅程が組めなかったときは null。 */
export function courseItems(itin) {
  const day = itin?.days?.[0];
  if (!day?.items?.length) return null;
  const out = [];
  for (const it of day.items) {
    const minutes = Math.round((new Date(it.end) - new Date(it.start)) / 60000);
    if (it.kind === "spot") {
      out.push({ kind: "spot", time: fmtTime(it.start), minutes, title: it.title,
                 text: readableDescription(it.place), category: it.place?.category ?? "",
                 icon: spotIcon(it.place ?? {}) });
    } else if (it.kind === "transit") {
      out.push({ kind: "move", time: fmtTime(it.start), minutes, title: "移動" });
    } else if (it.kind === "meal") {
      out.push({ kind: "meal", time: fmtTime(it.start), minutes, title: it.title || "食事" });
    } else if (it.kind === "free") {
      out.push({ kind: "free", time: fmtTime(it.start), minutes, title: "自由時間" });
    }
  }
  if (!out.some((x) => x.kind === "spot")) return null;
  // 最後の行は、どこに何時に着いて終わるのか。移動の行で終わると、
  // 帰りの電車に乗ったまま旅程が切れたように読めます。
  const last = day.items.at(-1);
  const where = last.kind === "transit" ? last.to?.name : "";
  out.push({ kind: "end", time: fmtTime(last.end), minutes: 0,
             title: where ? `${where}着・解散` : "解散" });
  return out;
}

/** モデルコースで寄る場所の id（順番どおり、重なりなし）。 */
export function courseSpotIds(itin) {
  const ids = (itin?.days?.[0]?.items ?? [])
    .filter((i) => i.kind === "spot").map((i) => i.spotId ?? i.place?.id).filter(Boolean);
  return [...new Set(ids)];
}

function courseHtml(items) {
  return `<ol class="course">
${items.map((x) => `  <li class="c-${x.kind}"><b class="c-time">${esc(x.time)}</b>`
    + `<span class="c-title">${x.icon ?? ""}${esc(x.title)}${x.kind === "move" ? `（約${x.minutes}分・目安）`
      : x.kind === "end" ? "" : `<small>${x.minutes}分</small>`}</span>`
    + (x.text ? `<span class="c-text">${esc(x.text)}</span>` : "")
    + "</li>").join("\n")}
</ol>`;
}

/** 同じ県のほかのエリア。エリアのページどうしを行き来できるようにします。 */
function siblingLinks(region, siblings) {
  const others = (siblings ?? []).filter((r) => r.id !== region.id);
  if (!others.length) return "";
  return `<section>
<h2>同じ県のほかのエリア</h2>
<ul class="regions">
${others.map((r) => `  <li><a href="${esc(r.id)}.html"><b>${esc(r.name)}</b>${r.tagline ? `<span>${esc(r.tagline)}</span>` : ""}</a></li>`).join("\n")}
</ul>
</section>`;
}

/**
 * 説明文に入れる場所の名前（重なりなし・先頭から n 件）。
 *
 * 説明文は検索結果の見出しの下に出ます。どのページも「〇〇（県）を駅から
 * 1日でまわるモデルコース」の型だけだと、どれも同じに読め、Google が
 * ページの本文から勝手に抜き出した文に差し替えることもあります。
 * 実際に寄る場所・有名な場所の名前を入れると、ページごとに違う文になり、
 * 「長谷寺 鎌倉大仏 1日」のように場所の名前で探した人にも内容が伝わります。
 */
export function nameList(names, n = 3) {
  return [...new Set(names.filter(Boolean))].slice(0, n).join("・");
}

export function renderRegionPage({ region, prefName, prefSlug, spots, course, date, base,
                                   siblings = [] }) {
  const rel = "../../";
  const canonical = `${base}areas/${prefSlug}/${region.id}.html`;
  // 同じ浜が「江之浦海水浴場」と「市営江之浦海水浴場」の2件で並んでいました。
  // 別名は1つにします（分類の数は絞りません。エリアの一覧は分類で選ぶ欄ではありません）。
  const list = pickDistinct([...nearbySpots(region, spots)].sort(byFameThenGem), REGION_SPOTS, [],
    Infinity);
  const items = course ? courseItems(course) : null;
  // コースが組めなかったページに「モデルコース」と書くと、検索から来た人が
  // 探しても無いものを約束することになります。
  const title = items
    ? `${region.name}の1日モデルコースと観光地｜旅行プラン作成｜旅さき`
    : `${region.name}の観光地と1日の旅行プラン｜旅さき`;
  // 寄る順ではなく、よく知られた順に（鎌倉なら駅ビルより長谷寺と大仏）。
  const stops = items ? nameList((course.days?.[0]?.items ?? []).filter((i) => i.kind === "spot")
    .map((i) => ({ name: i.title, fame_score: i.place?.fame_score })).sort(byFame).map((x) => x.name)) : "";
  const famous = nameList(list.map((s) => s.name));
  const description = (stops
    ? `${region.name}（${prefName}）を${region.station ?? "駅"}から1日で、${stops}とまわるモデルコース。`
    : `${region.name}（${prefName}）の観光地${famous ? `（${famous}など）` : ""}と1日の旅程づくり。`)
    + (region.tagline ? `${region.tagline}。` : "")
    + "行きたいことを書くと、営業時間と移動時間まで合わせた旅行プランを作成できます。";
  const body = `<nav class="crumbs" aria-label="現在地"><a href="${home(rel)}">旅さき</a> › <a href="${rel}areas/index.html">エリア</a> › <a href="${rel}areas/${prefSlug}/index.html">${esc(prefName)}</a> › ${esc(region.name)}</nav>
<h1>${esc(region.name)}</h1>
${region.tagline ? `<p class="lead">${esc(region.tagline)}</p>` : ""}
${region.description ? `<p>${esc(region.description)}</p>` : ""}
${items ? `<section>
<h2>1日のモデルコース</h2>
<p class="fine">${esc(fmtDate(date))}に${esc(region.station ?? "")}を9:00に出て、18:00までに戻る例です。旅さきのエンジンで組んでいます。移動時間は距離からの目安で、実際の便ではありません。</p>
${courseHtml(items)}
<p><a class="cta primary" href="${esc(courseLink(rel, `${region.name}を1日でめぐる`, region.id, courseSpotIds(course)))}">このコースを旅さきで開く</a></p>
<p class="fine">コースの場所を「必ず行く」に入れて開きます。日付や出発地を変えて、自分の旅程に組み直せます。</p>
</section>` : ""}
<section>
<h2>こんな旅もつくれます</h2>
${promptLinks(rel, examplePrompts(region))}
</section>
<section>
<h2>${esc(region.name)}の観光地</h2>
${spotList(list)}
</section>
${siblingLinks(region, siblings)}
<p><a href="${rel}areas/${prefSlug}/index.html">${esc(prefName)}の観光地の一覧へ</a></p>`;
  const destination = {
    "@type": "TouristDestination",
    name: region.name,
    description: region.description || region.tagline || undefined,
    geo: Number.isFinite(region.lat)
      ? { "@type": "GeoCoordinates", latitude: region.lat, longitude: region.lng } : undefined,
    containedInPlace: { "@type": "AdministrativeArea", name: prefName },
    includesAttraction: list.slice(0, 12).map((s) => ({
      "@type": "TouristAttraction", name: s.name,
      ...(Number.isFinite(s.lat) ? { geo: { "@type": "GeoCoordinates", latitude: s.lat, longitude: s.lng } } : {}),
    })),
    url: canonical,
  };
  const jsonLd = { "@context": "https://schema.org", "@graph": [destination, breadcrumbLd([
    { name: "旅さき", url: base },
    { name: "エリア", url: `${base}areas/index.html` },
    { name: prefName, url: `${base}areas/${prefSlug}/index.html` },
    { name: region.name, url: canonical },
  ])] };
  const image = { path: `areas/${prefSlug}/${region.id}.png`,
                  alt: `${region.name}（${prefName}）の場所を示す地図` };
  return { path: `areas/${prefSlug}/${region.id}.html`, url: canonical, image: image.path,
           html: page({ title, description, canonical, rel, body, jsonLd, image }) };
}

export function renderPrefPage({ prefName, prefSlug, spots, regions, base, count = spots.length }) {
  const rel = "../../";
  const canonical = `${base}areas/${prefSlug}/index.html`;
  const { major, hidden } = pickPrefSpots(spots, prefName);
  const title = `${prefName}の観光地・定番と穴場｜旅行プラン作成｜旅さき`;
  const famous = nameList(major.map((s) => s.name));
  const description = `${prefName}の観光地。${famous ? `${famous}などの定番と、` : "定番と、"}`
    + `知る人ぞ知る穴場。収録${count.toLocaleString("ja-JP")}か所から、`
    + "行きたいことに合わせて旅行プランを作成できます。";
  const body = `<nav class="crumbs" aria-label="現在地"><a href="${home(rel)}">旅さき</a> › <a href="${rel}areas/index.html">エリア</a> › ${esc(prefName)}</nav>
<h1>${esc(prefName)}の観光地</h1>
<p class="lead">収録 ${count.toLocaleString("ja-JP")} か所。定番だけでなく、知る人ぞ知る場所も混ぜて旅程を組めます。</p>
<p><a class="cta primary" href="${esc(appLink(rel, `${prefName}で、定番と穴場をまぜて1日まわる`))}">${esc(prefName)}で旅程をつくる</a></p>
${regions.length ? `<section>
<h2>エリアのモデルコース</h2>
<ul class="regions">
${regions.map((r) => `  <li><a href="${esc(r.id)}.html"><b>${esc(r.name)}</b>${r.tagline ? `<span>${esc(r.tagline)}</span>` : ""}</a></li>`).join("\n")}
</ul>
</section>` : ""}
${major.length ? `<section>
<h2>${esc(prefName)}の定番・主な観光地</h2>
${spotList(major)}
</section>` : ""}
${hidden.length ? `<section>
<h2>${esc(prefName)}の穴場</h2>
${spotList(hidden)}
</section>` : ""}`;
  const jsonLd = { "@context": "https://schema.org", "@graph": [{
    "@type": "TouristDestination",
    name: prefName,
    description,
    includesAttraction: major.map((s) => ({
      "@type": "TouristAttraction", name: s.name,
      ...(Number.isFinite(s.lat) ? { geo: { "@type": "GeoCoordinates", latitude: s.lat, longitude: s.lng } } : {}),
    })),
    url: canonical,
  }, breadcrumbLd([
    { name: "旅さき", url: base },
    { name: "エリア", url: `${base}areas/index.html` },
    { name: prefName, url: canonical },
  ])] };
  const image = { path: `areas/${prefSlug}/index.png`, alt: `${prefName}の場所と観光地の分布を示す地図` };
  return { path: `areas/${prefSlug}/index.html`, url: canonical, image: image.path,
           html: page({ title, description, canonical, rel, body, jsonLd, image }) };
}

/**
 * 地方の分け方。エリアの一覧に 47 の県を1列で並べていたのを、地方ごとの
 * 見出しで区切ります。読む人が自分の行き先を探しやすく、検索エンジンにも
 * 「関東の観光地」のようなまとまりが見出しで伝わります。
 */
const CHIHO = [
  ["北海道・東北", ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"]],
  ["関東", ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"]],
  ["中部", ["新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県"]],
  ["近畿", ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"]],
  ["中国・四国", ["鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県"]],
  ["九州・沖縄", ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"]],
];

/** 県の並びを地方ごとに分けます。どの地方にも無い名前は「その他」に入れます（落としません）。 */
export function groupByChiho(prefs) {
  const out = CHIHO.map(([chiho, names]) => ({
    chiho, list: names.map((n) => prefs.find((p) => p.name === n)).filter(Boolean),
  }));
  const known = new Set(CHIHO.flatMap(([, names]) => names));
  const rest = prefs.filter((p) => !known.has(p.name));
  if (rest.length) out.push({ chiho: "その他", list: rest });
  return out.filter((g) => g.list.length);
}

export function renderIndexPage({ prefs, base, total = null }) {
  const rel = "../";
  const canonical = `${base}areas/index.html`;
  const title = "エリアから探す — 都道府県の観光地と旅行プランのモデルコース｜旅さき";
  const description = "47都道府県の定番の観光地と穴場、主なエリアの1日モデルコース。"
    + "行きたいことを書くと、旅さきが営業時間と移動時間まで合わせた旅行プランを作成します。";
  const body = `<nav class="crumbs" aria-label="現在地"><a href="${home(rel)}">旅さき</a> › エリア</nav>
<h1>エリアから探す</h1>
<p class="lead">${total !== null ? `全国の収録 ${total.toLocaleString("ja-JP")} か所。` : ""}都道府県を選ぶと、定番と穴場、主なエリアのモデルコースが見られます。</p>
${groupByChiho(prefs).map(({ chiho, list }) => `<section>
<h2>${esc(chiho)}</h2>
<ul class="prefs">
${list.map((p) => `  <li><a href="${esc(p.slug)}/index.html"><b>${esc(p.name)}</b>`
    + `<span>${p.count.toLocaleString("ja-JP")}か所${p.regions.length ? `・${p.regions.map((r) => esc(r.name)).join("・")}` : ""}</span></a></li>`).join("\n")}
</ul>
</section>`).join("\n")}`;
  const jsonLd = { "@context": "https://schema.org", ...breadcrumbLd([
    { name: "旅さき", url: base },
    { name: "エリア", url: canonical },
  ]) };
  return { path: "areas/index.html", url: canonical,
           html: page({ title, description, canonical, rel, body, jsonLd }) };
}

/**
 * 公開URLの下に無いページを開いたときに出る 404.html。
 *
 * Cloudflare（wrangler.jsonc の not_found_handling）と PHP 版（.htaccess の
 * ErrorDocument）は、無い URL にはこのファイルを（その URL のまま）返します。
 * どの深さで出ても崩れないよう、リンクとスタイルは根（/）から書きます。
 * 公開URLを丸ごと書くと、PHP 版（別のホスト）ではスタイルが CSP で
 * 止まって崩れます。検索結果には載せません（noindex）。
 */
export function renderNotFoundPage({ prefs, base }) {
  const root = "/";
  const title = "ページが見つかりません｜旅さき";
  const description = "お探しのページは見つかりませんでした。旅さきのトップか、エリアの一覧からお探しください。";
  const body = `<h1>ページが見つかりません</h1>
<p class="lead">お探しのページは、移動したか、無くなったようです。</p>
<p><a class="cta primary" href="${root}app">旅さきで旅程をつくる</a></p>
<p><a class="cta" href="${root}areas/index.html">エリアから探す</a></p>
${prefs.length ? `<section>
<h2>都道府県から探す</h2>
<ul class="prefs">
${prefs.map((p) => `  <li><a href="${root}areas/${esc(p.slug)}/index.html"><b>${esc(p.name)}</b></a></li>`).join("\n")}
</ul>
</section>` : ""}`;
  return { path: "404.html", url: null,
           html: page({ title, description, rel: root, origin: base, body, noindex: true }) };
}

/**
 * sitemap.xml。`entries` は URL か `{ url, lastmod }` です。
 *
 * lastmod は「そのページの中身が最後に変わった日」です。全部を作った日に
 * すると、検索エンジンは lastmod を当てにならないものとして無視します
 * （公開のたびに全ページが「今日変わった」ことになるので）。
 * 日の分からないものだけ `date`（作った日）にします。トップ（base）は
 * `rootLastmod` です。
 */
export function sitemapXml(base, entries, date, { rootLastmod = null } = {}) {
  const fallback = date.toISOString().slice(0, 10);
  const row = (loc, day, pri) => `  <url>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${esc(day ?? fallback)}</lastmod>\n    <priority>${pri}</priority>\n  </url>`;
  const rows = entries.map((e) => (typeof e === "string" ? { url: e } : e))
    .map(({ url, lastmod }) => row(url, lastmod, /(areas\/index|about)\.html$/.test(url) ? "0.8" : "0.6"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- tools/build_area_pages.mjs が公開のたびに作ります。手で直さないでください。 -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[row(base, rootLastmod, "1.0"), ...rows].join("\n")}
</urlset>
`;
}

/** `YYYY-MM-DD` の中でいちばん新しいもの（無ければ null）。 */
export function latestDay(days) {
  const ok = days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ""));
  return ok.length ? ok.sort().at(-1) : null;
}

/**
 * kb/ の各ファイルが最後に変わった日（git の記録から）。
 *
 * 県とエリアのページは、その県の収録（spots-jpNN-*.json）から作るので、
 * その日を lastmod にします。浅い clone では全ファイルが同じ1件の記録の
 * 日になってしまうので、そのときは何も返しません（作った日になります）。
 * 公開の作業（Cloudflare の Workers Builds）では履歴が浅いことがあり、そのときは同じ日付になります。
 */
export function gitDays(root, files) {
  const days = new Map();
  try {
    const run = (args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (run(["rev-parse", "--is-shallow-repository"]) !== "false") return days;
    for (const f of files) {
      const day = run(["log", "-1", "--format=%cs", "--", f]);
      if (day) days.set(f, day);
    }
  } catch { /* git の無いところでは、作った日にします */ }
  return days;
}

/**
 * そのエリアのモデルコースとして出してよいか。
 *
 * 公開のページには、直す人がいません。おかしな旅程は出さずに、
 * 観光地の一覧だけのページにします。
 *   ・違うエリアへ行ってしまった（立ち寄りがよそのエリアのもの）
 *   ・必ず入れた3か所のうち、2か所以上が抜けた
 */
export function courseFits(itin, region, mustIds = []) {
  if (!itin || itin.regionId !== region.id) return false;
  const spots = (itin.days?.[0]?.items ?? []).filter((i) => i.kind === "spot");
  if (!spots.length) return false;
  if (spots.some((i) => i.place?.regionId && i.place.regionId !== region.id)) return false;
  const got = new Set(spots.map((i) => i.spotId ?? i.place?.id));
  const kept = mustIds.filter((id) => got.has(id)).length;
  return mustIds.length === 0 || kept >= Math.min(2, mustIds.length);
}

/**
 * ページに書く件数。**kb/index.json の counts と shards[].count だけから**引きます。
 *
 * エリアの一覧（都道府県の合計）・県のページ・アプリ・README が、それぞれ
 * 別の経路で数えていて、合計が kb/index.json と102件ずれていたことがあります。
 * 数字の出どころを1つにし、それが収録の中身と合わないときは公開を止めます
 * （tools/drop_not_spots.mjs や tools/reshard_kb.py が書き直し忘れた、ということです）。
 *
 * @returns {{perFile: Map<string, number>, total: number|null}}
 */
export function kbCounts(index, shards) {
  const perFile = new Map();
  let sum = 0;
  for (const sh of index?.shards ?? []) {
    const actual = shards?.get(sh.file)?.length ?? 0;
    const n = Number.isFinite(sh.count) ? sh.count : actual;
    if (n !== actual) {
      throw new Error(`kb/index.json の ${sh.file} は ${n}件ですが、中身は ${actual}件です`);
    }
    perFile.set(sh.file, n);
    sum += n;
  }
  const total = Number.isFinite(index?.counts?.spots) ? index.counts.spots : null;
  if (total !== null && total !== sum) {
    throw new Error(`kb/index.json の counts.spots は ${total}件ですが、県ごとの合計は ${sum}件です`);
  }
  return { perFile, total };
}

/** 名所として紹介できるエリア（説明を持つもの）。機械で作ったエリア名は「村」などで、見出しに使えません。 */
export function curatedRegions(regions) {
  return (regions ?? []).filter((r) => r?.tagline && r?.description && r?.station);
}

/**
 * 紹介ページ（about.html）。
 *
 * アプリのトップは画面を JavaScript で描くので、検索エンジンにも、
 * 人に「これ何？」と聞かれて渡すリンクとしても、読める本文がほとんど
 * ありません。何ができるのか・どう組むのか・実際に組んだ例を、
 * 1ページにまとめます。例は**このビルドでエンジンが組んだ本物の
 * コース**です（作り話の画面写真は載せません）。
 *
 * `featured` はモデルコースの組めたエリア（{ region, prefName, prefSlug, items, course }）。
 */
const FEATURED_ORDER = ["hakone", "kamakura", "kyoto-higashiyama", "kanazawa", "nikko",
  "miyajima", "takayama", "nara", "beppu", "hakodate", "kawagoe", "naoshima"];
const FEATURED_MAX = 8;

export function pickFeatured(withCourse) {
  const rank = (r) => {
    const i = FEATURED_ORDER.indexOf(r.region.id);
    return i < 0 ? FEATURED_ORDER.length : i;
  };
  return [...withCourse].sort((a, b) => rank(a) - rank(b)).slice(0, FEATURED_MAX);
}

export function renderIntroPage({ base, featured = [], prefCount = 0, spotCount = 0, date = null }) {
  const rel = "";
  const canonical = `${base}about.html`;
  const title = "旅さきとは｜行きたいことから旅行プランを作成するAI旅程アプリ";
  const description = "「温泉と海をゆっくり」と書くだけで、行き先・まわる順・移動時間まで組んだ旅程が届く無料のウェブアプリ。"
    + `全国${prefCount}都道府県・${spotCount.toLocaleString("ja-JP")}か所の観光地から、営業時間と移動時間を照らし合わせて組みます。`;
  const sample = featured[0] ?? null;
  const body = `<nav class="crumbs" aria-label="現在地"><a href="${home(rel)}">旅さき</a> › 旅さきとは</nav>
<div class="hero">
<h1><span class="nw">行きたい、を</span><span class="nw">書くだけで</span><span class="nw">そのまま行ける</span><span class="nw">旅程に。</span></h1>
<p class="lead">旅さきは、「温泉と海をゆっくり楽しみたい」のように行きたいことを書くと、行き先・まわる順・移動時間まで組んだ旅行プランを作る、無料のウェブアプリです。行き先がまだ決まっていなくても始められます。</p>
<p><a class="cta primary" href="${rel}app">旅さきで旅程をつくる</a></p>
<p class="fine">登録は要りません。ブラウザで開くだけで使えます。</p>
</div>
<section>
<h2>3つの手順で、1日の旅が決まります</h2>
<ol class="steps">
  <li><b>行きたいことを書く</b><span>「子どもと海で遊びたい」「古い町並みを歩いて、夜は温泉」など、ふだんのことばで大丈夫です。出発地と日時は＋から足せます。</span></li>
  <li><b>旅さきが組む</b><span>全国の観光地から行き先を選び、営業時間・定休日と、駅や停留所のあいだの移動時間を照らし合わせて、無理のない順に並べます。</span></li>
  <li><b>話しかけて直す</b><span>「もっとゆっくり」「昼は海鮮で」と続けて書けば、その場で組み直します。気に入った旅程は共有もできます。</span></li>
</ol>
</section>
<section>
<h2>ほかの旅行サイトとちがうところ</h2>
<ul class="points">
  <li><b>着いたら閉まっていた、を減らす</b><span>寄る時刻にその場所が開いているかを、営業時間と定休日で確かめてから旅程に入れます。</span></li>
  <li><b>定番と穴場をまぜる</b><span>有名な場所だけを並べず、地元で知られた場所や静かな穴場も混ぜて組みます。</span></li>
  <li><b>行き先から決めてくれる</b><span>「どこへ行くか」から相談できます。決まっているなら、行きたい場所を「必ず行く」に入れるだけです。</span></li>
  <li><b>現在地は送らない</b><span>現在地は、いちばん近い駅を出発地に入れるためだけに、端末の中で使います。</span></li>
</ul>
</section>
${sample ? `<section>
<h2>実際に組んだ例: ${esc(sample.region.name)}の1日</h2>
<p class="fine">${date ? `${esc(fmtDate(date))}に` : ""}${esc(sample.region.station ?? "")}を9:00に出て、18:00までに戻る旅程を、旅さきのエンジンで組んだものです。移動時間は距離からの目安です。</p>
${courseHtml(sample.items)}
<p><a class="cta" href="${esc(`${rel}areas/${sample.prefSlug}/${sample.region.id}.html`)}">${esc(sample.region.name)}のモデルコースと観光地を見る</a></p>
</section>` : ""}
${featured.length ? `<section>
<h2>人気のエリアのモデルコース</h2>
<ul class="regions">
${featured.map((f) => `  <li><a href="${esc(`${rel}areas/${f.prefSlug}/${f.region.id}.html`)}"><b>${esc(f.region.name)}（${esc(f.prefName)}）</b>${f.region.tagline ? `<span>${esc(f.region.tagline)}</span>` : ""}</a></li>`).join("\n")}
</ul>
<p><a href="${rel}areas/index.html">47都道府県の観光地とモデルコースの一覧へ</a></p>
</section>` : ""}
<section>
<h2>よくある質問</h2>
<dl class="faq">
  <dt>お金はかかりますか？</dt>
  <dd>かかりません。登録もなしで使えます。</dd>
  <dt>行き先が決まっていなくても使えますか？</dt>
  <dd>使えます。「関東から日帰りで、紅葉と温泉」のように書けば、行き先の候補から選んで組みます。</dd>
  <dt>泊まりがけの旅行も組めますか？</dt>
  <dd>組めます。日数を足すと、複数日の旅程になります。</dd>
  <dt>電車やバスの時刻は正確ですか？</dt>
  <dd>経路検索につながっているときは実際の便から、つながらないときは距離からの目安で組みます。目安のときは画面にそう出します。お出かけ前に、時刻表と各施設の公式の情報もご確認ください。</dd>
</dl>
</section>
<p><a class="cta primary" href="${rel}app">旅さきで旅程をつくる</a></p>`;
  const jsonLd = { "@context": "https://schema.org", "@graph": [
    { "@type": "AboutPage", name: title, url: canonical, inLanguage: "ja",
      about: { "@type": "WebApplication", name: "旅さき", url: base,
               applicationCategory: "TravelApplication", operatingSystem: "Web",
               offers: { "@type": "Offer", price: "0", priceCurrency: "JPY" } } },
    breadcrumbLd([{ name: "旅さき", url: base }, { name: "旅さきとは", url: canonical }]),
  ] };
  return { path: "about.html", url: canonical,
           html: page({ title, description, canonical, rel, body, jsonLd }) };
}

/**
 * 全ページを作ります。
 *
 * @param {{index:object, regions:object[], shards:Map<string,object[]>}} kbDoc
 * `updated` は kb/ のファイル名 → 最後に変わった日（`YYYY-MM-DD`）、
 * `siteUpdated` はアプリのトップが最後に変わった日です（sitemap の lastmod）。
 *
 * @param {{base:string, now:Date, planCourse?:(region)=>Promise<object|null>,
 *          updated?:Map<string,string>, siteUpdated?:string|null}} opts
 */
export async function buildAll(kbDoc, { base, now = new Date(), planCourse = null,
                                        updated = new Map(), siteUpdated = null } = {}) {
  const date = nextSaturday(now);
  const counts = kbCounts(kbDoc.index, kbDoc.shards);
  const regions = curatedRegions(kbDoc.regions);
  const pages = [];
  const prefs = [];
  const withCourse = [];
  for (const shard of kbDoc.index.shards ?? []) {
    const slug = shardSlug(shard.file);
    if (!slug) continue;
    const spots = kbDoc.shards.get(shard.file) ?? [];
    const prefName = shard.prefecture;
    const mine = regions.filter((r) => r.prefecture === prefName);
    prefs.push({ name: prefName, slug, count: spots.length, regions: mine });
    const lastmod = updated.get(shard.file) ?? null;
    pages.push({ ...renderPrefPage({ prefName, prefSlug: slug, spots, regions: mine, base }),
                 lastmod, card: { shard: shard.file } });
    for (const region of mine) {
      const own = spots.filter((s) => s.regionId === region.id);
      let course = null;
      if (planCourse) {
        try { course = await planCourse(region, date, own, spots); } catch { course = null; }
      }
      pages.push({ ...renderRegionPage({ region, prefName, prefSlug: slug, spots: own,
                                         course, date, base, siblings: mine }),
                   lastmod, card: { shard: shard.file, region } });
      const items = course ? courseItems(course) : null;
      if (items) withCourse.push({ region, prefName, prefSlug: slug, items, lastmod });
    }
  }
  // 一覧は、どこかの県が変わるか、エリアの分けかたが変わると変わります。
  const indexDay = latestDay([...updated.values()]);
  pages.unshift({ ...renderIndexPage({ prefs, base }), lastmod: indexDay });
  // 紹介ページは、アプリと収録のどちらが変わっても変わります。
  const featured = pickFeatured(withCourse);
  const intro = { ...renderIntroPage({ base, featured, date, prefCount: prefs.length,
                                       spotCount: prefs.reduce((n, p) => n + p.count, 0) }),
                  lastmod: latestDay([siteUpdated, ...featured.map((f) => f.lastmod)]) };
  const entries = [intro, ...pages].map((p) => ({ url: p.url, lastmod: p.lastmod }));
  return { pages, intro, notFound: renderNotFoundPage({ prefs, base }),
           sitemap: sitemapXml(base, entries, now, { rootLastmod: siteUpdated }) };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main(outDir) {
  const index = await readJson(join(ROOT, "kb/index.json"));
  const { regions } = await readJson(join(ROOT, "kb", index.regionsFile ?? "regions.json"));
  const shards = new Map();
  for (const s of index.shards ?? []) {
    shards.set(s.file, (await readJson(join(ROOT, "kb", s.file))).spots ?? []);
  }

  let base = DEFAULT_BASE;
  try {
    const xml = await readFile(join(ROOT, "sitemap.xml"), "utf8");
    base = /<loc>([^<]+)<\/loc>/.exec(xml)?.[1] ?? base;
  } catch { /* 既定のまま */ }
  if (!base.endsWith("/")) base += "/";

  // アプリのエンジンを、ブラウザの代わりにディスクから kb/ を読ませて動かします
  // （tools/plan_preview.mjs と同じ仕掛けです）。外へは出しません。
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes("/kb/") && !u.startsWith("file:")) throw new Error("network off");
    const path = u.startsWith("file:") ? new URL(u).pathname
      : join(ROOT, u.replace(/^.*\/kb\//, "kb/"));
    const body = await readFile(path, "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  const { loadKnowledgeBase } = await import(join(ROOT, "js/kb.js"));
  const { planTrip, dropSamePlace } = await import(join(ROOT, "js/pipeline.js"));
  const { makeTrip } = await import(join(ROOT, "js/trip.js"));
  const kb = await loadKnowledgeBase();

  const planCourse = async (region, date, own, prefSpots = []) => {
    const at = (h) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h);
    // そのエリアでいちばん知られた3か所は、必ず入れます。
    //
    // 入れないと、エンジンは「鎌倉を1日で」を鎌倉市ぜんたいの話として
    // 読み、大仏も八幡宮も無い旅程を組むことがあります（実際に組みました）。
    // アプリでは利用者が直せますが、モデルコースは直す人がいません。
    //
    // 収録のエリア分けは粗く、鎌倉のエリアに横須賀の記念艦三笠（12km 先）が
    // 入っていて、モデルコースが「移動 約79分」で三笠へ行っていました。
    // 中心から COURSE_RADIUS_KM より遠いものは「外す」に入れます。
    // （一覧の REGION_RADIUS_KM では狭すぎます。箱根の大涌谷や彫刻の森まで外れます）
    const radius = courseRadiusKm(region, own);
    // 名の通った場所（major）は、これまでの枠（10km）のままにします。
    // 伊勢の外宮・高知の桂浜・日光の華厳滝は、少し遠くても外せません。
    // 狭めた枠は、エリアの中心か、コースの起点の駅の、どちらかから測ります
    // （伊勢の外宮は、内宮寄りの中心からは遠くても、伊勢市駅のすぐ前です）。
    const station = { lat: region.stationLat, lng: region.stationLng };
    const far = new Set(own.filter((s) => isFar(region, s) || (s.fame_tier !== "major"
      && isFar(region, s, radius) && (!Number.isFinite(station.lat) || isFar(station, s, radius))))
      .map((s) => s.id));
    // 同じ県の別のエリア（機械で作った「松本市」など）の場所も外します。
    // 入ると「よそのエリアへ行った」として courseFits がコースごと捨てるので、
    // 松本のページは観光案内所に寄るコースが組まれて、コースが出ていませんでした。
    // 近いものだけを外していたころは、宮島のコースが広島市内の縮景園へ、
    // 出雲のコースが隣の市の窯元へ寄り、やはりコースが出ていませんでした
    // （宮島・出雲・富士山・鳴門・那須の5ページ）。遠くても外します。
    const neighbors = prefSpots
      .filter((s) => s.regionId && s.regionId !== region.id).map((s) => s.id);
    // 必ず入れる3か所は、互いに離れたものから選びます。旅程は120m 以内の
    // 2か所を同じ場所として1つにまとめるので、佐原の「小野川沿いの町並み」と
    // 川沿いの伊能忠敬記念館を両方入れると、片方が消えてコースが出ません。
    const mustIds = dropSamePlace(own.filter((s) => !far.has(s.id)).sort(byFame))
      .slice(0, 3).map((s) => s.id);
    const itin = await planTrip({ kb, trip: makeTrip({
      must: { spotIds: mustIds, avoidSpotIds: [...far, ...neighbors] },
      origin: { name: region.station, lat: region.stationLat, lng: region.stationLng },
      departAt: at(9), arriveBy: at(18),
      note: `${region.name}を1日でめぐる`, interests: [],
      dayStartHour: 9, dayEndHour: 18,
    }) });
    return courseFits(itin, region, mustIds) ? itin : null;
  };

  const kbFiles = [...(index.shards ?? []).map((s) => s.file), index.regionsFile ?? "regions.json"];
  const days = gitDays(ROOT, kbFiles.map((f) => `kb/${f}`));
  const updated = new Map(kbFiles.filter((f) => days.has(`kb/${f}`)).map((f) => [f, days.get(`kb/${f}`)]));
  // トップ（アプリ）の日は、アプリを作っているファイルが最後に変わった日です。
  const siteUpdated = latestDay([...gitDays(ROOT, ["index.html", "js", "css"]).values()]);

  const { pages, intro, notFound, sitemap } = await buildAll({ index, regions, shards },
    { base, now: new Date(), planCourse, updated, siteUpdated });
  for (const p of [...pages, intro, notFound]) {
    const file = join(outDir, p.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, p.html);
  }
  // 共有カード（og:image）。収録の点で描いた地図です（tools/area_card.mjs）。
  const all = [...shards.values()].flat();
  for (const p of pages) {
    if (!p.card || !p.image) continue;
    const pref = shards.get(p.card.shard) ?? [];
    const region = p.card.region ?? null;
    const png = renderAreaCard({ all, pref, region,
                                 regionSpots: region ? pref.filter((s) => s.regionId === region.id) : [] });
    await writeFile(join(outDir, p.image), png);
  }
  await writeFile(join(outDir, "sitemap.xml"), sitemap);
  const withCourse = pages.filter((p) => p.html.includes('class="course"')).length;
  console.log(`areas: ${pages.length}ページ（モデルコース ${withCourse}件）→ ${outDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) {
    console.error("使いかた: node tools/build_area_pages.mjs <出力先>");
    process.exit(2);
  }
  await main(out);
}
