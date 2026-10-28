// プラグイン（第1版）: 旅程のひな形と、行き先の除外を足す仕組み（docs/plugins.md）。
//
// 第1版のプラグインは **データだけ** です。JSON の宣言を読むだけで、プラグインの
// コードは一切動かしません。だから「ファイルを読む・通信する・ほかを書き換える」
// 権限の問題が、そもそも起きません（docs/plugins.md の脅威モデル）。
//
//     plugins/<id>/tabisaki-plugin.json   ← 1つのプラグイン = 1つのフォルダと1つのファイル
//     plugins.lock.json                   ← 使ってよいと決めたプラグインの版と sha256
//
// 置いただけでは使いません。`tabisaki plugins trust <id>` で中身の sha256 を
// 控えたものだけを読みます。中身が1文字でも変われば、控え直すまで止まります。

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** プラグインの形の版。形を壊す変更をしたら上げます。 */
export const PLUGIN_API = 1;
export const MANIFEST = "tabisaki-plugin.json";
export const LOCK = "plugins.lock.json";
const MAX_BYTES = 64 * 1024;
const MAX_TEMPLATES = 50;
const MAX_CONSTRAINTS = 20;
const TRANSPORTS = ["any", "transit", "car", "walk", "local"];
const ID = /^[a-z0-9][a-z0-9-]{1,40}(\.[a-z0-9][a-z0-9-]{0,40}){0,3}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const TOP = ["schema", "id", "name", "version", "description", "author", "homepage", "license", "api", "contributes"];
const TEMPLATE_KEYS = ["name", "keywords", "wish", "days", "transport", "from"];
const CONSTRAINT_KEYS = ["name", "exclude_categories", "exclude_spot_ids"];

/** 既定の置き場所。TABISAKI_PLUGIN_DIR で変えられます。 */
export function pluginDir(env = process.env) {
  if (env.TABISAKI_PLUGIN_DIR) return env.TABISAKI_PLUGIN_DIR;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "tabisaki", "plugins");
}

const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const strList = (v, maxItems, maxLen) => Array.isArray(v) && v.length > 0 && v.length <= maxItems && v.every((x) => str(x, maxLen));

