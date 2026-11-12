// 情報の確からしさを、3段階で伝える。
//
// 旅行では「その情報がどこから来たか」が結果を左右します。
// 公式で確認した営業時間と、分類ごとの目安と、AIが検索してきたものを、
// 同じ顔で並べてはいけません。現地で閉まっていたとき、どれを疑えば
// よかったのかが分からなくなります。
//
//   🟢 収録データ … 収録の実データ、または経路検索・時刻表で取れた値
//   🟡 目安      … 分類ごとの目安、距離からの計算
//   🟠 AI調査    … AIが検索して得たもの。現地で変わっている可能性あり
//
// 「それっぽい嘘」より「分かりません」のほうが価値がある、という
// このアプリの方針を、画面の上でも守るための仕組みです。
//
// 言葉づかいについて。
//
// いちばん上の段は「確認済み」と書いていました。けれど、このアプリが
// 確認したのは**収録した時点の値**であって、あなたが行く日のことでは
// ありません。営業時間は季節で動き、ダイヤは改正され、臨時休業もあります。
// 「確認済み」と言い切ると、その責任まで引き受けたことになります。
// 出どころを言うだけにして、確かめるのは公式で、と添えます。

export const LEVELS = {
  verified:  { label: "収録データ", icon: "level-verified", rank: 0,
               tone: "収録している実データです。",
               action: "変更されることがあるので、直前に公式でもご確認ください。" },
  estimated: { label: "目安",       icon: "level-estimated", rank: 1,
               tone: "実際と異なる場合があります。",
               action: "時間に余裕を持ってお出かけください。" },
  ai:        { label: "AI調査",     icon: "level-ai", rank: 2,
               tone: "公式情報を確認できていません。",
               action: "訪問前に、公式サイトで営業時間をご確認ください。" },
};

