#!/usr/bin/env node
// バス停・駅・観光地のデータ配信 API（GET /v1/data/…）の、持ち主の道具。
//
//   node tools/data_api.mjs build [--out .data-api/v1] [--exclude yahoo] [--gtfs <dir> …]
//   node tools/data_api.mjs check [.data-api/v1]
//   node tools/data_api.mjs push  [.data-api/v1] [--dry-run]
//   node tools/data_api.mjs key new <名前> [--per-minute N] [--dry-run]
//   node tools/data_api.mjs key revoke <鍵 か 指紋の頭16文字>
//   node tools/data_api.mjs get spots --near 35.68,139.76 [--radius 2] [--base URL] [--key 鍵]
//
// ./tabisaki data … からも同じものを呼べます。説明は docs/data-api.md。
//
// build は、リポジトリの kb/ から「再配布してよいもの」だけを集めて、
// server/data-api.js が読む形（0.5度四方のタイル）に書きます。
// **kb-private/（国土数値情報の非商用データ）は読みません。** 読めないように、
// 入力の道に kb-private・.private-kb が入っていたら止めます。
//
// push は Workers KV（バインディング DATA_KB）に入れます。npx wrangler の
// ログイン（npx wrangler login）か CLOUDFLARE_API_TOKEN が要ります。
// KV の無料枠は「1日 1,000 回の書き込み」なので、1回の push で書く鍵の数を
// 先に数えて出します。

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourcesOf, SOURCES } from "../packages/core/src/provenance.js";
import {
  DATA_SCHEMA, GTFS_SOURCE_PREFIX, KEY_PATTERN, KEY_PREFIX, KV_PREFIX,
  publicProblem, tileOf,
} from "../server/data-api.js";
import { createDataClient } from "../packages/core/src/data-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = ".data-api/v1";
const BINDING = "DATA_KB";

const PREFS = ["hokkaido", "aomori", "iwate", "miyagi", "akita", "yamagata", "fukushima", "ibaraki",
  "tochigi", "gunma", "saitama", "chiba", "tokyo", "kanagawa", "niigata", "toyama", "ishikawa", "fukui",
  "yamanashi", "nagano", "gifu", "shizuoka", "aichi", "mie", "shiga", "kyoto", "osaka", "hyogo", "nara",
  "wakayama", "tottori", "shimane", "okayama", "hiroshima", "yamaguchi", "tokushima", "kagawa", "ehime",
  "kochi", "fukuoka", "saga", "nagasaki", "kumamoto", "oita", "miyazaki", "kagoshima", "okinawa"];

/** 駅（国土数値情報 N02）の台帳。docs/kokudo-licenses.md の「商用可」。 */
export const EXTRA_SOURCES = {
  kokudo_n02: {
    required: true,
    name: "国土数値情報（鉄道データ N02、2008年度）",
    nameEn: "National Land Numerical Information (Railway N02, FY2008)",
    license: "国土数値情報利用約款（商用可）",
    licenseUrl: "https://nlftp.mlit.go.jp/ksj/other/agreement_02.html",
    attribution: "「国土数値情報（鉄道データ）」（国土交通省）を加工して作成",
    attributionEn: "Processed from National Land Numerical Information (Railway), MLIT Japan",
  },
};

/** 台帳から、配る manifest に載せる項目だけを抜きます。 */
function ledgerEntry(id, s) {
  const out = { name: s.name, license: s.license };
  for (const k of ["nameEn", "licenseUrl", "url", "attribution", "attributionEn"]) if (s[k]) out[k] = s[k];
  if (s.required) out.required = true;
  if (s.shareAlike) out.shareAlike = true;
  return out;
}

function refusePrivate(path) {
  if (/kb-private|\.private-kb/.test(resolve(path))) {
    throw new Error(`非商用データの置き場は読みません: ${path}`);
  }
}

