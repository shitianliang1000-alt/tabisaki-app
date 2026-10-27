// スポットの「足した情報」（別名・営業時間・季節の催し・写真）と、手で決めたエリア。
//
// 公式の収録（kb/）には手を入れません。足した情報は、利用者の手元の1ファイル
// （userdata.mjs が読み書き）に、**値ごとに出典と確認の状態を付けて**持ちます。
//
//   {
//     "version": 1,
//     "spots": {
//       "<スポットの id>": {
//         "aliases":  [Field<string>],
//         "hours":    Field<Hours>,           … packages/core/src/hours.js の spot.hours と同じ形
//         "seasonal": [Field<Seasonal>],
//         "photos":   [Field<Photo>]
//       }
//     },
//     "areas": { "<エリアの id>": Area },
//     "candidates": [Field<Candidate>]        … AI が出した候補（旅程には使わない）
//   }
//
// Field は「値＋出どころ」の封筒です。
//
//   { "value": …,
//     "origin": "manual" | "wikipedia" | "wikidata" | "commons" | "llm",
//     "status": "verified" | "unverified",
//     "source": { "name": "…", "url": "…", "license": "…", "retrievedAt": "YYYY-MM-DD" },
//     "checkedAt": "YYYY-MM-DD" }              … 人が確かめた日（verified のとき）
//
// 決まり
//   ・自動で取ったもの・AI が出したもの（manual 以外）は、必ず unverified で入ります。
//     人が `spot verify` で確かめるまで、旅程の計算には使いません。
//   ・手で入れたもの（manual）は、入れた人が確かめたものとして verified で入ります。
//   ・どの値にも出典名と取った日（retrievedAt）が要ります。写真はライセンスと作者も要ります。

export const SCHEMA_VERSION = 1;
export const ORIGINS = ["manual", "wikipedia", "wikidata", "commons", "llm"];
export const STATUSES = ["verified", "unverified"];

/** 古くなったと見なすまでの日数。営業時間は変わりやすいので短めです。 */
export const STALE_DAYS = { hours: 180, seasonal: 365, aliases: 1095, photos: 1095, candidates: 90 };

export const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MMDD_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function emptyStore() {
  return { version: SCHEMA_VERSION, spots: {}, areas: {}, candidates: [] };
}

/** 日本時間の今日（YYYY-MM-DD）。 */
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

/**
 * 値を封筒に入れます。manual 以外は unverified で入ります（決まり）。
 * @param {*} value
 * @param {{origin:string, source:{name:string,url?:string,license?:string,retrievedAt?:string}, today?:string}} o
 */
export function makeField(value, { origin, source, today = todayJst() }) {
  if (!ORIGINS.includes(origin)) throw new Error(`知らない出どころです: ${origin}`);
  const manual = origin === "manual";
  const f = {
    value,
    origin,
    status: manual ? "verified" : "unverified",
    source: { ...source, retrievedAt: source?.retrievedAt ?? today },
  };
  if (manual) f.checkedAt = today;
  return f;
}

/** 人が確かめた印を付けます。 */
export function verifyField(field, today = todayJst()) {
  return { ...field, status: "verified", checkedAt: today };
}

// --- 営業時間 ---------------------------------------------------------------

