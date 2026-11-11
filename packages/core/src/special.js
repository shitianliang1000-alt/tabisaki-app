// 特殊な旅程（Issue #442）。
//
// 「青春18きっぷで」「寝台列車に乗りたい」「世界遺産を全部回りたい」のような
// 要望は、行き先の希望ではなく**旅の形**の指定です。いつもの流れ（pipeline.js）は
// 「希望の語に合うスポットを、近い順・点の高い順に選ぶ」ので、そのまま渡すと
//
//   ・「寝台」「秘境駅」を説明文に含むスポットは無く、近場の名所が出る
//   ・「世界遺産を全部」が、近くの世界遺産1つで終わる
//   ・「県庁所在地を踏破」で、県庁の展望ロビーが1つ選ばれる
//
// ことになります。ここでは、まず**どの形か**を読み取り（detectSpecial）、
// 形ごとの処理（ハンドラ）へ振り分けます。
//
//   形              何を返すか
//   ─────────────── ─────────────────────────────────────────
//   longest_ticket   最長片道・往復切符。経路は専用ソルバー（#431）に任せる
//   japan_loop       日本一周・縦断・横断。journeys.js の道すじで組む
//   cruise           船旅。出発地に近い長距離フェリーを選び、着いた先で組む
//   seishun18        青春18きっぷ。普通列車だけ・使える時期・1日の移動の目安
//   sleeper          寝台列車。サンライズ瀬戸・出雲で着いた朝から組む
//   haisen           廃線跡。収録の廃線跡から、届く範囲のものを選ぶ
//   hikyo_station    秘境駅。名の知れた秘境駅と、その近くの名所で組む
//   edges            日本の端（最北端・四極）。岬そのものを必ず立ち寄るにする
//   world_heritage   世界遺産全制覇。26件を地方ごとの旅に分け、近い順に並べる
//   capitals         県庁所在地踏破。47都市を回る順に並べ、何回の旅に分けるか
//
// ハンドラは、旅程そのものは組みません。いつもの流れに渡す条件（request）と、
// 形ごとの決まりごと（rules）・全体の計画（legs）・注意（notes）を返します。
// 旅程は core.special()（packages/core/index.mjs）が組みます。
//
// 青春18きっぷと寝台列車は、ほかの形と一緒に書かれることがあります
// （「青春18きっぷで日本一周」）。そのときは乗り物の指定（modifiers）として
// 扱い、形は日本一周のほうにします。
//
// **時刻・運賃・運行日は持ちません。** 変わるものなので、「目安」と書き、
// 出かける前に確かめるよう添えます。

import { orderByRoute } from "./crowd.js";
import { travelMinutes } from "./geo.js";
import { straightKm } from "./providers.js";
import { findPlace } from "./places.js";
import { readJourney } from "./journeys.js";

// ---------------------------------------------------------------------------
//  見分けかた
// ---------------------------------------------------------------------------

// 「全部」「制覇」のような、集めきる旅を表す語。
const COLLECT = /全部|全て|すべて|ぜんぶ|全制覇|制覇|踏破|コンプ|網羅|全\s*[0-9０-９]+|回り(きり|切り|尽く)|巡り(きり|切り|尽く)|めぐり(きり|切り|尽く)/;

/**
 * 形の一覧。上から順に見ます。
 *   re       当たる書きかた
 *   not      当たっても、これがあれば外す書きかた（誤検出を防ぐ）
 *   need     これも書かれていないと当てない（「世界遺産」だけでは当てない）
 *   modifier ほかの形と一緒なら、乗り物の指定として扱うか
 */
export const SPECIAL_MODES = [
  {
    id: "longest_ticket", name: "最長片道切符",
    re: /最長(片道|往復)(切符|きっぷ|乗車券)?/,
  },
  {
    id: "japan_loop", name: "日本一周",
    re: /日本一周|日本(列島)?(縦断|横断)|列島(縦断|横断)|本州(縦断|横断)/,
  },
  {
    id: "world_heritage", name: "世界遺産全制覇",
    re: /世界(文化|自然)?遺産/,
    need: COLLECT,
  },
  {
    id: "capitals", name: "県庁所在地踏破",
    re: /県庁所在地|(47|４７|四十七)都道府県|全都道府県/,
    // 「47都道府県」は、集めきる語があるときだけ（「47都道府県の名物」は違う）。
    need: /県庁所在地|制覇|踏破|全部|すべて|全て|めぐ|巡|回/,
  },
  {
    id: "edges", name: "日本の端",
    re: /最(北|南|東|西)端|東西南北(の)?端|日本の(東西南北の)?端|四極/,
  },
  {
    id: "hikyo_station", name: "秘境駅",
    re: /秘境駅/,
  },
  {
    id: "haisen", name: "廃線跡",
    re: /廃線|廃駅|鉄道(の)?(遺構|跡)|旧線跡/,
  },
  {
    id: "cruise", name: "船旅",
    re: /船旅|クルーズ(の旅|旅行|旅|船)|豪華客船|長距離フェリー|フェリー(で|の)(旅|旅行|めぐ|巡|回|行きたい)/,
    // 湾内の遊覧・川下りは、その土地の楽しみかたです（ふつうの旅程で組めます）。
    not: /ナイトクルーズ|遊覧|川下り|湾内|サンセットクルーズ|リバークルーズ/,
  },
  {
    id: "seishun18", name: "青春18きっぷ", modifier: true,
    re: /青春\s*(18|１８|十八)|(18|１８)きっぷ|じゅうはちきっぷ/,
  },
  {
    id: "sleeper", name: "寝台列車", modifier: true,
    re: /寝台(列車|特急|車)?|サンライズ(瀬戸|出雲)?|夜行列車|ブルートレイン/,
    // 夜行バス・寝台バスは列車ではありません。
    not: /寝台バス|夜行バス/,
  },
];

const BY_ID = new Map(SPECIAL_MODES.map((m) => [m.id, m]));

