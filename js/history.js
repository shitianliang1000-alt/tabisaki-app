// つくった旅程を覚えておく。
//
// 旅行サイトでいちばん使われるのは「前に作った旅程をもう一度開く」です。
// これまでは、条件の共有（URL）と印刷はできたのに、**過去に作ったものの
// 一覧がどこにもありませんでした**。ブラウザを閉じたら終わりです。
//
// 覚えるのは端末の中だけです。どこにも送りません。
//
// 何を覚えるか
// ------------
// **できあがった旅程そのもの**と、作り直せるだけの条件の両方です。
//
// はじめは条件だけにして、開くたびに組み直していました。営業時間も混雑も
// 日が変われば変わるので、そのほうが正しいと考えたためです。けれど、
// 作った人にとっては違いました。**同じ条件でも、組み直すと別の旅程が
// 出ます**（AIの選び方も、調べた便も、そのときのものです）。気に入った
// 旅程をもう一度見ようとして開いたら、知らない場所が並んでいる——
// これでは「保存」とは言えません。
//
// そこで、旅程はそのまま出します。ただし**いつ作ったものか**を添えて、
// 「いまの条件で作り直す」も残します。古い営業時間で案内しないためです。

const KEY = "tabisaki.history";
/**
 * 覚えておく件数。多すぎると、探すほうが面倒になります。
 * 旅程だけでなく、質問だけのチャットも1件に数えるので、そのぶん多めです。
 */
export const MAX = 20;
/** チャット1件に残すやりとりの数。古いものから落とします。 */
export const CHAT_MSGS = 30;

function store(storage) {
  return storage ?? globalThis.localStorage ?? null;
}

/** 保存されている一覧。新しい順。 */
export function loadHistory(storage) {
  try {
    const raw = store(storage)?.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isValid) : [];
  } catch {
    return [];   // 壊れていたら、無かったことにします
  }
}

function isValid(item) {
  return Boolean(item && typeof item === "object"
    && typeof item.id === "string" && typeof item.title === "string");
}

/**
 * 1件足します。
 *
 * 同じ旅（同じ行き先・同じ日程）を何度も作り直すのはふつうのことです。
 * そのたびに一覧が埋まると、探せなくなります。**同じものは上書き**して、
 * いちばん上に持ってきます。
 *
 * @param {{title:string, subtitle?:string, when?:string, state:object}} entry
 * @returns {Array} 新しい一覧
 */
export function addHistory(entry, storage, now = new Date()) {
  if (!entry?.title || !entry?.state) return loadHistory(storage);
  const id = keyOf(entry);
  const item = {
    id,
    title: String(entry.title).slice(0, 60),
    subtitle: String(entry.subtitle ?? "").slice(0, 80),
    when: String(entry.when ?? "").slice(0, 40),
    savedAt: now.getTime(),
    state: entry.state,
    itin: entry.itin ? freezeItinerary(entry.itin) : null,
    // 旅程を開くときに、地図や外部リンクが「どこから来てどこへ帰るか」を
    // 使います。条件（state）は入力欄の文字なので、こちらも要ります。
    trip: entry.trip ? freezeItinerary(entry.trip) : null,
  };
  const rest = loadHistory(storage).filter((x) => x.id !== id);
  const list = [item, ...rest].slice(0, MAX);
  write(list, storage);
  return list;
}

/**
 * 質問だけのチャットを、1件として覚えます。
 *
 * 「最近のチャット」に旅程しか並ばないと、ちょっとした質問（あいさつ、
 * 「東京タワーの高さは？」）は閉じたら消えていました。旅程を組まなかった
 * やりとりも、同じ一覧に残します。
 *
 * 同じチャットのあいだは id が同じなので、**1件を上書き**して、いちばん
 * 上に持ってきます。答えが増えるたびに一覧が埋まることはありません。
 *
 * @param {{id:string, msgs:{q:string, a:string, sources?:Array}[]}} entry
 * @returns {Array} 新しい一覧
 */
export function addChat(entry, storage, now = new Date()) {
  const msgs = (entry?.msgs ?? [])
    .filter((m) => m && typeof m.q === "string" && typeof m.a === "string")
    .slice(-CHAT_MSGS)
    .map((m) => ({
      q: m.q.slice(0, 400), a: m.a.slice(0, 2000),
      ...(Array.isArray(m.sources) && m.sources.length
        ? { sources: m.sources.slice(0, 5).map((x) => ({ title: String(x?.title ?? ""), url: String(x?.url ?? "") })) }
        : {}),
    }));
  if (!entry?.id || !msgs.length) return loadHistory(storage);
  const oneLine = (t) => String(t).replace(/\s+/g, " ").trim();
  const item = {
    id: String(entry.id),
    kind: "chat",
    title: oneLine(msgs[0].q).slice(0, 60) || "チャット",
    subtitle: oneLine(msgs[msgs.length - 1].a).slice(0, 80),
    savedAt: now.getTime(),
    msgs,
  };
  const rest = loadHistory(storage).filter((x) => x.id !== item.id);
  const list = [item, ...rest].slice(0, MAX);
  write(list, storage);
  return list;
}

