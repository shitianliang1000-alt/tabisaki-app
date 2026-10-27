// 利用者が足し・直せる知識ベース（ユーザーKB）と、公式 kb/ への重ね合わせ。
//
// 設計は docs/user-kb.md にあります。ここはその決まりを、そのままコードにしたものです。
//
//   ・公式の kb/ は読むだけです。ここから kb/ へは一度も書きません。
//   ・利用者の差分は ~/.tabisaki/kbs/<名前>/overlay.json に、スポットの id ごとに
//     1件ずつ「足す（add）・直す（patch）・消す（remove。印を付けるだけ）」で持ちます。
//   ・重ねるときは利用者の差分が勝ちます。公式の側も変わっていたら、その旨を報告します。
//
//     import { openStore, applyOverlay } from "./packages/core/userkb.mjs";
//     const store = openStore();
//     const doc = await store.load("mine");
//     const { kb: merged, report } = applyOverlay(officialKb, doc);

import { randomBytes } from "node:crypto";
import { constants as FS, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

/** overlay.json の形の版。形を変えるときは、ここを上げて MIGRATIONS に足します。 */
export const SCHEMA = "tabisaki.user-kb/1";
/** 利用者が足したスポットの id の頭。公式の id には「:」が入らないので、ぶつかりません。 */
export const USER_ID_PREFIX = "u:";
/** ユーザーKBの名前。ファイルの名前になるので、使える字を絞ります。 */
export const KB_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const LIMITS = Object.freeze({
  fileBytes: 20 * 1024 * 1024, // overlay.json 1つの大きさ
  entries: 50000,              // 1つのユーザーKBに持てる差分の数
  backups: 30,                 // 取っておく控えの数（古いものから消します）
  lockStaleMs: 30000,          // これより古い鍵は、落ちた process の残りとみなします
});

const GENRES = ["nature", "history", "view", "food", "art", "city", "sea", "onsen"];
const FAME_TIERS = ["major", "known", "hidden"];

/**
 * 利用者が書けるスポットの項目。ここに無い項目は受け付けません（黙って捨てず、理由を返します）。
 * 公式の収録だけが持つ項目（src・osm・geo など）は、利用者の側からは書けません。
 */
export const SPOT_FIELDS = Object.freeze({
  name:        { type: "string", max: 120, required: true },
  lat:         { type: "number", min: -90, max: 90, required: true },
  lng:         { type: "number", min: -180, max: 180, required: true },
  category:    { type: "string", max: 40 },
  genres:      { type: "enum[]", values: GENRES, maxItems: 8 },
  regionId:    { type: "string", max: 64 },
  description: { type: "string", max: 2000 },
  address:     { type: "string", max: 200 },
  url:         { type: "url", max: 500 },
  wikipedia:   { type: "string", max: 200 },
  tel:         { type: "string", max: 30 },
  fame_tier:   { type: "enum", values: FAME_TIERS },
  dwell:       { type: "int", min: 5, max: 720 },   // 滞在の目安（分）
  open:        { type: "number", min: 0, max: 24 }, // 開く時刻（時。8.5 = 8:30）
  close:       { type: "number", min: 0, max: 30 }, // 閉まる時刻（24 を超えると翌日）
  fee:         { type: "int", min: 0, max: 1000000 }, // 料金（円）
});

/** 直したいときに外せない項目。外すと旅程に置けなくなります。 */
const NOT_UNSETTABLE = new Set(["name", "lat", "lng"]);
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** 決まった形のエラー。code で見分けます（CoreError と同じ考え）。 */
export class UserKbError extends Error {
  /**
   * @param {"invalid_name"|"invalid_input"|"not_found"|"exists"|"unsafe_path"|"too_large"|"locked"|"newer_schema"|"broken_file"} code
   * @param {string} message 利用者に見せる日本語
   */
  constructor(code, message) {
    super(message);
    this.name = "UserKbError";
    this.code = code;
  }
}

// --- 名前・id -----------------------------------------------------------------

export function validateKbName(name) {
  const n = String(name ?? "");
  if (!KB_NAME_RE.test(n)) {
    throw new UserKbError("invalid_name",
      `ユーザーKBの名前は、英小文字・数字・「-」「_」で40字までにしてください（先頭は英数字）: ${n || "(空)"}`);
  }
  return n;
}

/** 利用者が足すスポットの id。時刻の順に並び、ほかの端末で作ったものともぶつかりません。 */
export function newUserSpotId(now = Date.now()) {
  return `${USER_ID_PREFIX}${now.toString(36)}${randomBytes(4).toString("hex")}`;
}

export const isUserSpotId = (id) => typeof id === "string" && id.startsWith(USER_ID_PREFIX)
  && /^u:[a-z0-9]{6,40}$/.test(id);

// --- 項目の確かめ ---------------------------------------------------------------

// 制御文字（改行とタブは残します）を外し、前後の空白を落とします。
const cleanText = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();

function checkField(key, value) {
  const spec = SPOT_FIELDS[key];
  if (!spec) return { error: `知らない項目です: ${key}` };
  switch (spec.type) {
    case "string": {
      if (typeof value !== "string") return { error: `${key} は文字で書いてください` };
      const v = cleanText(value);
      if (!v) return { error: `${key} が空です` };
      if (v.length > spec.max) return { error: `${key} は${spec.max}字までです（${v.length}字）` };
      return { value: v };
    }
    case "url": {
      if (typeof value !== "string") return { error: `${key} は文字で書いてください` };
      const v = value.trim();
      if (v.length > spec.max) return { error: `${key} は${spec.max}字までです` };
      let u;
      try { u = new URL(v); } catch { return { error: `${key} が URL として読めません: ${v}` }; }
      if (u.protocol !== "https:" && u.protocol !== "http:") return { error: `${key} は http(s):// で始めてください` };
      if (u.username || u.password) return { error: `${key} に利用者名・パスワードを入れないでください` };
      return { value: u.toString() };
    }
    case "number":
    case "int": {
      const v = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof v !== "number" || !Number.isFinite(v)) return { error: `${key} は数で書いてください` };
      if (spec.type === "int" && !Number.isInteger(v)) return { error: `${key} は整数で書いてください` };
      if (v < spec.min || v > spec.max) return { error: `${key} は ${spec.min}〜${spec.max} にしてください（${v}）` };
      return { value: v };
    }
    case "enum":
      if (!spec.values.includes(value)) return { error: `${key} は ${spec.values.join(" / ")} のどれかです` };
      return { value };
    case "enum[]": {
      if (!Array.isArray(value)) return { error: `${key} は一覧（配列）で書いてください` };
      const bad = value.filter((g) => !spec.values.includes(g));
      if (bad.length) return { error: `${key} に知らない値があります: ${bad.join(", ")}（${spec.values.join(" / ")}）` };
      const v = [...new Set(value)];
      if (v.length > spec.maxItems) return { error: `${key} は${spec.maxItems}個までです` };
      return { value: v };
    }
    default:
      return { error: `項目の決まりがおかしいです: ${key}` };
  }
}