/**
 * 宣言（tabisaki-plugin.json の中身）を確かめます。知らない項目は、まちがいにします
 * （書きまちがいに気づけるように。将来の項目とぶつからないように）。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest(m) {
  const errors = [];
  const err = (s) => errors.push(s);
  if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, errors: ["JSON のオブジェクトではありません"] };
  for (const k of Object.keys(m)) if (!TOP.includes(k)) err(`知らない項目: ${k}`);
  if (m.schema !== 1) err("schema は 1 です");
  if (typeof m.id !== "string" || !ID.test(m.id)) err("id は英小文字・数字・- と . で（例: jp.example.onsen-only）");
  if (!str(m.name, 60)) err("name は60字までの文字");
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) err("version は 1.2.3 の形");
  if (!str(m.author, 100)) err("author が要ります");
  if (!str(m.license, 60)) err("license が要ります（例: CC0-1.0）");
  if (m.description !== undefined && !str(m.description, 300)) err("description は300字まで");
  if (m.homepage !== undefined && !(typeof m.homepage === "string" && /^https:\/\/[^\s]{1,200}$/.test(m.homepage))) err("homepage は https:// で");
  if (m.api !== PLUGIN_API) err(`api は ${PLUGIN_API} です（この旅さきが読めるのは第${PLUGIN_API}版）`);

  const c = m.contributes;
  if (!c || typeof c !== "object" || Array.isArray(c)) { err("contributes が要ります"); return { ok: false, errors }; }
  for (const k of Object.keys(c)) if (!["templates", "constraints"].includes(k)) err(`contributes に知らない項目: ${k}`);
  const templates = c.templates ?? [];
  const constraints = c.constraints ?? [];
  if (!Array.isArray(templates) || templates.length > MAX_TEMPLATES) err(`templates は${MAX_TEMPLATES}個までの並び`);
  if (!Array.isArray(constraints) || constraints.length > MAX_CONSTRAINTS) err(`constraints は${MAX_CONSTRAINTS}個までの並び`);
  if (!templates.length && !constraints.length) err("templates か constraints のどちらかが要ります");

  (Array.isArray(templates) ? templates : []).forEach((t, i) => {
    const at = `templates[${i}]`;
    if (!t || typeof t !== "object") return err(`${at} がオブジェクトではありません`);
    for (const k of Object.keys(t)) if (!TEMPLATE_KEYS.includes(k)) err(`${at} に知らない項目: ${k}`);
    if (!str(t.name, 40)) err(`${at}.name は40字まで`);
    if (!strList(t.keywords, 10, 30)) err(`${at}.keywords は30字までの言葉を1〜10個`);
    if (!str(t.wish, 500)) err(`${at}.wish は500字まで`);
    if (t.days !== undefined && !(Number.isInteger(t.days) && t.days >= 1 && t.days <= 14)) err(`${at}.days は1〜14`);
    if (t.transport !== undefined && !TRANSPORTS.includes(t.transport)) err(`${at}.transport は ${TRANSPORTS.join(" / ")}`);
    if (t.from !== undefined && !str(t.from, 40)) err(`${at}.from は40字まで`);
  });
  (Array.isArray(constraints) ? constraints : []).forEach((x, i) => {
    const at = `constraints[${i}]`;
    if (!x || typeof x !== "object") return err(`${at} がオブジェクトではありません`);
    for (const k of Object.keys(x)) if (!CONSTRAINT_KEYS.includes(k)) err(`${at} に知らない項目: ${k}`);
    if (!str(x.name, 40)) err(`${at}.name は40字まで`);
    const cats = x.exclude_categories, ids = x.exclude_spot_ids;
    if (cats === undefined && ids === undefined) err(`${at} に exclude_categories か exclude_spot_ids が要ります`);
    if (cats !== undefined && !strList(cats, 50, 20)) err(`${at}.exclude_categories は20字までの言葉を1〜50個`);
    if (ids !== undefined && !strList(ids, 500, 80)) err(`${at}.exclude_spot_ids は1〜500個`);
  });
  return { ok: errors.length === 0, errors };
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** 控え（plugins.lock.json）を読みます。無ければ空です。 */
export async function readLock(dir) {
  try {
    const j = JSON.parse(await readFile(path.join(dir, LOCK), "utf8"));
    return j && typeof j.plugins === "object" ? j.plugins : {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`${LOCK} が読めません: ${e.message}`);
  }
}

async function writeLock(dir, plugins) {
  const file = path.join(dir, LOCK);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, plugins }, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * 置き場所のプラグインを調べます（読むだけで、何も動かしません）。
 * @returns {Promise<Array<{id: string, dir: string, status: "enabled"|"untrusted"|"changed"|"invalid",
 *   manifest?: object, sha256?: string, errors?: string[]}>>}
 */