function readJson(path) {
  refusePrivate(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** CSV の1行ずつ（"…" の中のカンマと改行を扱う）。 */
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); cell = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** 収録のスポット（kb/spots-jpNN-*.json）から、配る1件ずつ。 */
export function spotItems(kbDir, { exclude = new Set() } = {}) {
  const items = []; const dropped = {};
  const files = readdirSync(kbDir).filter((f) => /^spots-jp\d\d-[a-z]+\.json$/.test(f)).sort();
  for (const f of files) {
    const pref = f.slice(8, 10);
    for (const spot of readJson(join(kbDir, f)).spots ?? []) {
      const sources = sourcesOf(spot);
      const bad = sources.find((s) => exclude.has(s));
      if (bad) { dropped[bad] = (dropped[bad] ?? 0) + 1; continue; }
      const it = { ...spot, pref, sources };
      const why = publicProblem(it);
      if (why) { dropped[why] = (dropped[why] ?? 0) + 1; continue; }
      items.push(it);
    }
  }
  return { items, dropped };
}

/** 手で足した駅（tools/station_updates.py の ADDED）。これは旅さきの独自データです。 */
function handAddedStations() {
  const p = join(ROOT, "tools/station_updates.py");
  if (!existsSync(p)) return new Set();
  const src = readFileSync(p, "utf8");
  const block = /ADDED\s*=\s*\[([\s\S]*?)\n\]/.exec(src)?.[1] ?? "";
  const out = new Set();
  for (const m of block.matchAll(/\[\s*([\d.]+),\s*([\d.]+),\s*"([^"]+)"/g)) out.add(`${m[3]}|${Number(m[1])}|${Number(m[2])}`);
  return out;
}

const shortHash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);

/** 駅（kb/stops-rail.json）。 */
export function stationItems(kbDir, { exclude = new Set() } = {}) {
  const p = join(kbDir, "stops-rail.json");
  if (!existsSync(p)) return { items: [], dropped: {} };
  const hand = handAddedStations();
  const items = []; const dropped = {};
  for (const [lat, lng, name] of readJson(p).stops ?? []) {
    const src = hand.has(`${name}|${lat}|${lng}`) ? "tabisaki_original" : "kokudo_n02";
    if (exclude.has(src)) { dropped[src] = (dropped[src] ?? 0) + 1; continue; }
    const it = { id: `st-${shortHash(`${name}|${lat}|${lng}`)}`, kind: "station", name, lat, lng, sources: [src] };
    const why = publicProblem(it);
    if (why) { dropped[why] = (dropped[why] ?? 0) + 1; continue; }
    items.push(it);
  }
  return { items, dropped };
}

/**
 * GTFS（GTFS-JP）の停留所。dir に stops.txt と license.json が要ります。
 * license.json が無い時刻表は**配りません**（ライセンスの分からないものを出さない）。
 *
 *   license.json = { "id": "ryobi", "name": "両備バス", "license": "CC BY 4.0",
 *                    "licenseUrl": "…", "attribution": "両備ホールディングス（CC BY 4.0）" }
 */
export function gtfsStopItems(dirs) {
  const items = []; const ledger = {}; const skipped = [];
  for (const dir of dirs) {
    refusePrivate(dir);
    const lic = join(dir, "license.json");
    const stops = join(dir, "stops.txt");
    if (!existsSync(lic) || !existsSync(stops)) { skipped.push(`${dir}（license.json か stops.txt がありません）`); continue; }
    const L = JSON.parse(readFileSync(lic, "utf8"));
    if (!/^[a-z0-9_-]{1,40}$/.test(L.id ?? "") || !L.license || !L.attribution) {
      skipped.push(`${dir}（license.json に id・license・attribution が要ります）`); continue;
    }
    const sid = `${GTFS_SOURCE_PREFIX}${L.id}`;
    ledger[sid] = ledgerEntry(sid, { ...L, required: true });
    for (const r of parseCsv(readFileSync(stops, "utf8"))) {
      const lt = String(r.location_type ?? "").trim();
      if (lt !== "" && lt !== "0" && lt !== "1") continue;
      const lat = Number(r.stop_lat); const lng = Number(r.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !r.stop_name) continue;
      items.push({ id: `${L.id}:${r.stop_id}`, kind: lt === "1" ? "station" : "stop", name: r.stop_name,
        lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, sources: [sid] });
    }
  }
  return { items, ledger, skipped };
}

function tiled(items) {
  const m = new Map();
  for (const it of items) {
    const t = tileOf(it.lat, it.lng);
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(it);
  }
  for (const list of m.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return new Map([...m.entries()].sort());
}

/**
 * 入れ物を作ります。files は { 道: 中身 }（JSON にする前）。
 */
export function buildDataset({ kbDir = join(ROOT, "kb"), exclude = [], gtfs = [], now = new Date() } = {}) {
  refusePrivate(kbDir);
  const ex = new Set(exclude);
  const spots = spotItems(kbDir, { exclude: ex });
  const stations = stationItems(kbDir, { exclude: ex });
  const stops = gtfsStopItems(gtfs);
  const ids = new Set();
  for (const it of spots.items) {
    if (ids.has(it.id)) throw new Error(`同じ id が2つあります: ${it.id}`);
    ids.add(it.id);
  }

  const files = {};
  const datasets = {};
  const put = (name, list, description, extra = {}) => {
    const t = tiled(list);
    for (const [tile, items] of t) files[`${name}/${tile}.json`] = { items };
    datasets[name] = { count: list.length, tiles: [...t.keys()], description, ...extra };
  };
  const prefTiles = {};
  for (const it of spots.items) {
    (prefTiles[it.pref] ??= new Set()).add(tileOf(it.lat, it.lng));
  }
  put("spots", spots.items, "観光地・名所（kb/spots-*.json のうち再配布できるもの）", {
    prefTiles: Object.fromEntries(Object.entries(prefTiles).map(([k, v]) => [k, [...v].sort()])),
  });
  put("stations", stations.items, "鉄道の駅（国土数値情報 N02 2008年度＋手で足した新しい駅）");
  put("stops", stops.items, "バス停（GTFS-JP のうち、ライセンスの分かる時刻表から）");
  for (const it of spots.items) {
    const shard = `spots-index/${createHash("sha1").update(String(it.id)).digest("hex")[0]}.json`;
    (files[shard] ??= {})[it.id] = tileOf(it.lat, it.lng);
  }

  const used = new Set();
  for (const list of [spots.items, stations.items, stops.items]) for (const it of list) for (const s of it.sources) used.add(s);
  const sources = {};
  for (const id of [...used].sort()) {
    const s = SOURCES[id] ?? EXTRA_SOURCES[id] ?? stops.ledger[id];
    if (!s) throw new Error(`台帳に無い出どころです: ${id}`);
    sources[id] = s === stops.ledger[id] ? s : ledgerEntry(id, s);
  }

  const body = JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]]));
  const day = now.toISOString().slice(0, 10);
  const version = `${day}.${createHash("sha256").update(body).digest("hex").slice(0, 8)}`;
  files["manifest.json"] = {
    schema: DATA_SCHEMA,
    api: 1,
    version,
    generatedAt: now.toISOString(),
    datasets,
    sources,
    terms: {
      summary: "1件ごとの sources と、返事の license_summary.attribution に出る表記を、使う先でも表示してください。"
        + "旅さきの独自データ（tabisaki_original）は PolyForm Noncommercial 1.0.0（商用は不可）です。"
        + "OpenStreetMap（osm）・Wikipedia（wikipedia）由来の項目は継承（share-alike）の条件があります。",
      doc: "https://github.com/shitianliang1000-alt/tabisaki.github.io/blob/main/docs/data-api.md",
    },
    excluded: [
      "国土数値情報の非商用データ（P11 バス停・P12 観光資源・P27 文化施設）: 再配布できないため、この API では配りません",
      ...[...ex].map((s) => `出どころ ${s}: build --exclude で外しました`),
    ],
  };
  return {
    files, version,
    report: {
      spots: spots.items.length, stations: stations.items.length, stops: stops.items.length,
      dropped: { ...spots.dropped, ...stations.dropped }, gtfsSkipped: stops.skipped,
      keys: Object.keys(files).length,
    },
  };
}