function hits(mode, s) {
  if (!mode.re.test(s)) return false;
  if (mode.not?.test(s) && !/船旅|豪華客船|長距離フェリー/.test(s)) return false;
  if (mode.need && !mode.need.test(s)) return false;
  return true;
}

/**
 * 希望文から、特殊な旅の形を読み取ります。
 * @returns {{mode: string, name: string, matched: string, modifiers: string[]} | null}
 */
export function detectSpecial(text) {
  const s = String(text ?? "").normalize("NFKC").slice(0, 500);
  if (!s.trim()) return null;
  const found = SPECIAL_MODES.filter((m) => hits(m, s));
  if (!found.length) return null;
  const shape = found.find((m) => !m.modifier);
  const main = shape ?? found[0];
  const modifiers = found.filter((m) => m !== main && m.modifier).map((m) => m.id);
  return { mode: main.id, name: main.name, matched: main.re.exec(s)[0], modifiers };
}

// ---------------------------------------------------------------------------
//  道具
// ---------------------------------------------------------------------------

/** 収録から、名前（と県）でスポットを1つ探します。完全一致を先に、知られたものを先に。 */
export function findSpot(kb, name, prefecture = null) {
  const spots = kb?.spots ?? [];
  const inPref = (s) => !prefecture || s.prefecture === prefecture;
  const rank = (a, b) => (b.fame_score ?? 0) - (a.fame_score ?? 0);
  const exact = spots.filter((s) => s.name === name && inPref(s)).sort(rank);
  if (exact.length) return exact[0];
  return spots.filter((s) => s.name.includes(name) && inPref(s)).sort(rank)[0] ?? null;
}

const brief = (s) => ({ id: s.id, name: s.name, prefecture: s.prefecture ?? "", lat: s.lat, lng: s.lng });

/** 県ごとの真ん中（収録のスポットの平均）。県の近さを測るのに使います。 */
function prefCenters(kb) {
  if (kb.__prefCenters) return kb.__prefCenters;
  const acc = new Map();
  for (const s of kb.spots ?? []) {
    if (!s.prefecture || !Number.isFinite(s.lat)) continue;
    const a = acc.get(s.prefecture) ?? { lat: 0, lng: 0, n: 0 };
    a.lat += s.lat; a.lng += s.lng; a.n++;
    acc.set(s.prefecture, a);
  }
  const out = new Map([...acc].map(([p, a]) => [p, { name: p, lat: a.lat / a.n, lng: a.lng / a.n }]));
  Object.defineProperty(kb, "__prefCenters", { value: out, enumerable: false });
  return out;
}