const fmtDate = (ms) => {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * その情報の確からしさ。
 *
 * @param {"hours"|"travel"|"fee"|"place"} kind 何についてか
 * @param {object} subject スポット、または移動の項目
 * @param {{now?:Date}} [opts]
 * @returns {{level:string, label:string, icon:string, text:string,
 *            checkedAt:string, ageText:string, stale:boolean}}
 */
export function confidenceOf(kind, subject, opts = {}) {
  const s = subject ?? {};
  const checkedAt = Number.isFinite(s.fetchedAt) ? fmtDate(s.fetchedAt) : "";
  const age = ageOf(s.fetchedAt, opts.now ?? new Date());

  if (kind === "travel") {
    // 出どころの名前まで出します。「確認済み」とだけ書かれても、
    // 何で確かめたのかが分かりません。時刻表から取ったのか、地図の
    // 経路検索なのかで、当日ずれたときに疑う先が変わります。
    const routed = s.routed === true;
    // 歩きは、距離で足ります。
    //
    // 0.5kmの徒歩に「🟡 推定」と付けると、時刻表を引けなかった区間と
    // 同じ顔になります。歩く速さは人によって多少違いますが、便のように
    // 「無ければ2時間待ち」にはなりません。**確かめようのないもの**と
    // **確かめる必要のないもの**を、同じ印で並べないようにします。
    if (!routed && s.walk === true) {
      const walk = build("verified",
        "距離から出した徒歩の時間です（時速約4km）", checkedAt, age);
      walk.label = "徒歩";
      walk.source = "";
      return walk;
    }
    // 「目安」には2通りあります。**直せるものと、直せないものです。**
    //
    //   近くに駅・バス停が無い … 何度作り直しても同じです。車かタクシー。
    //   時刻を引けなかった     … 通信や混雑のことがあり、作り直すと入ります。
    //
    // 同じ「🟡 目安」で並べていたので、読む人には区別がつかず、
    // 直らないものを何度も作り直すことになっていました。
    if (!routed && s.noTransit === true) {
      const taxi = build("estimated",
        "近くに駅・バス停が見当たりません。タクシーで行くものとして、"
        + "距離から時間と運賃を見積もっています", checkedAt, age);
      taxi.label = "タクシー";
      taxi.source = "";
      return taxi;
    }
    const out = build(routed ? "verified" : "estimated",
      (s.transitDoc ?? s.yahoo)
        ? "乗り換え検索の時刻です（乗換・待ち時間を含みます）"
        : routed
          ? (s.transit
              ? "経路検索で確認した所要時間です（乗換・待ち時間を含みます）"
              : "経路検索で確認した所要時間です")
          : "距離からの推定です。実際の便やダイヤは反映していません",
      checkedAt, age);
    // 出どころの名前は、**見分けがつく必要があるときだけ**出します。
    // 電車・バスの時刻は乗り換え検索からしか取らなくなったので、
    // 「時刻表・（検索の名前）」と並べても、読む人の判断は変わりません。
    // 印は短いほうが読まれます。
    out.source = routed && !(s.transitDoc ?? s.yahoo) ? "Googleの経路"
      : (s.transitDoc ?? s.yahoo) ? "" : "距離からの推定";
    if (s.transitDoc ?? s.yahoo) out.label = "時刻表";
    return out;
  }

  // 場所そのもの、営業時間、料金は、出どころが同じなので同じ判定です。
  if (s.source === "ai" || s.verified === false) {
    return build("ai",
      "AIが検索して得た情報です。現地で変わっている可能性があります",
      checkedAt, age);
  }
  const hasHours = s.hours?.open !== undefined || s.open !== undefined;
  if (kind === "hours") {
    return hasHours
      ? build("verified", "収録データで確認した営業時間です", checkedAt, age)
      : build("estimated", "分類ごとの目安です。実際の営業時間とは異なります",
              checkedAt, age);
  }
  if (kind === "fee") {
    const hasFee = s.hours?.fee !== undefined || s.fee !== undefined;
    return hasFee
      ? build("verified", "収録データの料金です", checkedAt, age)
      : build("estimated", "分類ごとの目安です", checkedAt, age);
  }
  return build("verified", "収録データです", checkedAt, age);
}

/** 情報が古いと見なす日数。営業時間は季節で変わります。 */
export const STALE_DAYS = 60;

/**
 * 「確認済み」と「最新」は、別のことです。
 *
 * 3年前に確認した営業時間も「確認済み」ではあります。けれど、
 * それを最新と同じ顔で出せば、閉まっている店の前に立たせることに
 * なります。確からしさ（どこから来たか）と、鮮度（いつ取ったか）は
 * 分けて出します。
 *
 * @returns {{text:string, level:"fresh"|"aging"|"stale"|"unknown"}}
 */
export function freshnessOf(fetchedAt, now = new Date()) {
  if (!Number.isFinite(fetchedAt)) {
    return { text: "確認日は不明です", level: "unknown" };
  }
  const days = Math.floor((now - fetchedAt) / 86400000);
  if (days < 0) return { text: "確認日は不明です", level: "unknown" };
  const when = days === 0 ? "今日" : days === 1 ? "昨日"
    : days < 31 ? `${days}日前`
    : `${Math.floor(days / 30)}か月前`;
  return {
    text: `最終確認 ${fmtDate(fetchedAt)}（${when}）`,
    level: days >= STALE_DAYS ? "stale" : days >= 30 ? "aging" : "fresh",
  };
}

/**
 * いつ取ったものかを、そのまま読める言葉に。
 * 分からないときは何も言いません（それらしい日付を作らないこと）。
 */
function ageOf(fetchedAt, now) {
  if (!Number.isFinite(fetchedAt)) return { text: "", stale: false, days: null };
  const days = Math.floor((now - fetchedAt) / 86400000);
  if (days < 0) return { text: "", stale: false, days: null };
  const text = days === 0 ? "今日取得"
    : days === 1 ? "昨日取得"
    : days < 31 ? `${days}日前に取得`
    : `${Math.floor(days / 30)}か月前に取得`;
  return { text, stale: days >= STALE_DAYS, days };
}

function build(level, text, checkedAt, age = { text: "", stale: false }) {
  const def = LEVELS[level];
  return { level, label: def.label, icon: def.icon, rank: def.rank,
           action: def.action,
           text: age.stale
             ? `${text}（${age.text}。変わっている可能性があります）`
             : text,
           checkedAt, ageText: age.text, stale: age.stale };
}

/**
 * いくつかの情報をまとめたときの、全体の確からしさ。
 *
 * いちばん弱いものが全体の弱さです。9件が確認済みでも、1件が
 * AI調査なら、その旅程は「AI調査が混じっている」と言うべきです。
 */
export function describeSource(list) {
  const items = (list ?? []).filter(Boolean);
  if (!items.length) {
    return build("estimated", "情報の出どころが分かりません", "");
  }
  const worst = items.slice().sort((a, b) => b.rank - a.rank)[0];
  const counts = {};
  for (const c of items) counts[c.level] = (counts[c.level] ?? 0) + 1;
  const parts = Object.entries(counts)
    .sort((a, b) => LEVELS[a[0]].rank - LEVELS[b[0]].rank)
    .map(([k, n]) => `${LEVELS[k].label} ${n}件`);
  const def = LEVELS[worst.level];
  return { ...worst,
           text: `${parts.join("・")}。${def.tone}`,
           action: def.action };
}


// --- 予約 -------------------------------------------------------------------

/**
 * 予約が要る分類。**「多い」であって「必ず」ではありません。**
 * 断定すると、要らない場所で予約を探させることになります。
 */
const OFTEN_RESERVED = {
  酒蔵: "見学は事前予約制のことが多い分類です",
  文化施設: "催しによっては事前予約が要ることがあります",
  テーマパーク: "日時指定の入場券が要ることがあります",
  水族館: "混雑期は日時指定の券が要ることがあります",
};

/**
 * 当日行っても入れない場所。
 *
 * 分類の目安（上の OFTEN_RESERVED）とは別に、**名指し**で持ちます。
 * ジブリ美術館は日時指定の予約券だけで、当日券はありません。
 * 旅程に入った時点で言わないと、行ってから知ることになります。
 *
 * 書くのは「何日前までに、どこで取るか」の型だけです。値段や在庫は
 * 持っていません（日ごとに変わります）。公式サイトは、収録の url
 * （Wikidata の公式サイト）から渡します。無ければ Wikipedia へ。
 *
 * ここに載せるのは、**予約制であることが広く知られている**ものだけです。
 * 「混むから予約したほうがいい」程度の場所は載せません。載せると、
 * 要らない場所で予約を探させることになります。
 */
const TIMED_TICKET = [
  { re: /三鷹の森ジブリ美術館/,
    how: "日時指定の予約券だけで、当日券はありません。毎月10日に翌月分が"
      + "売り出されます。" },
  { re: /ジブリパーク/,
    how: "日時指定の予約券だけで、当日券はありません。エリアごとに券が"
      + "分かれます。毎月10日に翌々月分が売り出されます。" },
  { re: /チームラボ/,
    how: "日時指定の券が要ります。人気の枠は数週間前に埋まります。" },
  { re: /ユニバーサル・スタジオ・ジャパン|ユニバーサルスタジオ/,
    how: "入場券は日付指定です。混雑日は入場制限があります。" },
  { re: /東京ディズニー/,
    how: "入場券は日付指定で、当日券が無い日があります。" },
  { re: /ハリー・ポッター|ワーナー ブラザース スタジオツアー/,
    how: "日時指定の予約券だけで、当日券はありません。" },
  { re: /桂離宮|修学院離宮|仙洞御所/,
    how: "参観は宮内庁への申込制です（当日受付もありますが、枠が限られます）。" },
  { re: /白川郷.*ライトアップ/,
    how: "冬のライトアップは完全予約制です。" },
];

/**
 * その場所に予約が要るか。
 *
 * @returns {{required:boolean, likely:boolean, text:string, url:string}}
 */
export function reservationOf(spot) {
  const s = spot ?? {};
  // 公式サイト。収録の url（Wikidata の公式サイト）を使います。
  // http のものは https に書き換えて渡します（平文で開かせません）。
  const site = String(s.url ?? "").replace(/^http:/i, "https:");
  const url = /^https:\/\//.test(s.reservationUrl ?? "") ? s.reservationUrl
    : /^https:\/\//.test(site) ? site : "";
  const named = TIMED_TICKET.find((t) => t.re.test(String(s.name ?? "")));
  if (named) {
    return { required: true, likely: true, url,
      text: `事前の予約が必要です。${named.how}`
        + (url ? "" : "公式サイトでお申し込みください。") };
  }
  if (s.reservationRequired === true) {
    return { required: true, likely: true, url,
      text: "事前予約が必要です。訪問前に公式でお申し込みください。" };
  }
  const hint = OFTEN_RESERVED[s.category];
  if (hint) {
    return { required: false, likely: true, url,
      text: `${hint}。訪問前に公式でご確認ください。` };
  }
  return { required: false, likely: false, url, text: "" };
}