/**
 * スポットの項目を確かめます。
 * @param {object} input
 * @param {{partial?: boolean}} [opts] partial = 直すとき（必須の項目が無くてもよい）
 * @returns {{value: object, errors: string[]}}
 */
export function validateSpot(input, { partial = false } = {}) {
  const errors = [];
  const value = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { value, errors: ["スポットは { 項目: 値 } の形で書いてください"] };
  }
  for (const [key, raw] of Object.entries(input)) {
    if (key === "id") continue; // id は差分の鍵が持ちます
    if (BAD_KEYS.has(key)) { errors.push(`使えない項目名です: ${key}`); continue; }
    if (raw === undefined || raw === null) continue;
    const r = checkField(key, raw);
    if (r.error) errors.push(r.error); else value[key] = r.value;
  }
  if (!partial) {
    for (const [key, spec] of Object.entries(SPOT_FIELDS)) {
      if (spec.required && value[key] === undefined) errors.push(`${key} は必須です`);
    }
  }
  if (value.open !== undefined && value.close !== undefined && value.close <= value.open) {
    errors.push("close は open より後にしてください");
  }
  return { value, errors };
}

// --- 差分の入れ物 -----------------------------------------------------------------

/** 公式の収録の「版」。差分を書いたときの版を控えておき、変わったかを見ます。 */
export function baseStamp(kb) {
  const m = kb?.manifest ?? {};
  const c = m.counts ?? {};
  return [m.version ?? m.builtAt ?? m.generated ?? "", c.regions ?? kb?.regions?.length ?? 0,
    c.spots ?? kb?.spots?.length ?? 0].join("/");
}

