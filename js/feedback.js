// 行ってきた旅の感想を、任意で残す。
//
// 旅程は「この時間で回れるはず」という見込みで組んでいます。見込みが
// 外れたところ——行ったら閉まっていた、乗り継ぎが間に合わなかった、
// 1時間では足りなかった——は、作った側からは見えません。
// 知識ベースの営業時間や、移動・滞在の見積もりを直すには、
// 実際に回った人の「ここは違った」がいちばん確かな手がかりです。
//
// いちばん大事にしたこと
// ----------------------
// **書かなくても、何も困らない。** 感想の欄は畳んであり、開かなければ
// 何も起きません。旅程づくりのどの機能も、感想の有無を見ません。
//
// **どこにも送らない。** 残すのはこの端末の中（localStorage）だけです。
// 開発者に届けたいときだけ、利用者が自分で「まとめ」をコピーするか、
// GitHub の Issue 画面を開いて、中身を見てから送ります。勝手には
// 送りません。使われかたの件数（js/metrics.js）とも混ぜません。
//
// **選ぶだけ。自由な文字は持たない。** 「行けた / 行けなかった」と、
// 決まった心当たり（営業時間が違った、など）を選ぶだけです。自由に
// 書ける欄を作ると、同行者の名前や泊まった家のような、旅程の改善に
// 要らない個人の情報が入りえます。
//
// 何を持たないか
// --------------
// 出発地・帰着地、位置情報、旅行の日付、入力した希望の文、端末の識別子。
// 「どの旅か」を見分ける印も、立ち寄った場所の並びから作った短い符号
// だけです（出発地を含む保存一覧の鍵は使いません）。
//
// 文書: docs/feedback.md

export const FEEDBACK_KEY = "tabisaki.feedback";
/** 覚えておく旅の数。古いものから落とします。 */
export const MAX_TRIPS = 50;
/** これより古い感想は、読むときに消します（日）。 */
export const RETAIN_DAYS = 180;
/** 1つの旅で覚える立ち寄り先の数。 */
export const MAX_SPOTS = 40;

/** 立ち寄り先ごとの結果。 */
export const STATUS = Object.freeze({
  went: "行けた",
  skipped: "行けなかった",
});

/** 立ち寄り先ごとの心当たり。ここに無いものは持ちません。 */
export const ISSUES = Object.freeze({
  hours: "営業時間が違った",
  closed: "休みだった・入れなかった",
  move: "移動が間に合わなかった",
  short: "時間が足りなかった",
  long: "時間が余った",
  crowd: "混んでいて待った",
});

/** 旅全体の詰め具合。 */
export const PACE = Object.freeze({
  ok: "ちょうどよかった",
  tight: "きつかった",
  loose: "ゆるかった",
});

const DAY_MS = 86400000;
const SPOT_ID = /^[\w:.\-]{1,80}$/;

