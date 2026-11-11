// ユーザーKBどうしの差分・統合・点検・集計（Issue #358）。
//
// ここは計算だけです。ファイルは読み書きしません（置き場は userkb.mjs の openStore）。
// 設計は docs/user-kb.md の「分ける・比べる・まとめる」にあります。
//
//   ・差分は、スポットの id ごと・項目ごとに出します（diffOverlays）。
//   ・統合は3者で行います（mergeOverlays）。分かれたときの中身（base）と比べて、
//     片方だけが変えたところは変えた方を取り、両方が別々に変えたところだけを
//     競合として返します。base が無ければ「どちらも空から始めた」として比べます。
//   ・競合は、項目ごと（同じスポットの同じ項目を別の値にした）か、
//     スポットごと（片方が消して、片方が直した、など）のどちらかです。

import { LIMITS, SCHEMA, SPOT_FIELDS, UserKbError, baseStamp, checkOverlay, isUserSpotId, validateSpot } from "./userkb.mjs";

export const MERGE_SCHEMA = "tabisaki.user-kb-merge/1";

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}
/** 鍵の並びに左右されない JSON。比べるとき・ハッシュを取るときに使います。 */
export const canonical = (v) => JSON.stringify(sortKeys(v ?? null));
const same = (a, b) => canonical(a) === canonical(b);

/** 差分1件の「中身」。書いた時刻（at）は、同じかどうかに数えません。 */
function body(e) {
  if (!e) return null;
  const { at, ...rest } = e;
  if (rest.op === "patch") return { op: "patch", set: rest.set ?? {}, unset: [...(rest.unset ?? [])].sort() };
  if (rest.op === "remove") return { op: "remove" };
  if (rest.op === "add") return { op: "add", spot: rest.spot ?? {} };
  return rest;
}
/** 2つの差分が同じ中身か（無いものどうしも同じ）。 */
export const sameEntry = (a, b) => same(body(a), body(b));

/** 差分の中身だけから作る、ユーザーKBの指紋。統合の途中で中身が変わっていないかを見ます。 */
export function overlayFingerprint(doc) {
  const o = {};
  for (const id of Object.keys(doc?.spots ?? {}).sort()) o[id] = body(doc.spots[id]);
  return canonical(o);
}

export const entryName = (id, ...entries) => {
  for (const e of entries) {
    const n = e?.spot?.name ?? e?.set?.name ?? e?.anchor?.name;
    if (n) return n;
  }
  return id;
};

const UNSET = Object.freeze({ unset: true });
/** 差分を「項目 → 値」の表にします。patch の外す項目は UNSET で表します。 */
function fieldsOf(e) {
  const m = new Map();
  if (e?.op === "add") for (const [k, v] of Object.entries(e.spot ?? {})) m.set(k, { value: v });
  if (e?.op === "patch") {
    for (const [k, v] of Object.entries(e.set ?? {})) m.set(k, { value: v });
    for (const k of e.unset ?? []) m.set(k, UNSET);
  }
  return m;
}
const show = (f) => (f === undefined ? undefined : f.unset ? null : f.value);

// --- 差分 -------------------------------------------------------------------------

/**
 * a から b へ、何が変わったか。
 * @returns {{id: string, name: string, kind: "added"|"removed"|"changed", from: object|null, to: object|null,
 *            fields: {field: string, from: any, to: any}[]}[]}
 *   kind: added = b にだけある差分、removed = a にだけある差分、changed = 両方にあって中身が違う
 *   fields の from / to: undefined = その項目に触っていない、null = 外した
 */