const addDays = (date, n) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""))) return date;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 地方（旅を分けるまとまり）。 */
const BLOCKS = [
  ["北海道", ["北海道"]],
  ["東北", ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"]],
  ["関東", ["茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県"]],
  ["中部", ["新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県"]],
  ["近畿", ["三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県"]],
  ["中国・四国", ["鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県"]],
  ["九州・沖縄", ["福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"]],
];
const blockOf = (pref) => BLOCKS.find(([, ps]) => ps.includes(pref))?.[0] ?? "その他";

const centroid = (pts) => ({
  lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
  lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length,
});

// ---------------------------------------------------------------------------
//  ハンドラ
// ---------------------------------------------------------------------------

/**
 * 最長片道・往復切符。経路は専用ソルバー（Issue #431）が出します。
 * ソルバーは solvers.longestTicket(kind, {from, origin}) → {route: 駅名[], km?, note?, legs?, proven?}。
 *
 *   from    希望文に「○○駅から」「○○発」と書かれた出発駅。書かれていなければ null
 *           （＝全国でいちばん長い経路。ふつう「最長片道切符」と言えば、これです）
 *   origin  旅の出発地（家の最寄りなど）。経路は変えません。参考に渡すだけです
 *
 * core.special() は、何も渡さなければ packages/core/longest-ticket.mjs のソルバー
 * （Rust の分枝限定法を WebAssembly にしたもの）を使います。ソルバーが無い・失敗した
 * ときは、全国を回る旅（journeys.js）として組み、経路は出さないと書きます。
 */
export function ticketStart(text) {
  const m = /([^\s、。，,．.「」『』（）()!！?？]{1,24}?)(?:駅)?(?:から|発(?![着車見表]))/.exec(String(text ?? "").normalize("NFKC"));
  if (!m) return null;
  // 「最長片道切符で札幌から」の「札幌」だけを採ります（助詞より後ろ）。
  const name = m[1].split(/[でをにはがへと]/).at(-1).replace(/駅$/, "");
  return name && !/最長|片道|往復|切符|きっぷ|乗車券|ここ|そこ|どこ|自宅|家|最寄/.test(name) ? name : null;
}

async function longestTicket(ctx) {
  const kind = /往復/.test(ctx.text) ? "round" : "oneway";
  const name = kind === "round" ? "最長往復切符" : "最長片道切符";
  const solver = ctx.solvers?.longestTicket;
  const base = { name, transport: "transit", rules: [
    "同じ駅を二度通らない（片道は、最後に通った駅へ戻って終わる形だけ認められます。往復は、同じ経路を引き返します）",
    "JRの線だけをたどる（運賃の計算の規則に沿う経路です）",
  ] };
  if (typeof solver === "function") {
    let solved = null;
    try {
      solved = await solver(kind, { from: ticketStart(ctx.text), origin: ctx.origin?.name ?? null });
    } catch (e) {
      ctx.notes.push(`経路を求める処理が失敗しました（${String(e?.message ?? e).slice(0, 60)}）。`);
    }
    const route = Array.isArray(solved?.route) ? solved.route.map(String).filter(Boolean) : [];
    if (route.length >= 2) {
      // 旅程に入れるのは、経路の中から間をあけて選んだ駅だけです（全部は1回の旅に入りません）。
      const n = Math.min(route.length, Math.max(2, ctx.days * 2));
      const stops = Array.from({ length: n }, (_, i) => route[Math.round(i * (route.length - 1) / (n - 1))]);
      return {
        ...base, status: "handled",
        route: {
          stations: route, km: Number.isFinite(solved.km) ? solved.km : null, solver: solved.solver ?? "longestTicket",
          ...(Array.isArray(solved.legs) ? { legs: solved.legs } : {}),
          ...(typeof solved.proven === "boolean" ? { proven: solved.proven } : {}),
        },
        request: { wish: `${[...new Set(stops.map((s) => s.replace(/駅$/, "")))].join("・")}をめぐる鉄道の旅` },
        notes: [`${name}の経路は${route[0]}から${route.at(-1)}まで${solved.km ? `約${Math.round(solved.km)}km` : ""}です。`
          + `${ctx.days}日では通しきれないので、経路の中から${n}か所を選んで組んでいます。`, ...(solved.note ? [solved.note] : [])],
      };
    }
  }
  return {
    ...base, status: "needs_solver",
    request: { wish: ctx.text },
    notes: [`${name}の正確な経路は、専用の計算（Issue #431 のソルバー）を使えなかったので出せません。`
      + "かわりに、全国を地方ごとに回る旅として組んでいます。"],
  };
}

/** 日本一周・縦断・横断。道すじは journeys.js が持っています。 */
async function japanLoop(ctx) {
  const j = readJourney(ctx.text);
  const name = j?.name ?? "日本一周";
  const notes = [];
  const need = name === "日本一周" ? 14 : name === "日本縦断" ? 7 : 3;
  if (ctx.days < need) {
    notes.push(`${name}を通しで回るには、少なくとも${need}日ほどかかります。`
      + `${ctx.days}日なので、${name === "日本一周" ? "いくつかの地方" : "道すじの一部"}だけを組んでいます。`);
  }
  return {
    name, status: "handled",
    journey: j ? { name: j.name, meaning: j.meaning, along: j.along, oneWay: j.oneWay } : null,
    stops: (j?.along ?? []).map((n) => ({ name: n })),
    request: { wish: ctx.text },
    rules: name === "日本一周" ? ["各地方を1つずつ回る（同じ地方に固めない）"] : ["片道で通す（出発地へは戻らない）"],
    notes,
  };
}

/**
 * 長距離フェリー。乗り場と着く先、着いてから組む出発地（arrive）と回る土地（area）。
 * 港の名前（苫小牧）をそのまま希望文にすると、「小牧」（愛知）に読まれるので、
 * 回る土地は別に持ちます。時間は目安です。
 */
export const FERRIES = [
  { name: "新日本海フェリー（舞鶴→小樽）", port: { name: "舞鶴港", lat: 35.47, lng: 135.39 }, to: "小樽", arrive: "札幌駅", area: "小樽と札幌", hours: 21 },
  { name: "太平洋フェリー（名古屋→仙台→苫小牧）", port: { name: "名古屋港", lat: 35.08, lng: 136.88 }, to: "苫小牧", arrive: "札幌駅", area: "札幌と小樽", hours: 40 },
  { name: "商船三井さんふらわあ（大洗→苫小牧）", port: { name: "大洗港", lat: 36.31, lng: 140.57 }, to: "苫小牧", arrive: "札幌駅", area: "札幌と小樽", hours: 18 },
  { name: "名門大洋フェリー（大阪南港→新門司）", port: { name: "大阪南港", lat: 34.63, lng: 135.41 }, to: "新門司", arrive: "小倉駅", area: "門司港と小倉", hours: 12 },
  { name: "さんふらわあ（大阪→別府）", port: { name: "大阪南港", lat: 34.63, lng: 135.41 }, to: "別府", arrive: "大分駅", area: "別府温泉", hours: 12 },
  { name: "東京九州フェリー（横須賀→新門司）", port: { name: "横須賀港", lat: 35.28, lng: 139.67 }, to: "新門司", arrive: "小倉駅", area: "門司港と小倉", hours: 21 },
];

/** 船旅。出発地に近い乗り場の長距離フェリーで行き、着いた先で組みます。 */
async function cruise(ctx) {
  const from = ctx.origin;
  const ranked = [...FERRIES].sort((a, b) => straightKm(from, a.port) - straightKm(from, b.port));
  // 行き先が書かれていれば、それに合う航路を先にします（「船で北海道へ」）。
  const wantNorth = /北海道|小樽|苫小牧|札幌/.test(ctx.text);
  const wantKyushu = /九州|別府|大分|門司|小倉|福岡/.test(ctx.text);
  const pick = ranked.find((f) => (wantNorth ? f.arrive === "札幌駅" : wantKyushu ? f.arrive !== "札幌駅" : true)) ?? ranked[0];
  // 夜に出て朝に着く船（〜14時間）は翌朝から、昼に着く船（〜18時間）は翌日の午後から、
  // それより長い船は次の次の朝から回ります。
  const nightsOnBoard = pick.hours <= 18 ? 1 : 2;
  const startAt = pick.hours <= 14 || pick.hours > 18 ? "09:00" : "14:00";
  const notes = [`${pick.port.name}から${pick.name.replace(/（.*$/, "")}に乗り、${pick.to}まで船で約${pick.hours}時間（目安）です。`
    + "船の中で夜を過ごすので、着いた日から現地を回る旅程にしています。"];
  const ground = ctx.days - nightsOnBoard;
  if (ground < 1) {
    notes.push(`${ctx.days}日では船を降りてから回る日が残りません。${nightsOnBoard + 1}日以上にしてください。`);
  }
  notes.push("大型客船の周遊クルーズは船会社の旅行商品なので、旅さきでは寄港地での過ごしかたを組みます。");
  return {
    name: "船旅", status: ground >= 1 ? "handled" : "partial",
    ferry: { name: pick.name, port: pick.port.name, to: pick.to, hours: pick.hours },
    alternatives: ranked.filter((f) => f !== pick).slice(0, 2).map((f) => f.name),
    request: ground >= 1 ? { wish: `${pick.area}を回る`, from: pick.arrive, days: Math.min(14, ground),
      date: addDays(ctx.date, nightsOnBoard), start: startAt } : null,
    rules: ["行きは船（夜を船の中で過ごす）", "着いた港の近くから回る"],
    notes,
  };
}

/** 青春18きっぷの使える時期（例年の目安）。月×100+日で持ちます。 */
const SEISHUN_SEASONS = [
  { name: "春", from: 301, to: 410 },
  { name: "夏", from: 720, to: 910 },
  { name: "冬", from: 1210, to: 110 },
];

export function seishunSeason(date) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(date ?? ""));
  if (!m) return null;
  const md = Number(m[1]) * 100 + Number(m[2]);
  return SEISHUN_SEASONS.find((s) => (s.from <= s.to ? md >= s.from && md <= s.to : md >= s.from || md <= s.to)) ?? null;
}

