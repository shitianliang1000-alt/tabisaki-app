// 旅程をカレンダーへ。
//
// 旅程を作ったあと、旅行者が次にすることは「カレンダーに入れる」です。
// 当日に開くのは、このアプリではなくカレンダーだからです。前日の夜に
// 通知が出て、朝に予定が並んでいる。そこまで届かないと、作った旅程は
// 使われません。
//
// .ics（RFC 5545）は、Googleカレンダー・Appleカレンダー・Outlook が
// どれも読める唯一の形式です。書き出しはブラウザの中だけで済むので、
// どこにも送りません。
//
// 時刻は**その土地の時刻のまま**（浮動時間）で書きます。UTC に直すと、
// 端末の時計が別の国に合っている人には、ずれた時刻が並びます。
// 日本を旅する人の旅程は、日本の時刻で読まれるべきものです。

/** 予定として書き出す種類。空き時間は、書いても相手にすることがありません。 */
// 「荷物を預ける」も入れます。朝いちに何をするかは、家を出る前に
// 通知が要る種類の予定です（luggage.js が入れています）。
import { attributionText, spotOfItem } from "../packages/core/src/provenance.js";

const KINDS = new Set(["spot", "meal", "lodging", "transit", "luggage"]);

const pad = (n) => String(n).padStart(2, "0");

/** RFC 5545 の日時（浮動時間。末尾に Z を付けません）。 */
function stamp(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return null;
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`
    + `T${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
}

/** UTC の日時。DTSTAMP（作った時刻）だけに使います。 */
function stampUtc(d) {
  const t = d instanceof Date ? d : new Date(d);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`
    + `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
}

/**
 * 値の中の記号を逃がします（RFC 5545 §3.3.11）。
 *
 * ここを抜かすと、説明文にカンマが1つ入っただけで、その行から先が
 * 別の項目として読まれます。カレンダーは黙って壊れた予定を作ります。
 */
function esc(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/**
 * 1行を75オクテットで折ります（RFC 5545 §3.1）。
 *
 * **文字数ではなくオクテットで数えます。** 日本語は1文字3オクテットなので、
 * 文字数で折ると1行が225オクテットになり、厳しめの実装に弾かれます。
 * そして**文字の途中で折ってはいけません**。折り返した先は空白1つで
 * 始めます。
 */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    // 2行目以降は先頭の空白1つぶんを差し引いて数えます。
    const limit = out.length ? 74 : 75;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = ch;
      curBytes = n;
    } else {
      cur += ch;
      curBytes += n;
    }
  }
  if (cur) out.push(cur);
  return out[0] + out.slice(1).map((s) => `\r\n ${s}`).join("");
}

/** 予定の題。絵文字は入れません（カレンダー側で化けることがあります）。 */
function summaryOf(item) {
  const title = String(item.title ?? "").trim();
  if (item.kind === "lodging") return `宿泊: ${title}`;
  // 食事は、何を食べる土地かまで題に入れます。カレンダーの1行だけを
  // 見ることが多いので、そこに無いと分かりません（meals.js）。
  if (item.kind === "meal") {
    const what = item.food?.spotName ?? item.food?.dish;
    return what ? `${title}: ${what}` : title;
  }
  return title;
}

/** 予定の説明。何で移動するか、確かめた情報かどうかを添えます。 */
function descriptionOf(item) {
  const parts = [];
  if (item.detail) parts.push(String(item.detail));
  if (item.kind === "transit") {
    if (item.taxi) parts.push("近くに駅・バス停が無いため、タクシーを想定した目安です。");
    else if (item.transitDoc ?? item.yahoo) parts.push("乗り換え検索で調べた実際の便です。");
    else if (!item.routed) parts.push("距離からの目安です。実際の便は時刻表でご確認ください。");
  }
  if (item.kind === "spot" && item.estimated) {
    parts.push("営業時間は分類ごとの目安です。訪問前に公式情報をご確認ください。");
  }
  // 駄目だったときの代わり。カレンダーは現地で見るものなので、
  // ここに入っていれば電波が弱くても読めます（backup.js）。
  if (item.backup?.text) parts.push(`代わり: ${item.backup.text}`);
  if (typeof item.costYen === "number" && item.costYen > 0) {
    parts.push(`目安の費用: ¥${item.costYen.toLocaleString("ja-JP")}`);
  }
  // 出典。カレンダーに入れたあとは、この予定だけが独り歩きします。
  // だから予定ごとに、その場所のデータの出どころを書きます（#426）。
  const spot = spotOfItem(item);
  if (spot) {
    const credit = attributionText([spot]);
    if (credit) parts.push(credit);
  }
  return parts.join("\n");
}

