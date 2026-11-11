// OpenStreetMap の opening_hours を、旅程で使う形（spot.hours）に読み替えます。
//
// 収録（kb/）には OSM の書式のまま入っています（tools/osm_enrich.py）。
//
//   "09:00-17:00"
//   "Tu-Su 09:30-17:00; Mo off"
//   "Apr-Oct 08:30-17:00; Nov-Mar 08:30-16:30; Dec 29-Jan 03 off"
//
// **読み切れた書きかただけを使います。** OSM の書式はとても広く（日の出・
// 第2火曜・隔週・祝日の前日…）、ぜんぶを旅程の形には直せません。分からない
// 部分を飛ばして残りだけ使うと、「第3水曜は休み」を落として、開いていると
// 言ってしまいます。1か所でも読めなければ、まるごと使いません（null）。
// そのときは、これまでどおり分類ごとの目安になります。
//
// 読み切れても使わないもの:
//   ・昼に閉まる書きかた（09:00-12:00,13:00-17:00）… 旅程の形は1日1区間
//     です。外側だけ取ると、閉まっている昼に着く旅程を組みます
//   ・祝日（PH）… 祝日の暦を持っていません。「PH off」は closedOnHolidays
//     として残し、曜日の並びの中の PH は読み飛ばします（平日と同じ時間で
//     開く、という意味がほとんどです）

const DAYS = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
                 Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const pad = (v) => String(v).padStart(2, "0");
const mmdd = (m, d) => `${pad(m)}-${pad(d)}`;

const DAY_RE = "(?:Mo|Tu|We|Th|Fr|Sa|Su)";
const HOL_RE = "(?:PH|SH)(?:\\s*[+-]\\d+\\s*days?)?";
const DAY_ITEM = `(?:${DAY_RE}(?:\\s*-\\s*${DAY_RE})?|${HOL_RE})`;
const DAY_LIST = new RegExp(`^(${DAY_ITEM}(?:\\s*,\\s*${DAY_ITEM})*)(?:\\s+|$)`);
const MON_RE = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
// 月の範囲（Apr-Oct）、日付の範囲（Dec 29-Jan 03、Aug 01-20）、1日（Jan 01）、月（Aug）。
const DATE_SEL = new RegExp(
  `^(${MON_RE})(?:\\s+(\\d{1,2}))?`
  + `(?:\\s*-\\s*(?:(${MON_RE})(?:\\s+(\\d{1,2}))?|(\\d{1,2})))?(?:\\s*:(?!\\d)\\s*|\\s+|$)`);
const TIME_SPAN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