/** "9:00" → 9、"16:30" → 16.5。24:00 まで。 */
export function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`時刻は H:MM で書いてください: ${s}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`時刻がおかしいです: ${s}`);
  return h + min / 60;
}

export function clockText(h) {
  const total = Math.round(h * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "月,水" や "月・水" や "1,3" を曜日の番号（0=日）にします。 */
export function parseDays(s) {
  const out = [];
  for (const part of String(s).split(/[,、・\s]+/).filter(Boolean)) {
    const w = part.replace(/曜日?$/, "");
    let n = DAY_NAMES.indexOf(w);
    if (n < 0 && /^[0-6]$/.test(w)) n = Number(w);
    if (n < 0) throw new Error(`曜日が読めません: ${part}（月・火 … 日 で書いてください）`);
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** "12-29..01-03" の形か（年をまたいでもよい）。 */
export function parseMmddRange(s) {
  const [from, to = from] = String(s).split("..");
  if (!MMDD_RE.test(from) || !MMDD_RE.test(to)) throw new Error(`期間は MM-DD..MM-DD で書いてください: ${s}`);
  return `${from}..${to}`;
}

/**
 * 端末で書いた営業時間を、packages/core/src/hours.js が読む spot.hours の形にします。
 * @param {string} range "9:00-17:00"（"24h" で一日中）
 * @param {{closed?:string, lastEntry?:string, closedSeason?:string}} [opts]
 */
export function parseHours(range, opts = {}) {
  const h = {};
  if (/^(24h|終日|24時間)$/i.test(String(range).trim())) {
    h.open = 0; h.close = 24;
  } else {
    const m = /^([^-〜~]+)[-〜~]([^-〜~]+)$/.exec(String(range).trim());
    if (!m) throw new Error(`営業時間は 9:00-17:00 の形で書いてください: ${range}`);
    h.open = parseClock(m[1]);
    h.close = parseClock(m[2]);
    if (h.close <= h.open) throw new Error(`閉まる時刻が開く時刻より前です: ${range}`);
  }
  if (opts.lastEntry) {
    h.lastEntry = parseClock(opts.lastEntry);
    if (h.lastEntry < h.open || h.lastEntry > h.close) throw new Error(`最終入場が営業時間の外です: ${opts.lastEntry}`);
  }
  if (opts.closed) h.closedDays = parseDays(opts.closed);
  if (opts.closedSeason) h.closedSeasons = String(opts.closedSeason).split(",").map(parseMmddRange);
  return h;
}

export function describeHoursValue(h) {
  if (!h) return "";
  const parts = [h.open === 0 && h.close === 24 ? "終日" : `${clockText(h.open)}〜${clockText(h.close)}`];
  if (h.lastEntry !== undefined) parts.push(`最終入場 ${clockText(h.lastEntry)}`);
  if (h.closedDays?.length) parts.push(`定休 ${h.closedDays.map((d) => `${DAY_NAMES[d]}曜`).join("・")}`);
  if (h.closedSeasons?.length) parts.push(`休業期間 ${h.closedSeasons.join("・")}`);
  return parts.join("・");
}

// --- 確かめる ---------------------------------------------------------------

function checkField(f, path, errors, checkValue) {
  if (!f || typeof f !== "object") { errors.push(`${path}: 値の封筒（value・origin・status・source）になっていません`); return; }
  if (!("value" in f)) errors.push(`${path}.value がありません`);
  if (!ORIGINS.includes(f.origin)) errors.push(`${path}.origin は ${ORIGINS.join(" / ")} のどれかです`);
  if (!STATUSES.includes(f.status)) errors.push(`${path}.status は verified / unverified のどちらかです`);
  if (f.origin !== "manual" && f.status === "verified" && !DAY_RE.test(f.checkedAt ?? "")) {
    errors.push(`${path}: 自動で取った値を verified にするには checkedAt（確かめた日）が要ります`);
  }
  if (f.checkedAt !== undefined && !DAY_RE.test(f.checkedAt)) errors.push(`${path}.checkedAt は YYYY-MM-DD です`);
  const s = f.source;
  if (!s || typeof s !== "object" || !String(s.name ?? "").trim()) errors.push(`${path}.source.name（出典）がありません`);
  else if (!DAY_RE.test(s.retrievedAt ?? "")) errors.push(`${path}.source.retrievedAt（取った日）は YYYY-MM-DD です`);
  if (s?.url !== undefined && !/^https?:\/\//.test(s.url)) errors.push(`${path}.source.url は http(s) の URL です`);
  if (f && "value" in f) checkValue?.(f.value, `${path}.value`, errors, f);
}

const isHour = (n) => typeof n === "number" && n >= 0 && n <= 24;

function checkHours(v, path, errors) {
  if (!v || typeof v !== "object") { errors.push(`${path}: 営業時間の形ではありません`); return; }
  if (!isHour(v.open) || !isHour(v.close) || v.close <= v.open) errors.push(`${path}: open・close は 0〜24 の時で、close が後です`);
  if (v.lastEntry !== undefined && (!isHour(v.lastEntry) || v.lastEntry < v.open || v.lastEntry > v.close)) errors.push(`${path}.lastEntry が営業時間の外です`);
  if (v.closedDays !== undefined && !(Array.isArray(v.closedDays) && v.closedDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) errors.push(`${path}.closedDays は 0（日）〜6（土）の並びです`);
  for (const r of v.closedSeasons ?? []) {
    try { parseMmddRange(r); } catch { errors.push(`${path}.closedSeasons: ${r} は MM-DD..MM-DD です`); }
  }
}

function checkSeasonal(v, path, errors) {
  if (!String(v?.name ?? "").trim()) errors.push(`${path}.name（催しの名前）がありません`);
  if (!MMDD_RE.test(v?.from ?? "") || !MMDD_RE.test(v?.to ?? "")) errors.push(`${path}: from・to は MM-DD です`);
}

function checkPhoto(v, path, errors, f) {
  if (!/^https?:\/\//.test(v?.url ?? "") && !String(v?.file ?? "").trim()) errors.push(`${path}: url（https）か file（手元の写真）が要ります`);
  if (!String(f?.source?.license ?? "").trim()) errors.push(`${path}: 写真にはライセンス（source.license）が要ります`);
  if (!String(v?.author ?? "").trim()) errors.push(`${path}.author（撮った人）がありません`);
}

function checkArea(a, path, errors) {
  if (!String(a?.name ?? "").trim()) errors.push(`${path}.name がありません`);
  const byCircle = a?.center && Number.isFinite(a.center.lat) && Number.isFinite(a.center.lng);
  const bySpots = Array.isArray(a?.spots) && a.spots.length > 0;
  if (byCircle === bySpots) errors.push(`${path}: center＋radiusKm か spots のどちらか一方で決めてください`);
  if (byCircle && !(a.radiusKm > 0 && a.radiusKm <= 100)) errors.push(`${path}.radiusKm は 0〜100 km です`);
  if (byCircle && (Math.abs(a.center.lat) > 90 || Math.abs(a.center.lng) > 180)) errors.push(`${path}.center が地球の外です`);
}

/**
 * 足した情報のファイルを確かめます。直すところの一覧を返します（空なら正しい）。
 * @param {object} doc
 * @param {{spotIds?: Set<string>}} [opts] 収録の id（渡すと、無い id も見つけます）
 */
export function validateStore(doc, { spotIds } = {}) {
  const errors = [];
  if (!doc || typeof doc !== "object") return ["中身が JSON のオブジェクトではありません"];
  if (doc.version !== SCHEMA_VERSION) errors.push(`version は ${SCHEMA_VERSION} です（今: ${doc.version}）`);
  for (const [id, e] of Object.entries(doc.spots ?? {})) {
    const p = `spots.${id}`;
    if (spotIds && !spotIds.has(id)) errors.push(`${p}: 収録に無いスポットです`);
    for (const [i, f] of (e.aliases ?? []).entries()) {
      checkField(f, `${p}.aliases[${i}]`, errors, (v, vp, errs) => { if (!String(v ?? "").trim()) errs.push(`${vp} が空です`); });
    }
    if (e.hours !== undefined) checkField(e.hours, `${p}.hours`, errors, checkHours);
    for (const [i, f] of (e.seasonal ?? []).entries()) checkField(f, `${p}.seasonal[${i}]`, errors, checkSeasonal);
    for (const [i, f] of (e.photos ?? []).entries()) checkField(f, `${p}.photos[${i}]`, errors, checkPhoto);
  }
  for (const [id, a] of Object.entries(doc.areas ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) errors.push(`areas.${id}: id は英小文字・数字・ハイフンで書きます`);
    checkArea(a, `areas.${id}`, errors);
    for (const s of a?.spots ?? []) if (spotIds && !spotIds.has(s)) errors.push(`areas.${id}.spots: 収録に無いスポットです: ${s}`);
  }
  for (const [i, f] of (doc.candidates ?? []).entries()) {
    checkField(f, `candidates[${i}]`, errors, (v, vp, errs) => { if (!String(v?.name ?? "").trim()) errs.push(`${vp}.name がありません`); });
    if (f?.origin === "llm" && f?.status === "verified") errors.push(`candidates[${i}]: AI の候補は verified にできません（収録に足すのは人の手で）`);
  }
  return errors;
}

// --- 鮮度 --------------------------------------------------------------------

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * その値がどれだけ新しいか、確かめてあるか。
 * @returns {{verified:boolean, ageDays:number|null, stale:boolean, label:string}}
 */
export function freshness(field, kind, today = todayJst()) {
  const verified = field?.status === "verified";
  const since = verified ? (field.checkedAt ?? field.source?.retrievedAt) : field?.source?.retrievedAt;
  const ageDays = DAY_RE.test(since ?? "") ? daysBetween(since, today) : null;
  const limit = STALE_DAYS[kind] ?? 365;
  const stale = ageDays === null || ageDays > limit;
  const when = ageDays === null ? "日付不明" : ageDays <= 0 ? "今日" : `${ageDays}日前`;
  const label = verified
    ? `確認済み ${since}（${when}）${stale ? "・古いかもしれません" : ""}`
    : `未確認・${field?.source?.name ?? "出典不明"}から ${since ?? "?"}（${when}）`;
  return { verified, ageDays, stale, label };
}

// --- 収録に重ねる -----------------------------------------------------------

/**
 * 収録のスポットに、足した情報を重ねた写しを返します（元は書き換えません）。
 *
 * 旅程の計算に効くのは **確認済み（verified）** の値だけです。未確認の営業時間で
 * 「この日は休み」と決めつけると、行けるはずの場所が消えるからです。
 * 別名は探すときに使うだけなので、未確認でも付けます。
 */
export function applyToSpot(spot, entry) {
  if (!entry) return spot;
  const ok = (f) => f?.status === "verified";
  const out = { ...spot };
  const aliases = (entry.aliases ?? []).map((f) => f.value).filter(Boolean);
  if (aliases.length) out.aliases = [...new Set([...(spot.aliases ?? []), ...aliases])];
  if (ok(entry.hours)) {
    out.hours = { ...(spot.hours ?? {}), ...entry.hours.value };
    out.hoursSource = entry.hours.source;
  }
  const seasonal = (entry.seasonal ?? []).filter(ok).map((f) => f.value);
  if (seasonal.length) out.seasonal = seasonal;
  const photos = (entry.photos ?? []).filter(ok).map((f) => ({ ...f.value, license: f.source.license, sourceUrl: f.source.url }));
  if (photos.length) out.photos = photos;
  return out;
}

/** kb の spots を、足した情報を重ねたものに入れ替えます（kb を書き換えます）。数を返します。 */
export function applyStoreToKb(kb, store) {
  let n = 0;
  const entries = store?.spots ?? {};
  if (!Object.keys(entries).length) return 0;
  kb.spots = kb.spots.map((s) => {
    const e = entries[s.id];
    if (!e) return s;
    n += 1;
    const next = applyToSpot(s, e);
    kb.spotsById?.set?.(s.id, next);
    return next;
  });
  if (kb.spotsByRegion instanceof Map) {
    for (const [rid, list] of kb.spotsByRegion) {
      kb.spotsByRegion.set(rid, list.map((s) => kb.spotsById?.get?.(s.id) ?? s));
    }
  }
  return n;
}

// --- 名前で探す -------------------------------------------------------------

const norm = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/**
 * 名前・別名・元の名前・id でスポットを探します。
 * 同じ名前がいくつもあるときは全部返します（呼ぶ側で選んでもらいます）。
 */
export function findSpots(kb, query, store = null) {
  const q = norm(query);
  if (!q) return [];
  const byId = kb.spots.find((s) => s.id === query);
  if (byId) return [byId];
  const aliasHit = new Set(Object.entries(store?.spots ?? {})
    .filter(([, e]) => (e.aliases ?? []).some((f) => norm(f.value) === q)).map(([id]) => id));
  return kb.spots.filter((s) => norm(s.name) === q || norm(s.listedAs) === q
    || (s.aliases ?? []).some((a) => norm(a) === q) || aliasHit.has(s.id));
}

// --- エリア -----------------------------------------------------------------

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 手で決めたエリアに入るスポット。 */
export function spotsInArea(kb, area) {
  if (Array.isArray(area?.spots)) {
    const want = new Set(area.spots);
    return kb.spots.filter((s) => want.has(s.id));
  }
  return kb.spots.filter((s) => Number.isFinite(s.lat) && haversineKm(area.center, s) <= area.radiusKm);
}