export function diffOverlays(a, b) {
  const out = [];
  const sa = a?.spots ?? {};
  const sb = b?.spots ?? {};
  for (const id of [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort()) {
    const ea = sa[id] ?? null;
    const eb = sb[id] ?? null;
    if (sameEntry(ea, eb)) continue;
    const fa = fieldsOf(ea);
    const fb = fieldsOf(eb);
    const fields = [];
    for (const k of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
      if (same(fa.get(k), fb.get(k))) continue;
      fields.push({ field: k, from: show(fa.get(k)), to: show(fb.get(k)) });
    }
    out.push({ id, name: entryName(id, eb, ea), kind: !ea ? "added" : !eb ? "removed" : "changed", from: ea, to: eb, fields });
  }
  return out;
}

const OP_WORD = { add: "足した", patch: "直した", remove: "消した" };
const val = (v) => (v === undefined ? "（そのまま）" : v === null ? "（なし）" : Array.isArray(v) ? v.join(";") : String(v));

/** 差分を、人が読める行にします。 */
export function formatDiff(changes, { from = "a", to = "b" } = {}) {
  const lines = [];
  for (const c of changes) {
    const head = c.kind === "added" ? `+ ${c.id} ${c.name}［${to} で${OP_WORD[c.to.op]}］`
      : c.kind === "removed" ? `- ${c.id} ${c.name}［${from} で${OP_WORD[c.from.op]}。${to} には無い］`
        : `~ ${c.id} ${c.name}${c.from.op !== c.to.op ? `［${OP_WORD[c.from.op]} → ${OP_WORD[c.to.op]}］` : ""}`;
    lines.push(head);
    for (const f of c.fields) {
      if (c.kind === "added" && c.to.op === "patch") lines.push(`    ${f.field}: ${val(c.to.was?.[f.field] ?? null)}（収録） → ${val(f.to)}`);
      else if (c.kind === "added") lines.push(`    ${f.field}: ${val(f.to)}`);
      else if (c.kind === "removed") lines.push(`    ${f.field}: ${val(f.from)}`);
      else lines.push(`    ${f.field}: ${val(f.from)} → ${val(f.to)}`);
    }
  }
  return lines.join("\n");
}

// --- 統合 -------------------------------------------------------------------------

/** 3者の比べかた。片方だけが変えたならそれを、両方が同じに変えたならそれを取ります。 */
function pick3(b, o, t) {
  if (same(o, t)) return { take: "same" };
  if (same(b, o)) return { take: "theirs" };
  if (same(b, t)) return { take: "ours" };
  return { take: "conflict" };
}

function rebuild(op, fields, { ours, theirs, at }) {
  if (op === "add") {
    const spot = {};
    for (const [k, f] of fields) if (f && !f.unset) spot[k] = f.value;
    return { op: "add", spot, at };
  }
  const set = {};
  const unset = [];
  const was = {};
  for (const [k, f] of fields) {
    if (!f) continue;
    if (f.unset) unset.push(k); else set[k] = f.value;
    const w = ours?.was && k in ours.was ? ours.was[k] : theirs?.was && k in theirs.was ? theirs.was[k] : null;
    was[k] = w;
  }
  if (!Object.keys(set).length && !unset.length) return null;
  return { op: "patch", set, unset: unset.sort(), was, anchor: ours?.anchor ?? theirs?.anchor ?? null, at };
}

/**
 * 3者で統合します。ours（自分）に theirs（相手）を取り込みます。
 *
 * @param {object|null} base 分かれたときの中身。無ければ null（どちらも空から始めたとみなします）
 * @param {object} ours 取り込む先
 * @param {object} theirs 取り込む相手
 * @returns {{spots: object, taken: object[], conflicts: object[], counts: object}}
 *   spots = 競合のないところを取り込んだ結果（競合のところは、自分の側のまま）
 *   taken = 相手から取り込んだもの [{id, name, how: "add"|"replace"|"fields"|"drop", fields?}]
 *   conflicts = [{key, id, name, kind: "field"|"entry", field?, base, ours, theirs}]
 *     key は、解き方を指すときの名前（項目なら `id#項目`、スポットごとなら `id`）
 */
export function mergeOverlays(base, ours, theirs, { now = new Date() } = {}) {
  const at = now.toISOString();
  const sb = base?.spots ?? {};
  const so = ours?.spots ?? {};
  const st = theirs?.spots ?? {};
  const spots = {};
  const taken = [];
  const conflicts = [];
  const pending = {}; // 項目の競合を解くときに要る材料
  for (const id of [...new Set([...Object.keys(sb), ...Object.keys(so), ...Object.keys(st)])].sort()) {
    const b = sb[id] ?? null;
    const o = so[id] ?? null;
    const t = st[id] ?? null;
    const name = entryName(id, o, t, b);
    const keep = () => { if (o) spots[id] = o; };
    if (sameEntry(o, t) || sameEntry(b, t)) { keep(); continue; }
    if (sameEntry(b, o)) {
      if (t) { spots[id] = { ...t, at: t.at ?? at }; taken.push({ id, name, how: o ? "replace" : "add", op: t.op }); }
      else taken.push({ id, name, how: "drop", op: o?.op });
      continue;
    }
    // ここからは、両方が別々に変えています。
    if (o && t && o.op === t.op && (o.op === "patch" || o.op === "add")) {
      const fb = b?.op === o.op ? fieldsOf(b) : new Map();
      const fo = fieldsOf(o);
      const ft = fieldsOf(t);
      const merged = new Map();
      const fromTheirs = [];
      const fieldConflicts = [];
      for (const k of [...new Set([...fb.keys(), ...fo.keys(), ...ft.keys()])].sort()) {
        const r = pick3(fb.get(k), fo.get(k), ft.get(k));
        if (r.take === "theirs") { merged.set(k, ft.get(k)); fromTheirs.push(k); }
        else {
          merged.set(k, fo.get(k));
          if (r.take === "conflict") fieldConflicts.push(k);
        }
      }
      const e = rebuild(o.op, merged, { ours: o, theirs: t, at });
      if (e) spots[id] = e;
      if (fromTheirs.length) taken.push({ id, name, how: "fields", op: o.op, fields: fromTheirs });
      for (const k of fieldConflicts) {
        conflicts.push({ key: `${id}#${k}`, id, name, kind: "field", field: k, base: show(fb.get(k)), ours: show(fo.get(k)), theirs: show(ft.get(k)) });
      }
      if (fieldConflicts.length) pending[id] = { op: o.op, ours: o, theirs: t };
      continue;
    }
    if (o && t && o.op === "remove" && t.op === "remove") { keep(); continue; }
    keep();
    conflicts.push({ key: id, id, name, kind: "entry", base: b, ours: o, theirs: t });
  }
  const count = (how) => taken.filter((x) => x.how === how).length;
  return {
    spots, taken, conflicts, pending, hasBase: !!base,
    counts: { added: count("add"), replaced: count("replace"), fields: count("fields"), dropped: count("drop"), conflicts: conflicts.length },
  };
}

/**
 * 競合の解き方（picks）を当てはめて、統合の結果を仕上げます。
 * @param {ReturnType<typeof mergeOverlays>} merged
 * @param {object} theirs 相手のユーザーKB
 * @param {Record<string, "ours"|"theirs">} picks 競合の key → どちらを取るか
 * @returns {{spots: object, unresolved: object[]}}
 */
export function resolveMerge(merged, theirs, picks = {}, { now = new Date() } = {}) {
  const at = now.toISOString();
  const spots = { ...merged.spots };
  const unresolved = [];
  const byId = new Map();
  for (const c of merged.conflicts) {
    const side = picks[c.key];
    if (side !== "ours" && side !== "theirs") { unresolved.push(c); continue; }
    if (c.kind === "entry") {
      if (side === "theirs") {
        if (c.theirs) spots[c.id] = { ...c.theirs, at: c.theirs.at ?? at };
        else delete spots[c.id];
      }
      continue;
    }
    if (side === "theirs") {
      const list = byId.get(c.id) ?? [];
      list.push(c.field);
      byId.set(c.id, list);
    }
  }
  for (const [id, fields] of byId) {
    const p = merged.pending[id];
    const cur = fieldsOf(spots[id]);
    const ft = fieldsOf(theirs.spots[id]);
    for (const k of fields) {
      if (ft.has(k)) cur.set(k, ft.get(k)); else cur.delete(k);
    }
    const e = rebuild(p.op, cur, { ours: p.ours, theirs: p.theirs, at });
    if (e) spots[id] = e; else delete spots[id];
  }
  return { spots, unresolved };
}

/** 競合1件を、人が読める行にします。 */
export function formatConflict(c, { ours = "自分", theirs = "相手", hasBase = true } = {}) {
  if (c.kind === "field") {
    const before = hasBase ? `\n    分かれる前: ${val(c.base)}` : "";
    return `${c.key}　${c.name} の ${c.field}${before}\n    ${ours}: ${val(c.ours)}\n    ${theirs}: ${val(c.theirs)}`;
  }
  const side = (e) => (e ? `${OP_WORD[e.op]}${e.op === "patch" ? `（${[...Object.keys(e.set ?? {}), ...(e.unset ?? []).map((k) => `-${k}`)].join("・")}）` : ""}` : "収録のまま（差分なし）");
  return `${c.key}　${c.name}\n    ${ours}: ${side(c.ours)}\n    ${theirs}: ${side(c.theirs)}`;
}

/** 統合した中身が、ユーザーKBとして正しいか。正しくなければ理由を投げます。 */
export function checkMerged(doc) {
  const problems = checkOverlay(doc);
  if (problems.length) {
    throw new UserKbError("invalid_input",
      `統合した結果がユーザーKBの決まりに合いません（書き込んでいません）:\n${problems.slice(0, 8).map((p) => `  ${p.id}: ${p.problem}`).join("\n")}`);
  }
  return doc;
}

// --- 点検 -------------------------------------------------------------------------

const JAPAN = { latMin: 20, latMax: 46.5, lngMin: 122, lngMax: 154.5 };

function metersBetween(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * ユーザーKBを点検します。errors があれば、そのままでは使えない差分があります。
 * warnings は、使えるけれど見ておいたほうがよいものです。
 *
 * @param {object} doc overlay
 * @param {object} kb 公式の収録
 * @param {{report?: object, names?: string[], sameThing?: (a: string, b: string) => boolean, bytes?: number}} [opts]
 *   report = applyOverlay の報告（公式の側が変わったもの）。names = 置き場にあるユーザーKBの名前
 * @returns {{ok: boolean, errors: object[], warnings: object[], checked: number}}
 */
export function validateKb(doc, kb, { report = null, names = null, sameThing = (a, b) => a === b, bytes = null } = {}) {
  const errors = [];
  const warnings = [];
  const err = (id, code, message) => errors.push({ id, code, message });
  const warn = (id, code, message) => warnings.push({ id, code, message });

  if (doc?.schema !== SCHEMA) err("", "schema", `形の版が違います: ${doc?.schema}（今は ${SCHEMA}）`);
  for (const p of checkOverlay(doc)) err(p.id, "invalid", p.problem);
  const bad = new Set(errors.map((e) => e.id));
  const entries = Object.entries(doc?.spots && typeof doc.spots === "object" ? doc.spots : {});
  const regions = kb?.regionsById ?? new Map((kb?.regions ?? []).map((r) => [r.id, r]));
  const official = kb?.spotsById ?? new Map((kb?.spots ?? []).map((s) => [s.id, s]));

  const added = [];
  for (const [id, e] of entries) {
    if (bad.has(id) || !e || typeof e !== "object") continue;
    if (!e.at || Number.isNaN(Date.parse(e.at))) warn(id, "no_time", "書いた時刻（at）がありません");
    if (e.op === "add") {
      const s = e.spot;
      added.push({ id, ...s });
      if (s.lat === 0 && s.lng === 0) err(id, "zero_coord", "座標が 0,0 です（入れ忘れではありませんか）");
      else if (s.lat < JAPAN.latMin || s.lat > JAPAN.latMax || s.lng < JAPAN.lngMin || s.lng > JAPAN.lngMax) {
        warn(id, "outside_japan", `日本の外の座標です（${s.lat}, ${s.lng}）。緯度と経度が逆になっていませんか`);
      }
      if (s.regionId && !regions.has(s.regionId)) err(id, "unknown_region", `regionId のエリアが収録にありません: ${s.regionId}`);
      if (s.open !== undefined && s.close !== undefined && s.close <= s.open) err(id, "hours", `close（${s.close}）が open（${s.open}）より後ではありません`);
      continue;
    }
    // patch・remove は、公式のスポットを指します（足したスポットを消した印は別）。
    if (e.op === "remove" && isUserSpotId(id)) {
      if (!e.spot) err(id, "lost_spot", "消した印に、足したスポットの中身が残っていません（戻せません）");
      continue;
    }
    if (!official.has(id)) {
      const moved = report?.moved?.find((m) => m.id === id);
      if (moved) warn(id, "moved", `公式の id が変わっています（今は ${moved.to}）。名前と場所で当てています`);
      else warn(id, "orphan", `公式の収録に見つかりません（${e.anchor?.name ?? "名前なし"}）。この差分は使われません。要らなければ spot restore ${id}`);
      continue;
    }
    if (e.op === "patch") {
      const s = { ...official.get(id), ...e.set };
      for (const k of e.unset ?? []) delete s[k];
      if (s.open !== undefined && s.close !== undefined && s.close <= s.open) err(id, "hours", `直した結果、close（${s.close}）が open（${s.open}）より後ではありません`);
      if (!e.anchor?.name) warn(id, "no_anchor", "anchor（名前と場所の控え）がありません。公式の id が変わると見失います");
    }
  }
  for (const c of report?.conflicts ?? []) {
    warn(c.id, "official_changed", `${c.field}: 直したあとで公式の側も変わっています（直す前 ${val(c.was)}・今の公式 ${val(c.official)}・自分 ${val(c.user)}）`);
  }
  for (const r of report?.redundant ?? []) warn(r.id, "redundant", `${r.field}: 公式の側が同じ値になりました（この差分は消してよい）`);

  // 足したスポットどうしの重なり（同じ名前で 100m 以内）。
  added.sort((a, b) => a.lat - b.lat);
  for (let i = 0; i < added.length; i++) {
    for (let j = i + 1; j < added.length && added[j].lat - added[i].lat < 0.001; j++) {
      const a = added[i];
      const b = added[j];
      if ((a.name === b.name || sameThing(a.name, b.name)) && metersBetween(a, b) <= 100) {
        warn(b.id, "duplicate", `${a.id}（${a.name}）と重なっています（${Math.round(metersBetween(a, b))}m）`);
      }
    }
  }

  if (doc?.parent?.name && names && !names.includes(doc.parent.name)) {
    warn("", "no_parent", `分けた元のユーザーKB「${doc.parent.name}」がありません（統合のときは、空から比べます）`);
  }
  if (doc?.base?.stamp && kb && doc.base.stamp !== baseStamp(kb)) {
    warn("", "base_changed", `公式の収録の版が変わっています（書いたとき ${doc.base.stamp}・今 ${baseStamp(kb)}）`);
  }
  if (entries.length > LIMITS.entries * 0.9) warn("", "near_limit", `差分が ${entries.length} 件あります（上限 ${LIMITS.entries} 件）`);
  if (bytes !== null && bytes > LIMITS.fileBytes * 0.9) warn("", "near_limit", `ファイルが ${bytes} バイトあります（上限 ${LIMITS.fileBytes} バイト）`);
  return { ok: errors.length === 0, errors, warnings, checked: entries.length };
}

// --- 集計 -------------------------------------------------------------------------

const top = (map, n = 10) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n)
  .map(([name, count]) => ({ name, count }));
const bump = (map, key) => { if (key) map.set(key, (map.get(key) ?? 0) + 1); };

/**
 * ユーザーKBの件数・地域の分布・更新の時刻などをまとめます。
 * @param {object} doc overlay
 * @param {object} merged 公式の収録に doc を重ねたもの（applyOverlay の kb）
 * @param {object} kb 公式の収録
 */
export function kbStats(doc, merged, kb) {
  const counts = { add: 0, patch: 0, remove: 0 };
  const prefectures = new Map();
  const regions = new Map();
  const genres = new Map();
  const categories = new Map();
  const fields = new Map();
  let oldest = null;
  let newest = null;
  const official = kb?.spotsById ?? new Map((kb?.spots ?? []).map((s) => [s.id, s]));
  for (const [id, e] of Object.entries(doc?.spots ?? {})) {
    if (!(e?.op in counts)) continue;
    counts[e.op]++;
    if (e.at && !Number.isNaN(Date.parse(e.at))) {
      if (!oldest || e.at < oldest) oldest = e.at;
      if (!newest || e.at > newest) newest = e.at;
    }
    const s = merged?.spotsById?.get(id) ?? official.get(id) ?? null;
    bump(prefectures, s?.prefecture || "（分からない）");
    bump(regions, s?.region || "（分からない）");
    if (e.op === "add") {
      for (const g of e.spot?.genres ?? []) bump(genres, g);
      bump(categories, e.spot?.category);
    }
    if (e.op === "patch") for (const k of [...Object.keys(e.set ?? {}), ...(e.unset ?? [])]) bump(fields, k);
  }
  return {
    name: doc?.name ?? "",
    title: doc?.title ?? "",
    parent: doc?.parent ?? null,
    created: doc?.created ?? null,
    updated: doc?.updated ?? null,
    oldestEntry: oldest,
    newestEntry: newest,
    total: counts.add + counts.patch + counts.remove,
    counts,
    base: { stamp: doc?.base?.stamp ?? "", current: kb ? baseStamp(kb) : "", changed: !!(kb && doc?.base?.stamp && doc.base.stamp !== baseStamp(kb)) },
    prefectures: top(prefectures, 47),
    regions: top(regions, 10),
    genres: top(genres, 8),
    categories: top(categories, 10),
    editedFields: top(fields, Object.keys(SPOT_FIELDS).length),
  };
}

/** 統合で足されるスポットのうち、もとからあるものと重なっていそうな組。 */
export function mergeDuplicates(taken, spots, mergedSpots, { sameThing = (a, b) => a === b, radius = 100 } = {}) {
  const out = [];
  const news = taken.filter((t) => t.how === "add" && spots[t.id]?.op === "add").map((t) => ({ id: t.id, ...spots[t.id].spot }));
  if (!news.length) return out;
  const newIds = new Set(news.map((n) => n.id));
  for (const n of news) {
    for (const s of mergedSpots) {
      if (s.id === n.id || (newIds.has(s.id) && s.id > n.id)) continue;
      if (!Number.isFinite(s.lat) || Math.abs(s.lat - n.lat) > 0.002 || Math.abs(s.lng - n.lng) > 0.002) continue;
      if (!(s.name === n.name || sameThing(s.name, n.name))) continue;
      const m = metersBetween(s, n);
      if (m <= radius) out.push({ id: n.id, name: n.name, with: s.id, withName: s.name, meters: Math.round(m) });
    }
  }
  return out;
}

/** validateSpot を通して、統合のあとの add の中身を整えます（余計な項目が混じっていたら理由を返します）。 */
export function normalizeAdded(spots) {
  for (const [id, e] of Object.entries(spots)) {
    if (e.op !== "add") continue;
    const { value, errors } = validateSpot(e.spot);
    if (errors.length) throw new UserKbError("invalid_input", `${id}: ${errors.join(" / ")}`);
    e.spot = value;
  }
  return spots;
}