export function emptyOverlay(name, { title = "", now = new Date() } = {}) {
  validateKbName(name);
  const at = now.toISOString();
  return {
    schema: SCHEMA,
    name,
    title: cleanText(title).slice(0, 80),
    base: { kind: "official", stamp: "" },
    created: at,
    updated: at,
    spots: {},
  };
}

/**
 * 古い形の overlay.json を、今の形に直します。新しい版で書かれたものは、
 * 知らない項目を落として書き戻すと壊すので、読むだけにします（newer_schema）。
 */
const MIGRATIONS = {
  // "tabisaki.user-kb/1": (doc) => ({ ...doc, schema: "tabisaki.user-kb/2", ... }),
};

export function migrateOverlay(doc) {
  if (!doc || typeof doc !== "object") throw new UserKbError("broken_file", "overlay.json の中身が読めません");
  let d = doc;
  for (let i = 0; i < 20 && d.schema !== SCHEMA; i++) {
    const step = MIGRATIONS[d.schema];
    if (!step) {
      const m = /^tabisaki\.user-kb\/(\d+)$/.exec(String(d.schema));
      const cur = Number(SCHEMA.split("/")[1]);
      if (m && Number(m[1]) > cur) {
        throw new UserKbError("newer_schema",
          `このユーザーKBは新しい版（${d.schema}）で書かれています。旅さきを新しくしてから開いてください`);
      }
      throw new UserKbError("broken_file", `overlay.json の形が分かりません: ${d.schema}`);
    }
    d = step(d);
  }
  return d;
}

/**
 * overlay.json の中身を1件ずつ確かめます。手で書き換えられていても落ちないよう、
 * おかしい差分は「使わない」とだけ決めて、理由を返します。
 * @returns {{id: string, problem: string}[]}
 */
export function checkOverlay(doc) {
  const out = [];
  const spots = doc?.spots;
  if (!spots || typeof spots !== "object" || Array.isArray(spots)) return [{ id: "", problem: "spots がありません" }];
  const ids = Object.keys(spots);
  if (ids.length > LIMITS.entries) out.push({ id: "", problem: `差分が多すぎます（${ids.length}件。${LIMITS.entries}件まで）` });
  for (const id of ids) {
    const e = spots[id];
    const bad = (problem) => out.push({ id, problem });
    if (BAD_KEYS.has(id) || !id || id.length > 80) { bad("id がおかしいです"); continue; }
    if (!e || typeof e !== "object") { bad("中身がありません"); continue; }
    if (e.op === "add") {
      if (!isUserSpotId(id)) { bad(`足したスポットの id は ${USER_ID_PREFIX} で始めます`); continue; }
      const { errors } = validateSpot(e.spot);
      for (const p of errors) bad(p);
    } else if (e.op === "patch") {
      if (isUserSpotId(id)) { bad("足したスポットは add のまま直します（patch は公式のスポットだけ）"); continue; }
      const { errors } = validateSpot(e.set ?? {}, { partial: true });
      for (const p of errors) bad(p);
      for (const k of e.unset ?? []) {
        if (!SPOT_FIELDS[k]) bad(`知らない項目は外せません: ${k}`);
        else if (NOT_UNSETTABLE.has(k)) bad(`${k} は外せません`);
      }
      if (!Object.keys(e.set ?? {}).length && !(e.unset ?? []).length) bad("直すところがありません");
    } else if (e.op === "remove") {
      if (e.reason !== undefined && typeof e.reason !== "string") bad("reason は文字で書いてください");
    } else bad(`知らない op です: ${e.op}`);
  }
  return out;
}

/** 公式のスポットを見失ったときに、探し直す手がかり。 */
export function anchorOf(spot) {
  return { name: spot.name, lat: spot.lat, lng: spot.lng };
}

const touch = (doc, now) => { doc.updated = now.toISOString(); };

/** スポットを足します。足した id を返します。 */
export function addSpot(doc, input, { now = new Date(), id = newUserSpotId(now.getTime()) } = {}) {
  const { value, errors } = validateSpot(input);
  if (errors.length) throw new UserKbError("invalid_input", errors.join("\n"));
  if (doc.spots[id]) throw new UserKbError("exists", `同じ id がもうあります: ${id}`);
  if (Object.keys(doc.spots).length >= LIMITS.entries) throw new UserKbError("too_large", `差分は${LIMITS.entries}件までです`);
  doc.spots[id] = { op: "add", spot: value, at: now.toISOString() };
  touch(doc, now);
  return id;
}