/** 予定の場所。あるものだけを書きます。 */
function locationOf(item) {
  if (item.kind === "transit") return String(item.to?.name ?? "");
  return String(item.place?.name ?? item.title ?? "");
}

/** その予定の座標。地図を持っていない予定（自由時間など）は null。 */
function pointOf(item) {
  const p = item.kind === "transit" ? item.to : (item.place ?? item.to);
  if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) return null;
  return { lat: p.lat, lng: p.lng };
}

/**
 * 通知を何分前に出すか。
 *
 * **カレンダーに入れただけでは、鳴りません。** 予定が並ぶだけです。
 * 旅の当日にアプリを開かない人（開かないのが普通です）には、
 * 通知が唯一の届きかたです。
 *
 * 何分前かは、その予定で「間に合わなくなるまでの余裕」で決めます。
 *
 *   移動    10分前  乗り遅れると次の便まで待ちます。駅にいる必要が
 *                   あるので、いちばん短く取ります。
 *   荷物    15分前  朝いちの一手です。宿を出る前に思い出す必要があります。
 *   食事    15分前  席を探す時間です。
 *   立ち寄り 20分前  入場券・最終入場があります。
 *   宿      60分前  チェックインの時刻に間に合うかどうかは、その日の
 *                   終わりかたを決めます。
 *
 * 出発の前夜にも1つ置きます（旅の初日だけ）。荷造りは前の晩にします。
 */
const ALARM_MIN = {
  transit: 10, luggage: 15, meal: 15, spot: 20, lodging: 60,
};