/** "Mo-Fr,Su" → {days:Set, holiday:boolean}。読めなければ null。 */
function parseDays(text) {
  const days = new Set();
  let holiday = false;
  for (const raw of text.split(",")) {
    const item = raw.trim();
    if (/^(PH|SH)/.test(item)) { holiday = true; continue; }
    const m = item.match(/^(\w\w)(?:\s*-\s*(\w\w))?$/);
    if (!m || !(m[1] in DAYS) || (m[2] && !(m[2] in DAYS))) return null;
    const from = DAYS[m[1]];
    const to = m[2] ? DAYS[m[2]] : from;
    // 土曜から月曜（Sa-Mo）のように、週をまたぐ範囲もあります。
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return { days, holiday };
}

/** "09:00-17:00" や "09:00-12:00,12:00-17:00" → {open, close}。読めなければ null。 */
function parseTimes(text) {
  const spans = [];
  for (const raw of text.split(",")) {
    const m = raw.trim().match(TIME_SPAN);
    if (!m) return null;
    const open = Number(m[1]) + Number(m[2]) / 60;
    let close = Number(m[3]) + Number(m[4]) / 60;
    if (Number(m[2]) > 59 || Number(m[4]) > 59 || open >= 24) return null;
    // 日付をまたぐ（18:00-02:00、18:00-26:00）ものは、その日の終わりまで。
    if (close <= open || close > 24) close = 24;
    spans.push({ open, close });
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a.open - b.open);
  for (let i = 1; i < spans.length; i++) {
    // 間が空いている（昼に閉まる）ものは、1区間では表せません。
    if (spans[i].open > spans[i - 1].close) return null;
  }
  return { open: spans[0].open,
           close: Math.max(...spans.map((s) => s.close)) };
}

/** 規則の頭の日付の指定。{from, to, wholeMonths, rest} か、無ければ null。 */
function parseDateSel(text) {
  const m = text.match(DATE_SEL);
  if (!m) return null;
  const m1 = MONTHS[m[1]];
  const d1 = m[2] ? Number(m[2]) : null;
  let m2 = m1;
  let d2 = d1;
  if (m[3]) {
    m2 = MONTHS[m[3]];
    d2 = m[4] ? Number(m[4]) : null;
    // 「Dec 29-Jan」「Apr-Oct 15」のように片方だけ日があるものは、読みません。
    if ((d1 === null) !== (d2 === null)) return false;
  } else if (m[5]) {
    if (d1 === null) return false;
    d2 = Number(m[5]);
  }
  const wholeMonths = d1 === null;
  const fromDay = d1 ?? 1;
  const toDay = d2 ?? MONTH_DAYS[m2];
  if (fromDay < 1 || fromDay > MONTH_DAYS[m1] || toDay < 1 || toDay > MONTH_DAYS[m2]) {
    return false;
  }
  return { from: mmdd(m1, fromDay), to: mmdd(m2, toDay), wholeMonths,
           months: [m1, m2], rest: text.slice(m[0].length).trim() };
}

/** 1年の何日目か（うるう年の暦で 0〜365）。 */
function dayIndex(md) {
  const [m, d] = md.split("-").map(Number);
  let n = d - 1;
  for (let i = 1; i < m; i++) n += MONTH_DAYS[i];
  return n;
}

function mdOf(index) {
  let m = 1;
  let n = index;
  while (n >= MONTH_DAYS[m]) { n -= MONTH_DAYS[m]; m += 1; }
  return mmdd(m, n + 1);
}

/** どの季節にも入っていない日の範囲（"MM-DD..MM-DD"）。 */
function uncovered(seasons) {
  const covered = new Array(366).fill(false);
  for (const x of seasons) {
    const to = dayIndex(x.to);
    for (let i = dayIndex(x.from); ; i = (i + 1) % 366) {
      covered[i] = true;
      if (i === to) break;
    }
  }
  const out = [];
  for (let i = 0; i < 366; i++) {
    if (covered[i]) continue;
    let end = i;
    while (end < 365 && !covered[end + 1]) end++;
    out.push(`${mdOf(i)}..${mdOf(end)}`);
    i = end;
  }
  return out;
}

/**
 * OSM の opening_hours を spot.hours の形に。
 *
 * @param {string} value
 * @returns {null | {open:number, close:number, closedDays?:number[],
 *   byDay?:object, seasons?:object[], closedDates?:string[],
 *   closedSeasons?:string[], closedOnHolidays?:boolean}}
 */
export function parseOpeningHours(value) {
  let s = String(value ?? "").normalize("NFKC").trim();
  if (!s || s.length > 255) return null;
  // 代わりの規則（||）、週の番号、第n曜日、日の出・日の入り、開始だけ（17:00+）。
  if (/\|\||week\b|\[|sunrise|sunset|dawn|dusk|\d\+|easter/i.test(s)) return null;
  // 注記（"要予約" など）は、意味を変えることがあります。あるものは使いません。
  if (s.includes('"')) return null;
  if (s === "24/7") return { open: 0, close: 24 };

  /** 曜日ごとの決まり。undefined=書かれていない／null=休み／{open,close} */
  const week = new Array(7).fill(undefined);
  const seasons = [];
  const closedDates = [];
  let closedOnHolidays = false;

  for (const raw of s.split(";")) {
    let rule = raw.trim();
    if (!rule) continue;

    const date = parseDateSel(rule);
    if (date === false) return null;
    if (date) rule = date.rest;

    let days = null;
    const dm = rule.match(DAY_LIST);
    if (dm) {
      days = parseDays(dm[1]);
      if (!days) return null;
      rule = rule.slice(dm[0].length).trim();
    }

    let state;                    // null=休み／{open,close}
    if (/^(off|closed)$/i.test(rule)) state = null;
    else if (rule === "" || /^open$/i.test(rule)) {
      // 時刻の無い「開いている」。24/7 と同じ意味で書かれることがあります。
      if (rule === "" && !days && !date) return null;
      state = { open: 0, close: 24 };
    } else {
      state = parseTimes(rule);
      if (!state) return null;
    }

    if (date) {
      if (days && !days.days.size) continue;    // 「Aug PH off」のような祝日だけの決まり
      const everyDay = !days || days.days.size === 7;
      if (state === null) {
        // 月と曜日を組み合わせた休み（Dec-Feb Mo off）は、旅程の形に無いので読みません。
        if (!everyDay) return null;
        closedDates.push(`${date.from}..${date.to}`);
      } else {
        // 「Apr-Sep Tu-Su 09:00-17:00」。書かれていない曜日（月曜）は休みです。
        // 季節ごとに曜日が違う書きかたは表せないので、あとで揃っているか見ます。
        seasons.push({ from: date.from, to: date.to, ...state,
                       days: everyDay ? null : [...days.days].sort() });
      }
      continue;
    }

    if (days && !days.days.size) {
      // 祝日だけの決まり。休みなら控えます。時間が違うだけなら読み飛ばします。
      if (state === null) closedOnHolidays = true;
      continue;
    }
    if (days?.holiday && state === null) closedOnHolidays = true;
    const target = days ? [...days.days] : [0, 1, 2, 3, 4, 5, 6];
    for (const d of target) week[d] = state;
  }

  // 季節の決まりに曜日が付いているとき、どの季節も同じ曜日でなければ読みません。
  const seasonDays = seasons.length ? JSON.stringify(seasons[0].days) : "null";
  if (seasons.some((x) => JSON.stringify(x.days) !== seasonDays)) return null;
  const seasonOpenDays = seasons.length && seasons[0].days
    ? new Set(seasons[0].days) : null;

  const out = {};
  const openDays = week.filter(Boolean);
  if (openDays.length) {
    // 季節の決まりの曜日と、ふだんの決まりを重ねる書きかたは読みません。
    if (seasonOpenDays) return null;
    // 書かれていない曜日は、休みです（"Mo-Fr 09:00-17:00" の土日）。
    const closedDays = [];
    const tally = new Map();
    for (let d = 0; d < 7; d++) {
      const v = week[d];
      if (!v) { closedDays.push(d); continue; }
      const key = `${v.open}-${v.close}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    // いちばん多い時間を基本にして、違う曜日だけを byDay に書きます。
    const [baseKey] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const [open, close] = baseKey.split("-").map(Number);
    out.open = open;
    out.close = close;
    if (closedDays.length) out.closedDays = closedDays;
    const byDay = {};
    for (let d = 0; d < 7; d++) {
      const v = week[d];
      if (v && (v.open !== open || v.close !== close)) byDay[d] = { ...v };
    }
    if (Object.keys(byDay).length) out.byDay = byDay;
  } else if (seasons.length) {
    // 時間は季節の決まりだけ（"Apr-Oct 09:00-17:00; Nov-Mar 09:00-16:00; Mo off"）。
    // 休みの曜日は、ふだんの決まりの「off」と、季節の決まりに書かれて
    // いない曜日です。
    out.open = seasons[0].open;
    out.close = seasons[0].close;
    const closedDays = [];
    for (let d = 0; d < 7; d++) {
      if (week[d] === null || (seasonOpenDays && !seasonOpenDays.has(d))) closedDays.push(d);
    }
    if (closedDays.length === 7) return null;
    if (closedDays.length) out.closedDays = closedDays;
    // どの季節にも入っていない日は、休みです（"Apr-Nov 09:00-17:00" の冬）。
    const closedSeasons = uncovered(seasons);
    if (closedSeasons.length) out.closedSeasons = closedSeasons;
  } else {
    return null;                                // 毎日休みか、時間がどこにも無い
  }

  if (seasons.length) {
    out.seasons = seasons.map(({ from, to, open, close }) => ({ from, to, open, close }));
  }
  if (closedDates.length) out.closedDates = closedDates;
  if (closedOnHolidays) out.closedOnHolidays = true;
  return out;
}

/**
 * 収録の1件に、OSM の営業時間を当てます（その場で書き換えます）。
 *
 * **収録が自分で持っている時間が勝ちます。** 手で確かめた open / close や
 * hours があれば、OSM の値は使いません。
 *
 * @returns {boolean} 当てたか
 */
export function applyOsmHours(spot) {
  const raw = spot?.osmInfo?.opening_hours;
  if (!raw) return false;
  if (spot.hours || spot.open !== undefined || spot.close !== undefined) return false;
  const parsed = parseOpeningHours(raw);
  if (!parsed) return false;
  spot.hours = { ...parsed, source: "osm" };
  return true;
}