/** 質問だけのチャットか（旅程ではないもの）。 */
export function isChat(item) {
  return item?.kind === "chat" && Array.isArray(item.msgs);
}

/**
 * 旅程を、しまえる形にします。
 *
 * localStorage は文字列しか持てないので、日時は文字列になります。ここで
 * 落とすのは、開き直すのに要らないものだけです。地図と外部リンクは
 * 座標が要るので、立ち寄りの場所（place）は残します。
 */
export function freezeItinerary(itin) {
  return JSON.parse(JSON.stringify(itin, (key, value) => {
    // 収録データまるごと（候補の一覧など）は持ちません。開いたときに
    // 使うのは、旅程に入っているぶんだけです。
    if (key === "replan" || key === "variants" || key === "candidates") {
      return undefined;
    }
    return value;
  }));
}

/**
 * しまった旅程を、使える形に戻します（文字列の日時を Date へ）。
 *
 * どの項目が日時かは名前で決めます。中身を見て「日時っぽい文字列」を
 * 探すと、説明文の中の「2026-09-10」まで日時にしてしまいます。
 */
// date は planner.js が日ごとに置く「その日」（Date）です。ここに無いと、
// 「前につくった旅」を開いたときに日付の見出しで落ちていました
// （toLocaleDateString is not a function）。
const TIME_KEYS = new Set(["start", "end", "departAt", "arriveBy", "at",
                           "checkIn", "checkOut", "savedAt", "sunrise",
                           "sunset", "date"]);

export function thawItinerary(itin) {
  const walk = (value, key) => {
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    if (typeof value === "string" && TIME_KEYS.has(key)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d;
    }
    return value;
  };
  return walk(itin, "");
}

/**
 * 同じ旅かどうかの見分け。行き先・出発地・日程が同じなら同じ旅です。
 *
 * 名前は js/app.js の formState() と揃えてあります（from / to / dep / arr）。
 * ここがずれると、条件を変えたのに上書きされる・同じ旅が何件も並ぶ、の
 * どちらかが起きます。
 */
function keyOf(entry) {
  const s = entry.state ?? {};
  return [entry.title, s.from ?? "", s.to ?? "", s.dep ?? "", s.arr ?? ""]
    .join("|");
}

export function removeHistory(id, storage) {
  const list = loadHistory(storage).filter((x) => x.id !== id);
  write(list, storage);
  return list;
}

export function clearHistory(storage) {
  write([], storage);
  return [];
}

/**
 * 読み込んだ一覧を、そのまま書き込みます。
 *
 * ファイルから戻すときに使います（js/transfer.js）。addHistory は
 * 1件ずつ足す口なので、控えを丸ごと戻すには向きません（10件の上限に
 * 当たると、戻したそばから落ちていきます）。
 *
 * **上限は守ります。** localStorage は端末の容量です。上限を外すと、
 * いつか書き込めなくなり、そのとき失うのは新しいぶんです。
 *
 * @returns {Array} 実際に残った一覧
 */
export function replaceHistory(list, storage) {
  const keep = (Array.isArray(list) ? list : []).filter(isValid).slice(0, MAX);
  write(keep, storage);
  return loadHistory(storage);
}

function write(list, storage) {
  // 旅程まで持つと、1件が数十KBになります。localStorage がいっぱいなら、
  // **古いものから落として**、新しいぶんだけでも残します。何も残らない
  // よりはましです。
  let keep = [...list];
  if (!keep.length) {
    try { store(storage)?.setItem(KEY, "[]"); } catch { /* 消せなくても続けます */ }
    return;
  }
  while (keep.length) {
    try {
      store(storage)?.setItem(KEY, JSON.stringify(keep));
      return;
    } catch {
      if (keep.length === 1) {
        // 1件でも入らないなら、旅程を落として条件だけにします。
        try {
          store(storage)?.setItem(KEY,
            JSON.stringify(keep.map((x) => ({ ...x, itin: null }))));
        } catch { /* 保存できなくても、旅程は作れます */ }
        return;
      }
      keep = keep.slice(0, keep.length - 1);
    }
  }
}

/**
 * 「3日前」「9月5日」のような、一覧に出す言葉。
 *
 * 時刻までは出しません。一覧で知りたいのは「いつごろ作ったか」で、
 * 何時何分に作ったかではありません。
 */
export function savedLabel(savedAt, now = new Date()) {
  if (!Number.isFinite(savedAt)) return "";
  const days = Math.floor((now - savedAt) / 86400000);
  if (days <= 0) return "今日";
  if (days === 1) return "昨日";
  if (days < 7) return `${days}日前`;
  const d = new Date(savedAt);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