/** 青春18きっぷ。普通列車だけで、移動そのものを楽しむ旅として組みます。 */
async function seishun18(ctx) {
  const notes = [];
  const season = seishunSeason(ctx.date);
  if (ctx.date && !season) {
    notes.push("出発日は、青春18きっぷの例年の発売・利用期間（春・夏・冬の休みの時期）から外れています。"
      + "日付を確かめてください。");
  }
  if (![3, 5].includes(ctx.days)) {
    notes.push("青春18きっぷは、連続した3日間用か5日間用です（2024年の冬から）。"
      + `${ctx.days}日の旅なら、残りの日は別の切符になります。`);
  }
  notes.push("普通列車の1日の移動は、乗り継ぎを入れて8〜10時間・300〜500kmほどが目安です。");
  return {
    name: "青春18きっぷ", status: "handled", season: season?.name ?? null,
    request: { wish: ctx.text, transport: "local" },
    rules: ["JRの普通列車・快速だけ（新幹線・特急は乗れない）", "連続した日に使う", "移動も旅のうちとして、遠くへ行く"],
    notes,
  };
}

/** 定期運行の寝台特急（いまはサンライズ瀬戸・出雲だけ）。着く駅と、着いてから回り始める時刻の目安。 */
export const SLEEPERS = {
  seto: { name: "サンライズ瀬戸", to: "高松", arrive: "高松駅", start: "08:00", re: /瀬戸|高松|香川|四国|讃岐|うどん/ },
  izumo: { name: "サンライズ出雲", to: "出雲市", arrive: "松江駅", start: "09:30", re: /出雲|松江|島根|山陰|鳥取/ },
};

/** 寝台列車。東京を夜に出て、着いた朝から現地を回ります。 */
async function sleeper(ctx) {
  const which = SLEEPERS.seto.re.test(ctx.text) ? "seto" : "izumo";
  const s = SLEEPERS[which];
  const other = SLEEPERS[which === "seto" ? "izumo" : "seto"];
  const notes = [`1日目の夜（22時ごろ）に東京駅から${s.name}に乗り、翌朝${s.to}に着く旅として組んでいます（時刻は目安）。`];
  const tokyo = findPlace("東京駅");
  if (ctx.origin && tokyo && straightKm(ctx.origin, tokyo) > 120) {
    notes.push(`${s.name}は東京から西へ向かう列車です。まず東京駅（または横浜・静岡など途中の停車駅）まで出てください。`);
  }
  if (ctx.days < 2) notes.push("寝台列車で一晩過ごすので、2日以上の旅にしてください。着いた日の分だけ組んでいます。");
  notes.push("帰りも上りのサンライズで、夜に出て翌朝東京に戻れます。寝台は早めに埋まるので、乗る日の1か月前の発売日に確保してください。");
  notes.push("ななつ星in九州・TRAIN SUITE 四季島・TWILIGHT EXPRESS 瑞風のような周遊の寝台列車もあります（旅行商品で、申し込みは抽選です）。");
  return {
    name: "寝台列車", status: "handled",
    train: { name: s.name, to: s.to },
    question: { question: `${s.name}で${s.to}へ行く形で組みました。${other.name}（${other.to}）にしますか。`,
      choices: [`${s.name}のまま`, `${other.name}にする`] },
    request: { wish: `${s.to}のあたりを回る`, from: s.arrive, days: Math.max(1, ctx.days - 1),
      date: addDays(ctx.date, 1), start: s.start },
    rules: ["行きは寝台特急（車中泊）", "着いた駅から回る"],
    notes,
  };
}

const HAISEN_RE = /廃線|廃駅|鉄道跡|旧国鉄.{1,6}線|アプトの道|碓氷第三橋梁|タウシュベツ川橋梁|旧.{1,6}線(跡|橋梁|隧道)/;

/** 届く範囲（km）。日帰りは片道150kmほど、1泊ごとに広げます。 */
const reachKm = (days) => 150 + 250 * Math.max(0, days - 1);

/** 廃線跡。収録の廃線跡から、届く範囲のものを選び、近いものをまとめます。 */
async function haisen(ctx) {
  const all = (ctx.kb.spots ?? []).filter((s) => HAISEN_RE.test(`${s.name} ${s.description ?? ""}`)
    && s.category !== "道の駅");
  const from = ctx.origin;
  const near = all.filter((s) => straightKm(from, s) <= reachKm(ctx.days))
    .sort((a, b) => straightKm(from, a) - straightKm(from, b));
  const pool = near.length ? near : [...all].sort((a, b) => straightKm(from, a) - straightKm(from, b)).slice(0, 1);
  const notes = [];
  if (!pool.length) {
    return { name: "廃線跡", status: "partial", request: null, rules: [],
      notes: ["収録に廃線跡が見つかりませんでした。"],
      question: { question: "行ってみたい廃線跡の名前か、都道府県を教えてください。", choices: [] } };
  }
  if (!near.length) notes.push(`${ctx.days}日で届く範囲には収録の廃線跡が無いので、いちばん近い${pool[0].name}（${pool[0].prefecture}）にしています。`);
  const first = pool[0];
  const picked = pool.filter((s) => straightKm(first, s) <= 80).slice(0, Math.max(1, ctx.days * 2));
  notes.push("廃線跡には立ち入りが禁じられた区間や、季節で見られないもの（タウシュベツ川橋梁は水位しだい）があります。現地の案内に従ってください。");
  return {
    name: "廃線跡", status: "handled",
    stops: picked.map(brief),
    request: { wish: `${picked.map((s) => s.name).join("・")}をめぐる`, must: picked.map((s) => s.id) },
    rules: ["収録の廃線跡を必ず立ち寄るにする", "近い廃線跡どうしをまとめる"],
    notes,
  };
}