/**
 * スポットを直します。公式のスポットなら差分（patch）として、足したスポットなら中身を書き換えます。
 * @param {object} doc overlay
 * @param {object|undefined} official 公式のスポット（足したスポットなら undefined）
 * @param {string} id
 * @param {{set?: object, unset?: string[]}} change
 */
export function patchSpot(doc, official, id, { set = {}, unset = [] } = {}, { now = new Date() } = {}) {
  const { value, errors } = validateSpot(set, { partial: true });
  for (const k of unset) {
    if (!SPOT_FIELDS[k]) errors.push(`知らない項目は外せません: ${k}`);
    else if (NOT_UNSETTABLE.has(k)) errors.push(`${k} は外せません`);
  }
  if (errors.length) throw new UserKbError("invalid_input", errors.join("\n"));
  const entry = doc.spots[id];
  if (isUserSpotId(id)) {
    if (entry?.op !== "add") throw new UserKbError("not_found", `足したスポットにありません: ${id}`);
    const next = { ...entry.spot, ...value };
    for (const k of unset) delete next[k];
    const re = validateSpot(next);
    if (re.errors.length) throw new UserKbError("invalid_input", re.errors.join("\n"));
    entry.spot = re.value;
    entry.at = now.toISOString();
    touch(doc, now);
    return entry;
  }
  if (!official) throw new UserKbError("not_found", `公式の収録にありません: ${id}`);
  if (entry?.op === "remove") throw new UserKbError("invalid_input", `消した印があります。先に戻してください: ${id}`);
  const prev = entry?.op === "patch" ? entry : { set: {}, unset: [], was: {} };
  const was = { ...prev.was };
  // 「直す前の公式の値」は、その項目を最初に直したときのものを持ち続けます。
  for (const k of [...Object.keys(value), ...unset]) if (!(k in was)) was[k] = official[k] ?? null;
  const s = { ...prev.set, ...value };
  for (const k of unset) delete s[k];
  const u = [...new Set([...(prev.unset ?? []).filter((k) => !(k in value)), ...unset])];
  const next = { op: "patch", set: s, unset: u, was, anchor: anchorOf(official), at: now.toISOString() };
  if (!Object.keys(s).length && !u.length) delete doc.spots[id];
  else doc.spots[id] = next;
  touch(doc, now);
  return doc.spots[id];
}

/** スポットを消します（印を付けるだけ。undoEntry で戻せます）。 */
export function removeSpot(doc, official, id, { reason = "", now = new Date() } = {}) {
  if (isUserSpotId(id)) {
    if (doc.spots[id]?.op !== "add") throw new UserKbError("not_found", `足したスポットにありません: ${id}`);
  } else if (!official) {
    throw new UserKbError("not_found", `公式の収録にありません: ${id}`);
  }
  const prev = doc.spots[id];
  doc.spots[id] = {
    op: "remove",
    reason: cleanText(reason).slice(0, 200),
    anchor: official ? anchorOf(official) : anchorOf(prev.spot),
    // 足したスポットを消したときは、中身も持っておきます（戻せるように）。
    ...(prev?.op === "add" ? { spot: prev.spot } : {}),
    ...(prev?.op === "patch" ? { patch: { set: prev.set, unset: prev.unset, was: prev.was } } : {}),
    at: now.toISOString(),
  };
  touch(doc, now);
  return doc.spots[id];
}

/** 差分を1つ取り消します。消した印なら、消す前に戻します。 */
export function undoEntry(doc, id, { now = new Date() } = {}) {
  const e = doc.spots[id];
  if (!e) throw new UserKbError("not_found", `差分がありません: ${id}`);
  if (e.op === "remove" && e.spot) doc.spots[id] = { op: "add", spot: e.spot, at: now.toISOString() };
  else if (e.op === "remove" && e.patch) doc.spots[id] = { op: "patch", ...e.patch, anchor: e.anchor, at: now.toISOString() };
  else delete doc.spots[id];
  touch(doc, now);
  return doc.spots[id] ?? null;
}

// --- 重ね合わせ -------------------------------------------------------------------

const MOVE_RADIUS_M = 300;