export async function scanPlugins(dir = pluginDir()) {
  let names;
  try { names = await readdir(dir); } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const lock = await readLock(dir);
  const out = [];
  for (const name of names.sort()) {
    const sub = path.join(dir, name);
    // 外を指すリンクで、置き場所の外のファイルを読ませない
    const st = await lstat(sub);
    if (!st.isDirectory()) continue;
    const file = path.join(sub, MANIFEST);
    let fst;
    try { fst = await lstat(file); } catch { continue; }
    if (!fst.isFile()) { out.push({ id: name, dir: sub, status: "invalid", errors: [`${MANIFEST} がふつうのファイルではありません`] }); continue; }
    if (fst.size > MAX_BYTES) { out.push({ id: name, dir: sub, status: "invalid", errors: [`${MANIFEST} は ${MAX_BYTES / 1024}KB までです`] }); continue; }
    const buf = await readFile(file);
    let manifest;
    try { manifest = JSON.parse(buf.toString("utf8")); } catch {
      out.push({ id: name, dir: sub, status: "invalid", errors: ["JSON として読めません"] }); continue;
    }
    const v = validateManifest(manifest);
    if (v.ok && manifest.id !== name) v.errors.push(`フォルダの名前（${name}）と id（${manifest.id}）がちがいます`);
    if (v.errors.length) { out.push({ id: name, dir: sub, status: "invalid", errors: v.errors }); continue; }
    const hash = sha256(buf);
    const pinned = lock[manifest.id];
    const status = !pinned ? "untrusted" : pinned.sha256 === hash ? "enabled" : "changed";
    out.push({ id: manifest.id, dir: sub, status, manifest, sha256: hash });
  }
  return out;
}

/** 控えた（enabled の）プラグインだけを返します。 */
export async function loadPlugins(dir = pluginDir()) {
  return (await scanPlugins(dir)).filter((p) => p.status === "enabled");
}

/** 今の中身を控えます（使ってよいと決める）。 */
export async function trustPlugin(dir, id) {
  const found = (await scanPlugins(dir)).find((p) => p.id === id);
  if (!found) throw new Error(`${id} が ${dir} にありません`);
  if (found.status === "invalid") throw new Error(`${id} の宣言にまちがいがあります: ${found.errors.join(" / ")}`);
  const lock = await readLock(dir);
  lock[id] = { version: found.manifest.version, sha256: found.sha256, trustedAt: new Date().toISOString() };
  await writeLock(dir, lock);
  return found;
}

/** 控えから外します（フォルダは消しません。消すのは利用者の手で）。 */
export async function untrustPlugin(dir, id) {
  const lock = await readLock(dir);
  if (!lock[id]) return false;
  delete lock[id];
  await writeLock(dir, lock);
  return true;
}

/**
 * 希望の文に合うひな形を探します。名前が同じか、言葉のどれかが含まれていれば合います。
 * @returns {{plugin: string, template: object} | null}
 */
export function findTemplate(text, plugins) {
  const t = String(text ?? "");
  for (const p of plugins) {
    for (const tpl of p.manifest.contributes.templates ?? []) {
      if (t === tpl.name || tpl.keywords.some((k) => t.includes(k))) return { plugin: p.id, template: tpl };
    }
  }
  return null;
}

/** ひな形を、旅程の頼み（PlanRequest）に重ねます。利用者が書いた値が勝ちます。 */
export function applyTemplate(request, found) {
  if (!found) return request;
  const { template } = found;
  const out = { ...request, wish: template.wish };
  for (const k of ["days", "transport", "from"]) if (request[k] === undefined && template[k] !== undefined) out[k] = template[k];
  return out;
}

/** 除外を、知識ベースに当てます（もとの kb は変えません）。 */
export function applyConstraints(kb, plugins) {
  const cats = new Set();
  const ids = new Set();
  for (const p of plugins) {
    for (const c of p.manifest.contributes.constraints ?? []) {
      for (const x of c.exclude_categories ?? []) cats.add(x);
      for (const x of c.exclude_spot_ids ?? []) ids.add(x);
    }
  }
  if (!cats.size && !ids.size) return kb;
  const spots = kb.spots.filter((s) => !cats.has(s.category) && !ids.has(s.id));
  // 引き出し（地域ごと・id ごと）も、除いたあとの並びで作り直します。
  const spotsById = new Map();
  const spotsByRegion = new Map();
  for (const s of spots) {
    spotsById.set(s.id, s);
    const list = spotsByRegion.get(s.regionId);
    if (list) list.push(s); else spotsByRegion.set(s.regionId, [s]);
  }
  return { ...kb, spots, spotsById, spotsByRegion };
}