/** 名の知れた秘境駅。近くの名所（near）と一緒に組みます。 */
export const HIKYO_STATIONS = [
  { name: "小幌駅", prefecture: "北海道", line: "室蘭本線", why: "道路が通じておらず、列車でしか行けない", near: "洞爺湖" },
  { name: "坪尻駅", prefecture: "徳島県", line: "土讃線", why: "谷底にあるスイッチバックの駅", near: "大歩危峡" },
  { name: "尾盛駅", prefecture: "静岡県", line: "大井川鐵道井川線", why: "道路が無く、列車でしか行けない", near: "寸又峡" },
  { name: "奥大井湖上駅", prefecture: "静岡県", line: "大井川鐵道井川線", why: "ダム湖に突き出た半島の上の駅", near: "寸又峡" },
  { name: "小和田駅", prefecture: "静岡県", line: "飯田線", why: "山あいで、近くに人家がほとんど無い", near: "天竜峡" },
  { name: "田本駅", prefecture: "長野県", line: "飯田線", why: "崖の中腹にへばりつく駅", near: "天竜峡" },
  { name: "土合駅", prefecture: "群馬県", line: "上越線", why: "下りのホームが地下深く、462段の階段を上る", near: "谷川岳" },
  { name: "筒石駅", prefecture: "新潟県", line: "えちごトキめき鉄道", why: "長いトンネルの中にある駅", near: "親不知・子不知県立自然公園" },
];

/** 秘境駅。県が書かれていればその県、無ければ出発地に近い県の駅にします。 */
async function hikyoStation(ctx) {
  const named = HIKYO_STATIONS.find((h) => ctx.text.includes(h.name.replace(/駅$/, "")));
  const prefs = prefCenters(ctx.kb);
  const byPref = HIKYO_STATIONS.filter((h) => ctx.text.includes(h.prefecture.replace(/[都府県]$/, "")));
  const dist = (h) => (prefs.get(h.prefecture) ? straightKm(ctx.origin, prefs.get(h.prefecture)) : Infinity);
  const pick = named ?? byPref[0] ?? [...HIKYO_STATIONS].sort((a, b) => dist(a) - dist(b))[0];
  const near = findSpot(ctx.kb, pick.near, pick.prefecture);
  const same = HIKYO_STATIONS.filter((h) => h !== pick && h.near === pick.near);
  return {
    name: "秘境駅", status: "handled",
    station: { name: pick.name, prefecture: pick.prefecture, line: pick.line, why: pick.why },
    stops: [{ name: pick.name, prefecture: pick.prefecture, inKb: false }, ...(near ? [{ ...brief(near), inKb: true }] : [])],
    request: { wish: `${pick.prefecture}の${pick.near}のあたりを回る`, ...(near ? { must: [near.id] } : {}) },
    rules: ["秘境駅そのものは収録に無いので、近くの名所と一緒に組む", "列車の本数がとても少ないので、帰りの列車を先に決める"],
    notes: [`${pick.name}（${pick.line}）は、${pick.why}駅です。`
      + "止まる列車が1日に数本しか無いことが多いので、降りる前に帰りの列車の時刻を確かめてください。",
      ...(same.length ? [`同じ線の${same.map((h) => h.name).join("・")}も近くにあります。`] : [])],
  };
}

/** 本土の四極と、人が住む島の端。 */
export const EDGES = {
  north: { label: "本土最北端", spot: "宗谷岬", prefecture: "北海道" },
  east: { label: "本土最東端", spot: "納沙布岬", prefecture: "北海道" },
  south: { label: "本土最南端", spot: "佐多岬", prefecture: "鹿児島県" },
  west: { label: "本土最西端", spot: "神崎鼻", prefecture: "長崎県" },
  southIsland: { label: "日本最南端の有人島", spot: "波照間島", prefecture: "沖縄県" },
  westIsland: { label: "日本最西端（与那国島の西崎）", spot: "西崎", prefecture: "沖縄県" },
};

/** 日本の端。1つなら岬を必ず立ち寄るにして組み、四極なら回る順と旅の分けかたを出します。 */
async function edges(ctx) {
  const t = ctx.text;
  const island = /島|有人|波照間|与那国|離島/.test(t);
  const want = [];
  if (/最北端/.test(t)) want.push("north");
  if (/最東端/.test(t)) want.push("east");
  if (/最南端/.test(t)) want.push(island ? "southIsland" : "south");
  if (/最西端/.test(t)) want.push(island ? "westIsland" : "west");
  const all = !want.length || /東西南北|四極/.test(t);
  const keys = all ? ["north", "east", "south", "west"] : want;
  const points = keys.map((k) => ({ key: k, ...EDGES[k], found: findSpot(ctx.kb, EDGES[k].spot, EDGES[k].prefecture) }));
  const reachable = points.filter((p) => p.found);
  const ordered = nearestFirst(reachable.map((p) => p.found), ctx.origin);
  const label = (s) => points.find((p) => p.found === s)?.label ?? "";
  const notes = [];
  // 四極は北海道と九州に分かれるので、1回の旅には入りません。
  const legs = [];
  for (const s of ordered) {
    const b = blockOf(s.prefecture);
    const last = legs.at(-1);
    if (last && last.block === b) last.stops.push(brief(s));
    else legs.push({ block: b, stops: [brief(s)] });
  }
  if (legs.length > 1) {
    notes.push(`${keys.length}つの端は${legs.map((l) => l.block).join("・")}に分かれているので、`
      + `${legs.length}回の旅に分けています。今回は${legs[0].block}の${legs[0].stops.map((s) => s.name).join("・")}を組みました。`);
  }
  const first = legs[0]?.stops ?? [];
  return {
    name: "日本の端", status: first.length ? "handled" : "partial",
    stops: ordered.map((s) => ({ ...brief(s), label: label(s) })),
    legs,
    request: first.length ? { wish: `${first.map((s) => s.name).join("・")}を訪ねる`, must: first.map((s) => s.id) } : null,
    rules: ["端の岬を必ず立ち寄るにする", "地方が分かれるなら、旅を分ける"],
    notes: [...notes, "端の岬は駅から遠いところが多く、バスの本数も少ないので、車か時刻を確かめた路線バスで向かってください。"],
  };
}