function meters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function nearestRegion(regions, p) {
  let best = null;
  let bestD = Infinity;
  for (const r of regions) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
    const d = meters(r, p);
    if (d < bestD) { best = r; bestD = d; }
  }
  return best;
}

/**
 * 公式の知識ベースに、ユーザーKBの差分を重ねます。
 *
 * 公式の知識ベース（引数の kb）も、その中のスポットも書き換えません。
 * 直すスポットは写しを作り、一覧と索引は作り直して、新しい知識ベースとして返します。
 *
 * @param {object} kb js/kb.js の loadKnowledgeBase が返すもの
 * @param {object} doc overlay（store.load の結果）
 * @param {{sameThing?: (a: string, b: string) => boolean}} [opts] 名前が同じものを指すか（既定は完全一致）
 * @returns {{kb: object, report: object}}
 */
export function applyOverlay(kb, doc, { sameThing = (a, b) => a === b } = {}) {
  const report = {
    name: doc?.name ?? "", added: 0, patched: 0, removed: 0,
    moved: [],      // 公式の id が変わっていて、名前と場所で見つけ直したもの
    orphans: [],    // 公式から消えていて、当てる先が無いもの（ファイルには残します）
    conflicts: [],  // 利用者が直した項目を、公式の側も変えていたもの（利用者の値を使います）
    redundant: [],  // 公式の側が、利用者の直した値と同じになったもの（消してよい差分）
    invalid: checkOverlay(doc),
    baseChanged: !!doc?.base?.stamp && doc.base.stamp !== baseStamp(kb),
  };
  const skip = new Set(report.invalid.map((p) => p.id));
  const entries = Object.entries(doc?.spots ?? {}).filter(([id]) => !skip.has(id) && !skip.has(""));
  if (skip.has("")) return { kb, report };

  const byId = kb.spotsById ?? new Map(kb.spots.map((s) => [s.id, s]));
  const regionsById = kb.regionsById ?? new Map((kb.regions ?? []).map((r) => [r.id, r]));
  const replace = new Map(); // 公式の id → 直した写し（null = 消す）
  const added = [];

  /** 公式の id が見つからないとき、名前と場所が同じものを1つだけ探します。 */
  const relocate = (id, anchor) => {
    if (!anchor?.name || !Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lng)) return null;
    const hits = kb.spots.filter((s) => Number.isFinite(s.lat) && meters(s, anchor) <= MOVE_RADIUS_M
      && (s.name === anchor.name || sameThing(s.name, anchor.name)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) report.orphans.push({ id, anchor, why: "ambiguous", candidates: hits.map((s) => s.id) });
    return null;
  };

  for (const [id, e] of entries) {
    if (e.op === "add") {
      const s = { ...e.spot, id };
      let region = s.regionId ? regionsById.get(s.regionId) : null;
      if (!region) region = nearestRegion(kb.regions ?? [], s);
      s.regionId = region?.id ?? s.regionId ?? "user";
      s.region ??= region?.name ?? "";
      s.prefecture ??= region?.prefecture ?? "";
      s.prefectureId ??= s.regionId;
      s.country ??= region?.country ?? "日本";
      s.genres ??= [];
      s.fame_tier ??= "hidden";
      s.fame_score ??= 30;
      s.source = "user";
      s.verified = false;
      s.userKb = doc.name;
      added.push(s);
      continue;
    }
    let target = byId.get(id);
    if (!target) {
      target = relocate(id, e.anchor);
      if (target) report.moved.push({ id, to: target.id });
      else {
        if (!report.orphans.some((o) => o.id === id)) report.orphans.push({ id, anchor: e.anchor ?? null, why: e.op === "remove" ? "gone" : "missing" });
        continue;
      }
    }
    if (e.op === "remove") {
      replace.set(target.id, null);
      report.removed++;
      continue;
    }
    // patch
    const copy = { ...(replace.get(target.id) ?? target) };
    for (const [k, v] of Object.entries(e.set ?? {})) {
      const was = e.was?.[k] ?? null;
      const now = target[k] ?? null;
      if (!sameValue(was, now)) {
        if (sameValue(now, v)) report.redundant.push({ id, field: k });
        else report.conflicts.push({ id, field: k, was, official: now, user: v });
      }
      copy[k] = v;
    }
    for (const k of e.unset ?? []) {
      const was = e.was?.[k] ?? null;
      const now = target[k] ?? null;
      if (!sameValue(was, now)) {
        if (now === null) report.redundant.push({ id, field: k });
        else report.conflicts.push({ id, field: k, was, official: now, user: null });
      }
      delete copy[k];
    }
    copy.edited = true;
    copy.userKb = doc.name;
    replace.set(target.id, copy);
    report.patched++;
  }

  const spots = [];
  for (const s of kb.spots) {
    if (!replace.has(s.id)) { spots.push(s); continue; }
    const r = replace.get(s.id);
    if (r) spots.push(r);
  }
  for (const s of added) spots.push(s);
  report.added = added.length;

  const spotsById = new Map();
  const spotsByRegion = new Map();
  for (const s of spots) {
    spotsById.set(s.id, s);
    const list = spotsByRegion.get(s.regionId);
    if (list) list.push(s); else spotsByRegion.set(s.regionId, [s]);
  }
  const merged = {
    ...kb,
    spots, spotsById, spotsByRegion,
    spotsByPoint: undefined,
    __searchHaystack: undefined,
    userKb: { name: doc.name, title: doc.title ?? "", report },
  };
  return { kb: merged, report };
}