export function writeDataset(out, files) {
  refusePrivate(out);
  rmSync(out, { recursive: true, force: true });
  for (const [p, v] of Object.entries(files)) {
    const full = join(out, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(v));
  }
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}

/** 書いた入れ物を、もう一度1件ずつ確かめます。問題の一覧を返します。 */
export function checkDataset(dir) {
  const problems = [];
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (m.schema !== DATA_SCHEMA) problems.push(`manifest.schema が ${DATA_SCHEMA} ではありません`);
  for (const id of Object.keys(m.sources ?? {})) {
    if (publicProblem({ sources: [id], lat: 0, lng: 0 })) problems.push(`台帳に配れない出どころがあります: ${id}`);
  }
  for (const f of walk(dir)) {
    if (!/^(spots|stations|stops)\//.test(f)) continue;
    const page = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const it of page.items ?? []) {
      const why = publicProblem(it);
      if (why) problems.push(`${f} ${it.id}: ${why}`);
      for (const s of it.sources ?? []) if (!m.sources?.[s]) problems.push(`${f} ${it.id}: 台帳に無い出どころ ${s}`);
      if (problems.length > 50) return problems;
    }
  }
  return problems;
}

function wrangler(args, { dryRun }) {
  if (dryRun) { console.log(`(試し) npx wrangler ${args.join(" ")}`); return ""; }
  return execFileSync("npx", ["wrangler", ...args], { stdio: ["ignore", "pipe", "inherit"], cwd: ROOT }).toString();
}