/**
 * 日本の世界遺産（2024年の佐渡島の金山までの26件）。
 * spots は収録で探す名前（上から順に、見つかったものを使う）。
 */
export const WORLD_HERITAGE = [
  { name: "知床", prefecture: "北海道", kind: "自然", spots: ["知床五湖"] },
  { name: "白神山地", prefecture: "秋田県", kind: "自然", spots: ["白神山地世界遺産センター藤里館", "白神山地"] },
  { name: "北海道・北東北の縄文遺跡群", prefecture: "青森県", kind: "文化", spots: ["三内丸山遺跡"] },
  { name: "平泉", prefecture: "岩手県", kind: "文化", spots: ["中尊寺"] },
  { name: "日光の社寺", prefecture: "栃木県", kind: "文化", spots: ["日光東照宮"] },
  { name: "富岡製糸場と絹産業遺産群", prefecture: "群馬県", kind: "文化", spots: ["富岡製糸場"] },
  { name: "ル・コルビュジエの建築作品（国立西洋美術館）", prefecture: "東京都", kind: "文化", spots: ["国立西洋美術館"] },
  { name: "小笠原諸島", prefecture: "東京都", kind: "自然", spots: ["小笠原諸島", "父島"], island: "竹芝から船で約24時間。船はおよそ週1便です" },
  { name: "佐渡島の金山", prefecture: "新潟県", kind: "文化", spots: ["佐渡金山"], island: "新潟港から佐渡汽船で渡ります" },
  { name: "富士山", prefecture: "静岡県", kind: "文化", spots: ["富士山本宮浅間大社"] },
  { name: "白川郷・五箇山の合掌造り集落", prefecture: "岐阜県", kind: "文化", spots: ["白川郷 合掌造り集落", "荻町合掌造り集落"] },
  { name: "古都京都の文化財", prefecture: "京都府", kind: "文化", spots: ["清水寺", "金閣寺 鹿苑寺"] },
  { name: "古都奈良の文化財", prefecture: "奈良県", kind: "文化", spots: ["東大寺"] },
  { name: "法隆寺地域の仏教建造物", prefecture: "奈良県", kind: "文化", spots: ["法隆寺"] },
  { name: "紀伊山地の霊場と参詣道", prefecture: "和歌山県", kind: "文化", spots: ["熊野本宮大社", "那智の滝"] },
  { name: "百舌鳥・古市古墳群", prefecture: "大阪府", kind: "文化", spots: ["仁徳天皇陵古墳", "百舌鳥・古市古墳群"] },
  { name: "姫路城", prefecture: "兵庫県", kind: "文化", spots: ["姫路城"] },
  { name: "石見銀山遺跡とその文化的景観", prefecture: "島根県", kind: "文化", spots: ["石見銀山世界遺産センター"] },
  { name: "原爆ドーム", prefecture: "広島県", kind: "文化", spots: ["原爆ドーム"] },
  { name: "厳島神社", prefecture: "広島県", kind: "文化", spots: ["厳島神社"] },
  { name: "「神宿る島」宗像・沖ノ島と関連遺産群", prefecture: "福岡県", kind: "文化", spots: ["宗像大社"], note: "沖ノ島には上陸できません。宗像大社の辺津宮から拝みます" },
  { name: "明治日本の産業革命遺産", prefecture: "長崎県", kind: "文化", spots: ["グラバー園", "軍艦島 端島"] },
  { name: "長崎と天草地方の潜伏キリシタン関連遺産", prefecture: "長崎県", kind: "文化", spots: ["大浦天主堂"] },
  { name: "屋久島", prefecture: "鹿児島県", kind: "自然", spots: ["屋久島"], island: "鹿児島から船か飛行機で渡ります" },
  { name: "奄美大島、徳之島、沖縄島北部及び西表島", prefecture: "鹿児島県", kind: "自然", spots: ["奄美大島"], island: "鹿児島・本土の空港から飛行機で渡ります" },
  { name: "琉球王国のグスク及び関連遺産群", prefecture: "沖縄県", kind: "文化", spots: ["首里城"] },
];

/**
 * 出発地にいちばん近いものを先頭にして、残りを回る順に並べます。
 * （orderByRoute は全体の道のりを短くするので、2-opt で向きが逆になり、
 * 遠い地方から始まることがあります。旅を分けるときは、近い所から行きます。）
 */
export function nearestFirst(points, origin, distance = (p) => straightKm(origin, p)) {
  if (points.length <= 1 || !origin) return [...points];
  const first = [...points].sort((a, b) => distance(a) - distance(b))[0];
  const rest = points.filter((p) => p !== first);
  return [first, ...orderByRoute(rest, first, travelMinutes, { useCrowd: false })];
}

/**
 * 地点を地方ごとにまとめ、出発地から近い地方の順に並べます（地方の中も回る順）。
 * @param {{block: string, at: {lat, lng}}[]} items
 */