// --- 置き場（~/.tabisaki/kbs/） -----------------------------------------------------

/** 置き場の根。TABISAKI_HOME があればそこ、無ければ ~/.tabisaki。 */
export function userKbHome(env = process.env) {
  const h = env.TABISAKI_HOME?.trim();
  return path.resolve(h || path.join(os.homedir(), ".tabisaki"));
}

/** JSON を読みます。__proto__ のような鍵は捨て、大きすぎるファイルは読みません。 */
async function readJsonSafe(file) {
  const st = await fsp.lstat(file).catch(() => null);
  if (!st) throw new UserKbError("not_found", `ありません: ${file}`);
  if (st.isSymbolicLink() || !st.isFile()) throw new UserKbError("unsafe_path", `ふつうのファイルではありません: ${file}`);
  if (st.size > LIMITS.fileBytes) throw new UserKbError("too_large", `大きすぎます（${st.size} バイト）: ${file}`);
  const text = await fsp.readFile(file, "utf8");
  try {
    return JSON.parse(text, (k, v) => (BAD_KEYS.has(k) ? undefined : v));
  } catch (e) {
    throw new UserKbError("broken_file", `JSON として読めません: ${file}（${e.message}）`);
  }
}

/** 途中で落ちても半端なファイルが残らないよう、隣に書いてから差し替えます。 */
async function writeAtomic(file, text) {
  if (Buffer.byteLength(text) > LIMITS.fileBytes) throw new UserKbError("too_large", "ユーザーKBが大きすぎます");
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  const fh = await fsp.open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

const stampName = (now) => now.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
const BACKUP_RE = /^\d{8}T\d{9}Z(?:-\d{1,3})?\.json$/;

/**
 * ユーザーKBの置き場を開きます。
 * @param {{home?: string, now?: () => Date}} [opts]
 */
export function openStore({ home = userKbHome(), now = () => new Date() } = {}) {
  const root = path.resolve(home);
  const kbsDir = path.join(root, "kbs");

  const dirOf = (name) => {
    validateKbName(name);
    const d = path.join(kbsDir, name);
    const rel = path.relative(kbsDir, d);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
      throw new UserKbError("unsafe_path", `置き場の外は使いません: ${name}`);
    }
    return d;
  };

  async function ensureDir(d) {
    await fsp.mkdir(d, { recursive: true, mode: 0o700 });
    const st = await fsp.lstat(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new UserKbError("unsafe_path", `ふつうのフォルダではありません: ${d}`);
  }

  async function withLock(name, fn) {
    const d = dirOf(name);
    await ensureDir(d);
    const lock = path.join(d, ".lock");
    let fh;
    try {
      fh = await fsp.open(lock, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const st = await fsp.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LIMITS.lockStaleMs) {
        await fsp.rm(lock, { force: true });
        fh = await fsp.open(lock, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600);
      } else {
        throw new UserKbError("locked", `ほかの処理が「${name}」を書いています。少し待ってからやり直してください`);
      }
    }
    try {
      await fh.writeFile(String(process.pid));
      await fh.close();
      return await fn(d);
    } finally {
      await fsp.rm(lock, { force: true });
    }
  }

  async function backupNow(d) {
    const file = path.join(d, "overlay.json");
    const st = await fsp.lstat(file).catch(() => null);
    if (!st) return null;
    const bdir = path.join(d, "backups");
    await ensureDir(bdir);
    let name = `${stampName(now())}.json`;
    for (let i = 1; await fsp.lstat(path.join(bdir, name)).catch(() => null); i++) {
      name = `${stampName(now())}-${i}.json`;
    }
    await fsp.copyFile(file, path.join(bdir, name), FS.COPYFILE_EXCL);
    await fsp.chmod(path.join(bdir, name), 0o600);
    const all = (await fsp.readdir(bdir)).filter((f) => BACKUP_RE.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - LIMITS.backups))) {
      await fsp.rm(path.join(bdir, old), { force: true });
    }
    return name;
  }

  const store = {
    root,
    kbsDir,
    path: (name) => path.join(dirOf(name), "overlay.json"),

    /** ユーザーKBの名前の一覧。 */
    async list() {
      const names = await fsp.readdir(kbsDir).catch(() => []);
      const out = [];
      for (const n of names.sort()) {
        if (!KB_NAME_RE.test(n)) continue;
        const st = await fsp.lstat(path.join(kbsDir, n, "overlay.json")).catch(() => null);
        if (st?.isFile()) out.push(n);
      }
      return out;
    },

    async create(name, { title = "" } = {}) {
      return withLock(name, async (d) => {
        const file = path.join(d, "overlay.json");
        if (await fsp.lstat(file).catch(() => null)) throw new UserKbError("exists", `もうあります: ${name}`);
        const doc = emptyOverlay(name, { title, now: now() });
        await writeAtomic(file, JSON.stringify(doc, null, 2) + "\n");
        return doc;
      });
    },

    async load(name) {
      const doc = migrateOverlay(await readJsonSafe(store.path(name)));
      if (doc.name !== name) doc.name = name; // フォルダの名前が正
      return doc;
    },

    /**
     * 書き戻します。書く前に、今のファイルを backups/ に控えます。
     * @param {string} name
     * @param {object} doc
     * @param {{kb?: object}} [opts] kb を渡すと、公式の収録の版を控えます
     */
    async save(name, doc, { kb } = {}) {
      if (doc?.schema !== SCHEMA) throw new UserKbError("invalid_input", `形の版が違います: ${doc?.schema}`);
      const problems = checkOverlay(doc);
      if (problems.length) {
        throw new UserKbError("invalid_input", problems.slice(0, 5).map((p) => `${p.id}: ${p.problem}`).join("\n"));
      }
      return withLock(name, async (d) => {
        const backup = await backupNow(d);
        const out = { ...doc, name };
        if (kb) out.base = { kind: "official", stamp: baseStamp(kb) };
        await writeAtomic(path.join(d, "overlay.json"), JSON.stringify(out, null, 2) + "\n");
        return { backup };
      });
    },

    /** 控えの一覧（古い順）。 */
    async backups(name) {
      const bdir = path.join(dirOf(name), "backups");
      return (await fsp.readdir(bdir).catch(() => [])).filter((f) => BACKUP_RE.test(f)).sort();
    },

    /** 控えから戻します。戻す前の今の中身も、控えに残します。 */
    async restore(name, backupName) {
      if (!BACKUP_RE.test(String(backupName))) throw new UserKbError("invalid_input", `控えの名前がおかしいです: ${backupName}`);
      const d = dirOf(name);
      const src = path.join(d, "backups", backupName);
      const doc = migrateOverlay(await readJsonSafe(src));
      const problems = checkOverlay(doc);
      if (problems.length) throw new UserKbError("broken_file", `控えの中身がおかしいです: ${problems[0].id} ${problems[0].problem}`);
      return withLock(name, async () => {
        const backup = await backupNow(d);
        await writeAtomic(path.join(d, "overlay.json"), JSON.stringify({ ...doc, name }, null, 2) + "\n");
        return { restored: backupName, backup };
      });
    },

    /** 消すときもファイルは消さず、trash/ へ動かします。 */
    async drop(name) {
      const d = dirOf(name);
      if (!(await fsp.lstat(path.join(d, "overlay.json")).catch(() => null))) throw new UserKbError("not_found", `ありません: ${name}`);
      const trash = path.join(root, "trash");
      await ensureDir(trash);
      const to = path.join(trash, `${name}-${stampName(now())}`);
      await fsp.rename(d, to);
      return to;
    },
  };
  return store;
}