/** VALARM を1つ分。DISPLAY は、どのカレンダーでも通る種類です。 */
function alarm(minutesBefore, text) {
  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(text)}`,
    `TRIGGER:-PT${minutesBefore}M`,
    "END:VALARM",
  ];
}

/**
 * 旅程を .ics の文字列にします。
 *
 * @param {object} itin 旅程（planner.js の形）
 * @param {{now?:Date, seed?:string}} [opts]
 *   now  … DTSTAMP に使う時刻（試験のために差し替えられます）
 *   seed … UID に混ぜる文字列。同じ旅程を2度入れても、同じ予定として
 *          更新されるようにするためのものです
 * @returns {string} VCALENDAR。予定が1つも無ければ空文字
 */
export function toIcs(itin, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const seed = String(opts.seed ?? "tabisaki");
  const dtstamp = stampUtc(now);
  const events = [];

  (itin?.days ?? []).forEach((day, di) => {
    for (const item of day?.items ?? []) {
      if (!KINDS.has(item.kind)) continue;
      const start = stamp(item.start);
      const end = stamp(item.end);
      if (!start || !end) continue;
      const lines = [
        "BEGIN:VEVENT",
        `UID:${esc(`${seed}-${di}-${item.id ?? events.length}`)}@tabisaki`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART:${start}`,
        // 同じ時刻で始まって終わる予定は、カレンダーによっては消えます。
        `DTEND:${end === start ? stamp(new Date(new Date(item.start).getTime() + 900000)) : end}`,
        `SUMMARY:${esc(summaryOf(item))}`,
      ];
      const loc = locationOf(item);
      if (loc) lines.push(`LOCATION:${esc(loc)}`);
      // 座標も入れます（RFC 5545 §3.8.1.6）。
      //
      // 場所の名前だけだと、カレンダーの「地図で開く」は名前で
      // 検索します。「出雲大社」なら当たりますが、「稲佐の浜入口」の
      // ような停留所名では別の場所が開きます。座標があれば、
      // Apple カレンダーも Google カレンダーもそこを指します。
      const at = pointOf(item);
      if (at) lines.push(`GEO:${at.lat.toFixed(6)};${at.lng.toFixed(6)}`);
      const desc = descriptionOf(item);
      if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
      // 通知。
      //
      // **これが無いと、カレンダーに入れても鳴りません。** 予定が
      // 並ぶだけです。旅の当日にこのアプリを開かない人（開かないのが
      // 普通です）には、通知が唯一の届きかたでした。
      const before = ALARM_MIN[item.kind];
      if (before) {
        lines.push(...alarm(before, `${before}分後: ${summaryOf(item)}`));
      }
      lines.push("END:VEVENT");
      events.push(...lines);
    }
  });

  if (!events.length) return "";

  // 出発の前夜に、1つだけ。
  //
  // 旅の当日にいちばん困るのは「持ってくるのを忘れた」です。予定の
  // 10分前に鳴らしても、そのときにはもう家を出ています。前の晩に
  // 一度だけ、荷造りのための通知を置きます。
  //
  // 時刻を持たない予定（終日）にすると、カレンダーによっては
  // 通知が出ません。前夜の20時に置きます。
  const firstStart = (itin?.days ?? [])
    .flatMap((d) => d?.items ?? [])
    .map((i) => new Date(i.start))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b)[0];
  if (firstStart) {
    const eve = new Date(firstStart);
    eve.setDate(eve.getDate() - 1);
    eve.setHours(20, 0, 0, 0);
    // 出発が朝いちでないなら、前夜より当日の朝のほうが近いことも
    // ありますが、荷造りは前の晩にするものなので前夜に置きます。
    const evStart = stamp(eve);
    const evEnd = stamp(new Date(eve.getTime() + 900000));
    const what = [itin?.title, itin?.prefecture].filter(Boolean).join("・")
      || "旅";
    events.unshift(
      "BEGIN:VEVENT",
      `UID:${esc(`${seed}-eve`)}@tabisaki`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${evStart}`,
      `DTEND:${evEnd}`,
      `SUMMARY:${esc(`明日から ${what}`)}`,
      `DESCRIPTION:${esc("荷造りと、行き先の営業時間・運行状況の確認を。"
        + `出発は ${firstStart.getHours()}時`
        + `${pad(firstStart.getMinutes())}分です。`)}`,
      ...alarm(0, `明日から ${what}`),
      "END:VEVENT");
  }

  const name = [itin?.title, itin?.prefecture].filter(Boolean).join(" · ")
    || "旅さきの旅程";
  const head = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tabisaki//itinerary//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
    "X-WR-TIMEZONE:Asia/Tokyo",
  ];
  return [...head, ...events, "END:VCALENDAR"]
    .map(fold).join("\r\n") + "\r\n";
}

/**
 * 保存するときのファイル名。
 *
 * **ASCII だけで組みます。**
 *
 * ブラウザの download 属性に日本語のファイル名を渡すと、環境によっては
 * **名前ごと捨てられ、拡張子まで失われます**（実際に、拡張子の無い
 * 「download」という名前で保存されました）。そうなると、受け取った
 * OS はカレンダーのファイルだと分からず、開くものが決まりません。
 *
 * 旅先の名前は、ファイルの中の X-WR-CALNAME で伝わります。カレンダーに
 * 並ぶのはそちらの名前なので、ファイル名は日付で足ります。
 */
export function icsFilename(itin) {
  const first = itin?.days?.[0]?.date;
  const d = first instanceof Date ? first : new Date(first);
  const day = Number.isNaN(d.getTime())
    ? "" : `-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  // 題が ASCII で書かれているときだけ、そのまま使います
  // （"Hakone" のようにローマ字で入力された旅）。
  const raw = String(itin?.title ?? "").replace(/[\\/:*?"<>|\s]+/g, "");
  const title = /^[\x20-\x7E]+$/.test(raw) ? raw : "";
  return `tabisaki${title ? `-${title}` : ""}${day || "-itinerary"}.ics`;
}