function store(storage) {
  try {
    return storage ?? globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 文字列から短い符号を作ります（FNV-1a）。元には戻せません。 */
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 旅程に入っている立ち寄り先（重複なし、出てくる順）。 */
export function spotsOf(itin) {
  const seen = new Set();
  const out = [];
  for (const day of itin?.days ?? []) {
    for (const item of day?.items ?? []) {
      if (item?.kind !== "spot") continue;
      const id = String(item.spotId ?? item.place?.id ?? "");
      if (!SPOT_ID.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ spotId: id, name: String(item.place?.name ?? "").slice(0, 60) });
      if (out.length >= MAX_SPOTS) return out;
    }
  }
  return out;
}

/**
 * どの旅かを見分ける印。立ち寄り先の並びだけから作ります。
 * 同じ旅程を開き直したら、同じ印になります（感想を上書きできます）。
 */
export function tripKey(itin) {
  const ids = spotsOf(itin).map((s) => s.spotId);
  return ids.length ? `t${shortHash(ids.join(","))}` : "";
}

/**
 * 旅が始まっているか。感想の欄は、行ったあとにだけ出します。
 * 行く前に「行けなかった」を選ばれても、何の手がかりにもなりません。
 */
export function tripStarted(itin, now = new Date()) {
  const first = itin?.days?.[0]?.items?.[0]?.start;
  const t = first instanceof Date ? first.getTime() : Date.parse(first);
  return Number.isFinite(t) && t <= now.getTime();
}

/**
 * 持ってよいものだけにします。知らない値は落とします。
 * @returns {object|null}
 */
export function cleanEntry(raw, now = new Date()) {
  if (!raw || typeof raw !== "object") return null;
  const key = String(raw.key ?? "");
  if (!/^t[0-9a-z]{1,12}$/.test(key)) return null;
  const spots = [];
  const seen = new Set();
  for (const s of Array.isArray(raw.spots) ? raw.spots : []) {
    const id = String(s?.spotId ?? "");
    if (!SPOT_ID.test(id) || seen.has(id)) continue;
    const status = Object.hasOwn(STATUS, s.status) ? s.status : "";
    const issues = [...new Set((Array.isArray(s.issues) ? s.issues : [])
      .filter((x) => Object.hasOwn(ISSUES, x)))];
    // 何も選んでいない立ち寄り先は、持つ意味がありません。
    if (!status && !issues.length) continue;
    seen.add(id);
    spots.push({ spotId: id, name: String(s.name ?? "").slice(0, 60), status, issues });
    if (spots.length >= MAX_SPOTS) break;
  }
  const pace = Object.hasOwn(PACE, raw.pace) ? raw.pace : "";
  if (!spots.length && !pace) return null;
  const savedAt = Number(raw.savedAt);
  return {
    key,
    region: String(raw.region ?? "").slice(0, 40),
    pace,
    spots,
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : now.getTime(),
  };
}

function expired(entry, now) {
  return now.getTime() - entry.savedAt > RETAIN_DAYS * DAY_MS;
}

function write(list, storage) {
  const s = store(storage);
  try {
    if (!list.length) s?.removeItem(FEEDBACK_KEY);
    else s?.setItem(FEEDBACK_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;   // 空きが無い・保存できない環境。感想が残らないだけです
  }
}

/**
 * 残っている感想。新しい順。保存期間を過ぎたものは、ここで消します。
 */
export function loadFeedback(storage, now = new Date()) {
  const s = store(storage);
  let list;
  try {
    const raw = s?.getItem(FEEDBACK_KEY);
    list = raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const clean = list.map((x) => cleanEntry(x, now)).filter(Boolean);
  const kept = clean.filter((x) => !expired(x, now));
  if (kept.length !== list.length) write(kept, s);
  return kept;
}

/** その旅の感想（無ければ null）。 */
export function feedbackFor(key, storage, now = new Date()) {
  return loadFeedback(storage, now).find((x) => x.key === key) ?? null;
}

/**
 * 感想を1件残します。同じ旅なら上書きします。
 * @returns {object|null} 残したもの（持つものが何も無ければ null）
 */
export function saveFeedback(entry, storage, now = new Date()) {
  const clean = cleanEntry({ ...entry, savedAt: now.getTime() }, now);
  if (!clean) return null;
  const rest = loadFeedback(storage, now).filter((x) => x.key !== clean.key);
  write([clean, ...rest].slice(0, MAX_TRIPS), storage);
  return clean;
}

/** その旅の感想を消します。 */
export function removeFeedback(key, storage, now = new Date()) {
  write(loadFeedback(storage, now).filter((x) => x.key !== key), storage);
}

/** 感想をすべて消します。 */
export function clearFeedback(storage) {
  return write([], storage);
}

/**
 * 集計します。立ち寄り先ごとに「何回、何が起きたか」を数えます。
 * 心当たりの多い順に並べます。
 */
export function summarize(list) {
  const pace = { ok: 0, tight: 0, loose: 0 };
  const spots = new Map();
  for (const e of list ?? []) {
    if (e.pace) pace[e.pace]++;
    for (const s of e.spots) {
      const row = spots.get(s.spotId) ?? {
        spotId: s.spotId, name: s.name, went: 0, skipped: 0,
        issues: Object.fromEntries(Object.keys(ISSUES).map((k) => [k, 0])),
      };
      if (s.status) row[s.status]++;
      for (const i of s.issues) row.issues[i]++;
      if (!row.name && s.name) row.name = s.name;
      spots.set(s.spotId, row);
    }
  }
  const weight = (r) => r.skipped + Object.values(r.issues).reduce((a, b) => a + b, 0);
  const rows = [...spots.values()].sort((a, b) => weight(b) - weight(a)
    || a.spotId.localeCompare(b.spotId));
  return { trips: (list ?? []).length, pace, spots: rows };
}

const cell = (s) => String(s).replace(/[|\n\r]/g, " ").trim();

/**
 * 開発者へ渡す「まとめ」。Markdown です。
 *
 * 利用者が画面で中身を読んでから、自分でコピーするか Issue に貼ります。
 * 入るのは、立ち寄り先の id と名前、選んだ項目の件数だけです。
 */
export function reportMarkdown(summary) {
  const lines = [
    "## 旅の感想のまとめ",
    "",
    `- 旅の数: ${summary.trips}`,
    `- 詰め具合: ちょうどよい ${summary.pace.ok} · きつい ${summary.pace.tight} · ゆるい ${summary.pace.loose}`,
    "",
  ];
  const flagged = summary.spots.filter((r) => r.skipped
    || Object.values(r.issues).some((n) => n > 0));
  if (flagged.length) {
    const keys = Object.keys(ISSUES);
    lines.push(
      `| スポット | id | 行けなかった | ${keys.map((k) => ISSUES[k]).join(" | ")} |`,
      `|---|---|---:|${keys.map(() => "---:").join("|")}|`,
      ...flagged.map((r) => `| ${cell(r.name || "（名前なし）")} | \`${r.spotId}\` | ${r.skipped} | `
        + `${keys.map((k) => r.issues[k]).join(" | ")} |`),
    );
  } else {
    lines.push("見込みと違ったところはありませんでした。");
  }
  lines.push("", "<!-- tabisaki feedback v1 -->");
  return lines.join("\n");
}

export const ISSUE_REPO = "shitianliang1000-alt/tabisaki-app";
/** URL が長すぎると GitHub が開けないので、本文はここで切ります。 */
const MAX_URL_BODY = 6000;

/** GitHub の「新しい Issue」画面を、まとめを入れた状態で開く URL。 */
export function issueUrl(markdown, repo = ISSUE_REPO) {
  let body = String(markdown ?? "");
  if (body.length > MAX_URL_BODY) body = `${body.slice(0, MAX_URL_BODY)}\n\n（長いので途中までです）`;
  const q = new URLSearchParams({ title: "[旅の感想] ", labels: "feedback", body });
  return `https://github.com/${repo}/issues/new?${q}`;
}