/** KV に入れます。manifest は最後に1つだけ書きます（読む側が新しい版に切り替わる合図）。 */
export function pushDataset(dir, { dryRun = false } = {}) {
  const problems = checkDataset(dir);
  if (problems.length) throw new Error(`確かめで止めました:\n${problems.slice(0, 10).join("\n")}`);
  const files = walk(dir).filter((f) => f !== "manifest.json");
  const bulk = files.map((f) => ({ key: `${KV_PREFIX}${f}`, value: readFileSync(join(dir, f), "utf8") }));
  const tmp = join(ROOT, ".data-api", "kv-bulk.json");
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, JSON.stringify(bulk));
  console.log(`KV に ${bulk.length + 1} 個の鍵を書きます（無料枠は1日 1,000 回まで）`);
  wrangler(["kv", "bulk", "put", tmp, "--binding", BINDING, "--remote"], { dryRun });
  wrangler(["kv", "key", "put", `${KV_PREFIX}manifest.json`, "--path", join(dir, "manifest.json"),
    "--binding", BINDING, "--remote"], { dryRun });
  if (!dryRun) rmSync(tmp, { force: true });
}

export function newKey() {
  return `tbk_${randomBytes(30).toString("base64url")}`;
}

function args(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) opt[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) opt[k] = argv[++i];
      else opt[k] = true;
      if (k === "gtfs") { (opt.gtfsList ??= []).push(opt[k]); }
    } else pos.push(a);
  }
  return { pos, opt };
}

const HELP = `使いかた: node tools/data_api.mjs <コマンド>

  build [--out DIR] [--exclude yahoo,…] [--gtfs DIR …]   入れ物を作る（既定 ${DEFAULT_OUT}）
  check [DIR]                       配れないものが混ざっていないか確かめる
  push  [DIR] [--dry-run]           Workers KV（${BINDING}）に入れる（npx wrangler login が要ります）
  key new <名前> [--per-minute N]   鍵を作って KV に指紋を入れる（鍵はこのとき1回だけ出ます）
  key revoke <鍵|指紋の頭16文字>    鍵を取り消す
  get <spots|stations|stops|spot|manifest> [--near 緯度,経度] [--radius km] [--bbox w,s,e,n]
      [--pref 13] [--id ID] [--base URL] [--key 鍵]        API を呼んで JSON を出す

説明は docs/data-api.md にあります。`;