function legsByBlock(items, origin) {
  const groups = new Map();
  for (const it of items) {
    const g = groups.get(it.block) ?? [];
    g.push(it);
    groups.set(it.block, g);
  }
  // 島へ渡るもの（小笠原など）は、地方の真ん中を引っぱらないよう外して測ります。
  const blocks = [...groups].map(([block, list]) => {
    const main = list.filter((x) => !x.heritage?.island);
    return { block, list, ...centroid((main.length ? main : list).map((x) => x.at)) };
  });
  // 近さは、地方の真ん中ではなく、地方の中でいちばん近い地点で測ります
  // （九州・沖縄の真ん中は沖縄に引っぱられ、福岡から見て中国・四国より遠くなるため）。
  const near = (b) => Math.min(...b.list.filter((x) => !x.heritage?.island).map((x) => straightKm(origin, x.at)), Infinity);
  const order = nearestFirst(blocks, origin, near);
  return order.map((b) => {
    const inner = nearestFirst(b.list.map((x) => ({ ...x.at, item: x })), origin);
    return { block: b.block, items: inner.map((p) => p.item) };
  });
}

/** 世界遺産全制覇。26件を地方ごとの旅に分け、近い地方から順に並べます。 */
async function worldHeritage(ctx) {
  const items = WORLD_HERITAGE.map((h) => {
    const spot = h.spots.map((n) => findSpot(ctx.kb, n, h.prefecture)).find(Boolean) ?? null;
    return { heritage: h, spot, block: blockOf(h.prefecture),
      at: spot ? { lat: spot.lat, lng: spot.lng } : prefCenters(ctx.kb).get(h.prefecture) };
  }).filter((x) => x.at);
  const legs = legsByBlock(items, ctx.origin).map((l) => ({
    block: l.block,
    // 1件におよそ1日（移動を入れて）。島へ渡るものは、もう1日。
    days: l.items.reduce((a, x) => a + 1 + (x.heritage.island ? 1 : 0), 0),
    sites: l.items.map((x) => ({ name: x.heritage.name, kind: x.heritage.kind, prefecture: x.heritage.prefecture,
      spot: x.spot ? brief(x.spot) : null, ...(x.heritage.island ? { island: x.heritage.island } : {}),
      ...(x.heritage.note ? { note: x.heritage.note } : {}) })),
  }));
  const first = legs[0];
  const fit = first.sites.filter((s) => s.spot && !s.island).slice(0, Math.max(1, ctx.days * 2));
  const total = legs.reduce((a, l) => a + l.days, 0);
  const notes = [`日本の世界遺産は${WORLD_HERITAGE.length}件です。地方ごとに${legs.length}回の旅に分けると、`
    + `全部でおよそ${total}日かかります。今回は${first.block}の${fit.map((s) => s.name).join("・")}を組みました。`];
  const islands = legs.flatMap((l) => l.sites).filter((s) => s.island);
  if (islands.length) notes.push(`${islands.map((s) => s.name).join("・")}は島へ渡るので、別に日数をとってください。`);
  return {
    name: "世界遺産全制覇", status: fit.length ? "handled" : "partial",
    total: WORLD_HERITAGE.length, totalDays: total, legs,
    request: fit.length ? { wish: `${fit.map((s) => s.spot.name).join("・")}をめぐる`, must: fit.map((s) => s.spot.id) } : null,
    rules: ["世界遺産ごとに代表の場所を1つ以上訪ねる", "地方ごとに旅を分け、近い地方から"],
    notes,
  };
}

/** 47都道府県の県庁所在地。座標は places.js の駅、無いものだけここに持ちます。 */
export const CAPITALS = [
  ["北海道", "札幌", "札幌駅"], ["青森県", "青森", "青森駅"], ["岩手県", "盛岡", "盛岡駅"],
  ["宮城県", "仙台", "仙台駅"], ["秋田県", "秋田", "秋田駅"], ["山形県", "山形", "山形駅"],
  ["福島県", "福島", "福島駅"], ["茨城県", "水戸", "水戸駅"], ["栃木県", "宇都宮", "宇都宮駅"],
  ["群馬県", "前橋", { lat: 36.3834, lng: 139.0733 }], ["埼玉県", "さいたま", "浦和駅"],
  ["千葉県", "千葉", "千葉駅"], ["東京都", "東京（新宿）", "新宿駅"], ["神奈川県", "横浜", "横浜駅"],
  ["新潟県", "新潟", "新潟駅"], ["富山県", "富山", "富山駅"], ["石川県", "金沢", "金沢駅"],
  ["福井県", "福井", "福井駅"], ["山梨県", "甲府", "甲府駅"], ["長野県", "長野", "長野駅"],
  ["岐阜県", "岐阜", "岐阜駅"], ["静岡県", "静岡", "静岡駅"], ["愛知県", "名古屋", "名古屋駅"],
  ["三重県", "津", { lat: 34.7339, lng: 136.5101 }], ["滋賀県", "大津", "大津駅"], ["京都府", "京都", "京都駅"],
  ["大阪府", "大阪", "大阪駅"], ["兵庫県", "神戸", "三ノ宮駅"], ["奈良県", "奈良", "奈良駅"],
  ["和歌山県", "和歌山", "和歌山駅"], ["鳥取県", "鳥取", "鳥取駅"], ["島根県", "松江", "松江駅"],
  ["岡山県", "岡山", "岡山駅"], ["広島県", "広島", "広島駅"], ["山口県", "山口", "山口駅"],
  ["徳島県", "徳島", "徳島駅"], ["香川県", "高松", "高松駅"], ["愛媛県", "松山", "松山駅"],
  ["高知県", "高知", "高知駅"], ["福岡県", "福岡", "博多駅"], ["佐賀県", "佐賀", "佐賀駅"],
  ["長崎県", "長崎", "長崎駅"], ["熊本県", "熊本", "熊本駅"], ["大分県", "大分", "大分駅"],
  ["宮崎県", "宮崎", "宮崎駅"], ["鹿児島県", "鹿児島", "鹿児島中央駅"], ["沖縄県", "那覇", { lat: 26.2124, lng: 127.6809 }],
].map(([prefecture, city, at]) => {
  const p = typeof at === "string" ? findPlace(at) : at;
  return { prefecture, city, station: typeof at === "string" ? at : null, lat: p?.lat, lng: p?.lng };
});