async function main(argv) {
  const { pos, opt } = args(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === "help" || opt.help) { console.log(HELP); return 0; }
  if (cmd === "build") {
    const out = resolve(String(opt.out ?? DEFAULT_OUT));
    const exclude = String(opt.exclude ?? "").split(",").filter(Boolean);
    const { files, version, report } = buildDataset({ exclude, gtfs: opt.gtfsList ?? [] });
    writeDataset(out, files);
    if (!opt.quiet) {
      console.log(`版 ${version} → ${out}`);
      console.log(`  スポット ${report.spots}・駅 ${report.stations}・バス停 ${report.stops}・ファイル ${report.keys}`);
      for (const [k, n] of Object.entries(report.dropped)) console.log(`  外した: ${k} … ${n}件`);
      for (const s of report.gtfsSkipped) console.log(`  時刻表を飛ばした: ${s}`);
    }
    const problems = checkDataset(out);
    if (problems.length) { console.error(problems.join("\n")); return 1; }
    return 0;
  }
  if (cmd === "check") {
    const problems = checkDataset(resolve(rest[0] ?? DEFAULT_OUT));
    if (problems.length) { console.error(problems.join("\n")); return 1; }
    console.log("問題なし（配れない出どころは入っていません）");
    return 0;
  }
  if (cmd === "push") { pushDataset(resolve(rest[0] ?? DEFAULT_OUT), { dryRun: Boolean(opt["dry-run"]) }); return 0; }
  if (cmd === "key") {
    const [sub, name] = rest;
    const dryRun = Boolean(opt["dry-run"]);
    if (sub === "new") {
      if (!name) { console.error("名前を付けてください（例: key new my-cli）"); return 2; }
      const key = newKey();
      const hash = createHash("sha256").update(key).digest("hex");
      const rec = { name, createdAt: new Date().toISOString(),
        ...(opt["per-minute"] ? { perMinute: Number(opt["per-minute"]) } : {}) };
      wrangler(["kv", "key", "put", `${KEY_PREFIX}${hash}`, JSON.stringify(rec), "--binding", BINDING, "--remote"], { dryRun });
      console.log(`鍵: ${key}\n指紋: ${hash.slice(0, 16)}（取り消すときに使います）\n鍵はここで1回だけ出ます。控えてください。`);
      return 0;
    }
    if (sub === "revoke") {
      if (!name) { console.error("鍵か指紋の頭16文字を渡してください"); return 2; }
      let hash = name;
      if (KEY_PATTERN.test(name)) hash = createHash("sha256").update(name).digest("hex");
      else if (/^[0-9a-f]{16}$/.test(name)) {
        const list = wrangler(["kv", "key", "list", "--binding", BINDING, "--remote", "--prefix", `${KEY_PREFIX}${name}`], { dryRun });
        const found = dryRun ? [] : JSON.parse(list || "[]");
        if (!dryRun && found.length !== 1) { console.error(`指紋 ${name} の鍵が ${found.length} 個です`); return 1; }
        hash = dryRun ? `${name}…` : found[0].name.slice(KEY_PREFIX.length);
      } else { console.error("鍵（tbk_…）か指紋の頭16文字を渡してください"); return 2; }
      wrangler(["kv", "key", "delete", `${KEY_PREFIX}${hash}`, "--binding", BINDING, "--remote"], { dryRun });
      console.log("取り消しました（Worker の控えが切れるまで、最大1分ほど使えることがあります）");
      return 0;
    }
    console.error(HELP); return 2;
  }
  if (cmd === "get") {
    const client = createDataClient({ base: opt.base, key: opt.key ?? process.env.TABISAKI_DATA_KEY });
    const what = rest[0];
    const q = {};
    if (opt.near) q.near = String(opt.near);
    if (opt.radius) q.radius = String(opt.radius);
    if (opt.bbox) q.bbox = String(opt.bbox);
    if (opt.pref) q.pref = String(opt.pref);
    if (opt.limit) q.limit = String(opt.limit);
    let res;
    if (what === "manifest") res = await client.manifest();
    else if (what === "spot") res = await client.spot(String(opt.id ?? rest[1] ?? ""));
    else if (["spots", "stations", "stops"].includes(what)) res = await client[what](q);
    else { console.error(HELP); return 2; }
    console.log(JSON.stringify(res, null, 2));
    return 0;
  }
  console.error(HELP);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message ?? e); process.exit(1); });
}