/** 県庁所在地の駅から3km以内で、いちばん知られたスポット（旅程で必ず立ち寄るにする）。 */
function capitalSpot(kb, c) {
  let best = null;
  for (const s of kb.spots ?? []) {
    if (s.prefecture !== c.prefecture || !["major", "known"].includes(s.fame_tier)) continue;
    if (!Number.isFinite(s.lat) || straightKm(c, s) > 3) continue;
    if ((s.fame_score ?? 0) > (best?.fame_score ?? -1)) best = s;
  }
  return best;
}

/** 1日に回れる県庁所在地の目安（移動の分と、1都市2時間ほどの滞在で10時間まで）。 */
export function splitByDay(stops, start, { dayMinutes = 600, stayMinutes = 120 } = {}) {
  const days = [];
  let cur = [];
  let used = 0;
  let prev = start;
  for (const s of stops) {
    const move = prev ? travelMinutes(prev, s) : 0;
    if (cur.length && used + move + stayMinutes > dayMinutes) {
      days.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(s);
    used += move + stayMinutes;
    prev = s;
  }
  if (cur.length) days.push(cur);
  return days;
}

/** 県庁所在地踏破。47都市を回る順に並べ、1日に回れる数で区切り、旅の日数で分けます。 */
async function capitals(ctx) {
  const list = CAPITALS.filter((c) => Number.isFinite(c.lat));
  const ordered = nearestFirst(list, ctx.origin);
  const byDay = splitByDay(ordered, ctx.origin);
  const legs = [];
  for (let i = 0; i < byDay.length; i += ctx.days) {
    legs.push({ days: byDay.slice(i, i + ctx.days).map((d) => d.map((c) => c.city)) });
  }
  // 今回の旅の日ごとの予定。いつもの流れ（観光の旅程）では、1日に3〜4都市を
  // 渡り歩く組みかたができず、都市が抜け落ちます。そこで、この形だけは
  // 日ごとの都市・立ち寄る場所・移動の目安をここで出します。
  let prev = ctx.origin;
  const schedule = byDay.slice(0, ctx.days).map((day, i) => ({
    day: i + 1,
    stops: day.map((c) => {
      const moveMinutes = prev ? Math.round(travelMinutes(prev, c)) : 0;
      prev = c;
      const spot = capitalSpot(ctx.kb, c);
      return { city: c.city, prefecture: c.prefecture, station: c.station, moveMinutes,
        spot: spot ? brief(spot) : null };
    }),
  }));
  const first = schedule.flatMap((d) => d.stops.map((s) => s.city));
  const notes = [`47の県庁所在地を回る順に並べると、1日に回れる数（移動と1都市2時間ほど）でおよそ${byDay.length}日、`
    + `${ctx.days}日ずつの旅にすると${legs.length}回です。今回は${first.join("・")}を回ります。`,
  "移動の時間は距離からの目安です。各都市では、駅の近くの名所に1か所立ち寄る予定にしています。"];
  if (/47都道府県|全都道府県/.test(ctx.text) && !/県庁所在地/.test(ctx.text)) {
    notes.unshift("「47都道府県」は、各都道府県の県庁所在地を訪ねる旅として読んでいます。");
  }
  return {
    name: "県庁所在地踏破", status: "handled",
    order: ordered.map((c) => ({ city: c.city, prefecture: c.prefecture })),
    totalDays: byDay.length, legs, schedule,
    request: null,
    rules: ["47都市を1つずつ訪ねる", "回る順は移動が短くなるように（最近傍＋2-opt）", "1日の移動と滞在は10時間まで（1都市2時間ほど）"],
    notes,
  };
}

const HANDLERS = {
  longest_ticket: longestTicket, japan_loop: japanLoop, cruise, seishun18, sleeper,
  haisen, hikyo_station: hikyoStation, edges, world_heritage: worldHeritage, capitals,
};

/**
 * 特殊な旅の形を読み取り、その形の処理に回します。
 *
 * @param {{text: string, kb: object, origin: {name, lat, lng}, days?: number,
 *          date?: string, solvers?: {longestTicket?: Function}}} ctx
 * @returns {Promise<null | {mode: string, name: string, matched: string, modifiers: string[],
 *   status: "handled"|"partial"|"needs_solver", request: object|null, rules: string[],
 *   notes: string[], [key: string]: any}>}
 */
export async function handleSpecial({ text, kb, origin, days = 1, date = null, solvers = null } = {}) {
  const found = detectSpecial(text);
  if (!found) return null;
  const ctx = { text: String(text ?? "").normalize("NFKC"), kb, origin, days, date, solvers, notes: [] };
  const out = await HANDLERS[found.mode](ctx);
  out.notes = [...(out.notes ?? []), ...ctx.notes];
  // ほかの形と一緒に書かれた乗り物の指定（青春18きっぷで日本一周）。
  if (found.modifiers.includes("seishun18") && out.request) {
    out.request.transport = "local";
    out.rules = [...out.rules, "JRの普通列車・快速だけ（青春18きっぷ）"];
  }
  if (found.modifiers.includes("sleeper")) {
    out.notes.push("寝台列車（定期のものはサンライズ瀬戸・出雲だけ）は、行きか帰りの一晩に入れられます。");
  }
  return { ...found, name: out.name ?? found.name, ...out, mode: found.mode };
}

/** 形の名前（id → 日本語）。 */
export const specialName = (id) => BY_ID.get(id)?.name ?? id;
