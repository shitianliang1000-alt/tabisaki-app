// tabisaki spot add / edit / rm / restore / list / show / import / export / dedup
//
// 自分のユーザーKB（~/.tabisaki/kbs/<名前>/。docs/user-kb.md）のスポットを、端末から足す・直す・消す・
// 一覧・取り込み・書き出しします。公式の kb/ には書きません。
// 終了コード: 0 = できた、1 = できなかった（一部の行が取り込めなかった、を含む）、2 = 使いかたのまちがい

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

export const VERBS = ["add", "edit", "rm", "restore", "list", "show", "import", "export", "dedup"];

export const HELP = `使いかた: tabisaki spot <コマンド> … [--kb=<名前>]

  spot add [項目=値 …]            スポットを足す（項目を書かずに端末で動かすと、1つずつ聞きます）
  spot edit <スポット> 項目=値 … [--unset=項目,…]   直す（公式のスポットは差分として持ちます）
  spot rm <スポット> [--reason=…] [--yes]          消す（印を付けるだけ。spot restore で戻せます）
  spot restore <スポット>          消した印・直した差分を取り消す
  spot list [--all] [--q=語] [--limit=50]   自分が足した・直した・消したスポット（--all で収録も探す）
  spot show <スポット>             1件の中身と、差分の状態
  spot import <ファイル> [--format=csv|geojson|kml|json] [--encoding=shift_jis]
                         [--dry-run] [--strict] [--allow-dup]
  spot export [--format=csv|geojson|kml|json] [--out=<ファイル>] [--with-edited]
  spot dedup [--radius=100]        足したスポットのうち、収録や互いに重なっていそうなもの

  <スポット> は id（takao-1・u:…）か名前。同じ名前がいくつもあるときは id で選びます。
  項目: name lat lng category genres regionId description address url wikipedia tel
        fame_tier dwell open close fee（genres は nature;view のように ; で区切る）
  --kb=<名前>  ユーザーKB の名前（既定: 環境変数 TABISAKI_KB、kb switch で決めたもの、どちらも無ければ mine。
               まだ無ければ作ります）
  --output=json  list・show・dedup・import の結果を JSON で

置き場: TABISAKI_HOME（無ければ ~/.tabisaki）の kbs/<名前>/。書くたびに backups/ に控えます。
`;

const FLAGS = {
  add: ["kb", "output", "force"],
  edit: ["kb", "unset", "output"],
  rm: ["kb", "reason", "yes"],
  restore: ["kb"],
  list: ["kb", "all", "q", "limit", "output"],
  show: ["kb", "output"],
  import: ["kb", "format", "encoding", "dry-run", "strict", "allow-dup", "output"],
  export: ["kb", "format", "out", "with-edited"],
  dedup: ["kb", "radius", "output"],
};
const BOOL = new Set(["all", "yes", "dry-run", "strict", "allow-dup", "with-edited", "force", "help"]);

function usage(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

export function parseSpotArgs(verb, argv) {
  const opts = {};
  const words = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(a);
    if (!m) { words.push(a); continue; }
    const [, key, value] = m;
    if (key === "help") { opts.help = true; continue; }
    if (!FLAGS[verb].includes(key)) throw usage(`spot ${verb} に --${key} はありません（tabisaki spot help）`);
    if (BOOL.has(key)) {
      if (value !== undefined) throw usage(`--${key} は値を取りません`);
      opts[key] = true;
      continue;
    }
    if (value === undefined || value === "") throw usage(`--${key}=<値> の形で書いてください`);
    opts[key] = value;
  }
  return { opts, words };
}

/** 項目=値 の並びを、スポットの入力にします。 */
export function parseAssignments(words) {
  const out = {};
  for (const w of words) {
    const i = w.indexOf("=");
    if (i <= 0) throw usage(`「項目=値」の形で書いてください: ${w}`);
    const key = w.slice(0, i).trim();
    const value = w.slice(i + 1);
    if (key in out) throw usage(`${key} を2回書いています`);
    out[key] = key === "genres" ? value.split(/[;,]/).map((g) => g.trim()).filter(Boolean) : value;
  }
  return out;
}

const STATUS = { add: "足した", patch: "直した", remove: "消した" };

/**
 * 使うユーザーKBの名前。--kb、環境変数 TABISAKI_KB、kb switch で決めたもの、mine の順に見ます。
 */
export async function kbNameFor(opts, env, store, userkb) {
  return userkb.validateKbName(opts.kb ?? (env.TABISAKI_KB?.trim() || null) ?? (await store.current()) ?? "mine");
}

export async function openKb(opts, env) {
  const core = await import("../../core/index.mjs");
  const { userkb } = core;
  const store = userkb.openStore({ home: userkb.userKbHome(env) });
  const name = await kbNameFor(opts, env, store, userkb);
  let doc;
  try {
    doc = await store.load(name);
  } catch (e) {
    if (e.code !== "not_found") throw e;
    doc = null;
  }
  // 公式の収録は、本体のログを黙らせて読みます（stdout には結果だけを出します）。
  const saved = [console.log, console.warn, console.info];
  console.log = console.warn = console.info = () => {};
  let official;
  try {
    official = await core.createCore();
  } finally {
    [console.log, console.warn, console.info] = saved;
  }
  const { sameThing } = await import("../../core/src/dedupe.js");
  return {
    core, userkb, store, name, sameThing,
    kb: official.kb,
    doc: doc ?? userkb.emptyOverlay(name),
    exists: !!doc,
    async save() {
      if (!this.exists) {
        await store.create(name);
        this.exists = true;
      }
      return store.save(name, this.doc, { kb: this.kb });
    },
    merged() {
      return userkb.applyOverlay(this.kb, this.doc, { sameThing }).kb;
    },
  };
}

/**
 * spot show をこちらで扱うか。--kb を書いたとき、u: の id のとき、
 * ユーザーKB に差分（足した・直した・消した）があるスポットのときです。収録は読まないので速く済みます。
 */
export async function showsUserKb(argv, env = process.env) {
  if (argv.some((a) => a.startsWith("--kb="))) return true;
  const key = argv.find((a) => !a.startsWith("--"));
  if (!key) return false;
  if (key.startsWith("u:")) return true;
  const { userkb } = await import("../../core/index.mjs");
  try {
    const store = userkb.openStore({ home: userkb.userKbHome(env) });
    const doc = await store.load(await kbNameFor({}, env, store, userkb));
    return Object.entries(doc.spots).some(([id, e]) => id === key || e.spot?.name === key || e.anchor?.name === key);
  } catch {
    return false;
  }
}

/** id か名前から、スポットを1つに決めます。 */
function resolveSpot(ctx, key) {
  if (!key) throw usage("スポットの id か名前を書いてください");
  const entry = ctx.doc.spots[key];
  if (entry || ctx.kb.spotsById.has(key)) return key;
  const merged = ctx.merged();
  const hits = merged.spots.filter((s) => s.name === key);
  for (const [id, e] of Object.entries(ctx.doc.spots)) {
    if (e.op === "remove" && (e.spot?.name === key || e.anchor?.name === key) && !hits.some((h) => h.id === id)) hits.push({ id, name: key });
  }
  if (hits.length === 1) return hits[0].id;
  if (!hits.length) throw usage(`見つかりません: ${key}（id で書くか、spot list --all --q=${key} で探してください）`);
  throw usage(`「${key}」は ${hits.length} 件あります。id で選んでください: ${hits.slice(0, 8).map((h) => `${h.id}${h.region ? `（${h.region}）` : ""}`).join("、")}`);
}

function describe(s, entry) {
  const where = [s.prefecture, s.region].filter(Boolean).join(" ");
  const mark = entry ? `［${STATUS[entry.op]}］` : "";
  return `${s.id}\t${s.name}${mark}\t${where}\t${s.lat},${s.lng}`;
}

async function ask(rl, label, { required = false, check } = {}) {
  for (;;) {
    const v = (await rl.question(`${label}${required ? "（必須）" : "（空なら飛ばす）"}: `)).trim();
    if (!v && !required) return undefined;
    if (!v) continue;
    const msg = check?.(v);
    if (!msg) return v;
    process.stderr.write(`  ${msg}\n`);
  }
}

async function interactiveSpot(stdin, stdout, userkb) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const num = (k) => (v) => userkb.validateSpot({ [k]: v }, { partial: true }).errors[0];
    const input = {};
    input.name = await ask(rl, "名前", { required: true });
    input.lat = await ask(rl, "緯度（例 35.6256）", { required: true, check: num("lat") });
    input.lng = await ask(rl, "経度（例 139.2472）", { required: true, check: num("lng") });
    input.category = await ask(rl, "分類（寺院・展望台・滝 など）");
    const g = await ask(rl, "ジャンル（nature;view のように。nature history view food art city sea onsen）",
      { check: (v) => userkb.validateSpot({ genres: v.split(/[;,\s]+/).filter(Boolean) }, { partial: true }).errors[0] });
    if (g) input.genres = g.split(/[;,\s]+/).filter(Boolean);
    input.description = await ask(rl, "説明");
    input.dwell = await ask(rl, "滞在の目安（分）", { check: num("dwell") });
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    return input;
  } finally {
    rl.close();
  }
}

async function confirm(stdin, stdout, question) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return /^(y|yes|はい)$/i.test((await rl.question(`${question} [y/N]: `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * @param {string} verb
 * @param {string[]} argv
 * @param {{stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, stdin?: NodeJS.ReadableStream, env?: object}} [io]
 * @returns {Promise<number>} 終了コード
 */
export async function runSpot(verb, argv, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env } = {}) {
  const say = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const note = (s) => stderr.write(`${s}\n`);
  try {
    if (!VERBS.includes(verb)) throw usage(`spot に「${verb}」はありません（tabisaki spot help）`);
    const { opts, words } = parseSpotArgs(verb, argv);
    if (opts.help) { say(HELP); return 0; }
    const json = opts.output === "json";
    if (opts.output && !json) throw usage("--output は json だけです");
    const ctx = await openKb(opts, env);
    const { userkb } = ctx;
    const tty = !!(stdin.isTTY && stdout.isTTY);

    if (verb === "add") {
      let input = parseAssignments(words);
      if (!words.length) {
        if (!tty) throw usage("項目を書いてください。例: tabisaki spot add name=秘密の滝 lat=35.1 lng=139.2");
        input = await interactiveSpot(stdin, stdout, userkb);
      }
      const { value, errors } = userkb.validateSpot(input);
      if (errors.length) throw usage(errors.join("\n"));
      const spotio = await import("../../core/spotio.mjs");
      const near = spotio.nearIndex(ctx.merged().spots).find(value, { radius: 100, sameThing: ctx.sameThing });
      if (near.length && !opts.force) {
        throw usage(`近くに同じ名前のスポットがあります: ${near.map((n) => `${n.spot.id} ${n.spot.name}（${n.meters}m）`).join("、")}\n`
          + "直すなら spot edit、それでも足すなら --force を付けてください");
      }
      const id = userkb.addSpot(ctx.doc, value);
      const r = await ctx.save();
      if (json) say(JSON.stringify({ ok: true, id, kb: ctx.name, backup: r.backup }));
      else say(`足しました: ${id} ${value.name}（ユーザーKB「${ctx.name}」）`);
      return 0;
    }

    if (verb === "edit") {
      const [key, ...rest] = words;
      const id = resolveSpot(ctx, key);
      const set = parseAssignments(rest);
      const unset = opts.unset ? opts.unset.split(",").map((s) => s.trim()).filter(Boolean) : [];
      if (!Object.keys(set).length && !unset.length) throw usage("直す項目を書いてください。例: tabisaki spot edit takao-1 fee=500 --unset=tel");
      if (ctx.doc.spots[id]?.op === "remove") throw usage(`${id} は消した印が付いています。先に spot restore ${id}`);
      const entry = userkb.patchSpot(ctx.doc, ctx.kb.spotsById.get(id), id, { set, unset });
      await ctx.save();
      if (json) say(JSON.stringify({ ok: true, id, entry }));
      else say(`直しました: ${id}（${[...Object.keys(set), ...unset.map((u) => `-${u}`)].join("・")}）`);
      return 0;
    }

    if (verb === "rm") {
      const id = resolveSpot(ctx, words[0]);
      const official = ctx.kb.spotsById.get(id);
      const name = official?.name ?? ctx.doc.spots[id]?.spot?.name ?? id;
      if (ctx.doc.spots[id]?.op === "remove") { say(`もう消してあります: ${id} ${name}`); return 0; }
      if (!opts.yes) {
        if (!tty) throw usage(`消すときは --yes を付けてください（端末なら確かめます）: ${id} ${name}`);
        if (!(await confirm(stdin, stdout, `「${name}」（${id}）を消しますか。spot restore で戻せます`))) { note("やめました"); return 1; }
      }
      userkb.removeSpot(ctx.doc, official, id, { reason: opts.reason ?? "" });
      const r = await ctx.save();
      say(`消しました: ${id} ${name}（戻すとき: tabisaki spot restore ${id}${r.backup ? `。控え: ${r.backup}` : ""}）`);
      return 0;
    }

    if (verb === "restore") {
      const id = resolveSpot(ctx, words[0]);
      if (!ctx.doc.spots[id]) throw usage(`${id} には差分がありません（収録のままです）`);
      const back = userkb.undoEntry(ctx.doc, id);
      await ctx.save();
      say(back ? `戻しました: ${id}（${STATUS[back.op]}状態に）` : `取り消しました: ${id}（収録のままに）`);
      return 0;
    }

    if (verb === "show") {
      const id = resolveSpot(ctx, words[0]);
      const entry = ctx.doc.spots[id] ?? null;
      const merged = ctx.merged();
      const spot = merged.spotsById.get(id) ?? null;
      const official = ctx.kb.spotsById.get(id) ?? null;
      if (json) { say(JSON.stringify({ id, status: entry?.op ?? "official", spot, official, entry }, null, 2)); return 0; }
      const s = spot ?? official ?? { ...(entry?.spot ?? {}), id };
      const lines = [`${s.name}（${id}）${entry ? ` ［${STATUS[entry.op]}］` : ""}`];
      for (const k of ["category", "genres", "prefecture", "region", "lat", "lng", "description", "address", "url", "dwell", "open", "close", "fee"]) {
        if (s[k] === undefined || s[k] === "" || (Array.isArray(s[k]) && !s[k].length)) continue;
        const was = entry?.op === "patch" && k in (entry.was ?? {}) ? `（収録: ${entry.was[k] ?? "なし"}）` : "";
        lines.push(`  ${k}: ${Array.isArray(s[k]) ? s[k].join(", ") : s[k]}${was}`);
      }
      if (entry?.op === "remove") lines.push(`  消した理由: ${entry.reason || "（なし）"}　${entry.at}`);
      if (entry?.op === "patch" && entry.unset?.length) lines.push(`  外した項目: ${entry.unset.join(", ")}`);
      say(lines.join("\n"));
      return 0;
    }

    if (verb === "list") {
      const limit = opts.limit === undefined ? 50 : Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw usage("--limit は 1〜10000 の整数です");
      const q = opts.q?.trim();
      const merged = ctx.merged();
      let rows;
      if (opts.all) {
        if (!q) throw usage("--all のときは --q=<語> で絞ってください（収録は5万件あります）");
        rows = merged.spots.filter((s) => s.name.includes(q) || s.region?.includes(q) || s.prefecture?.includes(q))
          .map((s) => ({ spot: s, entry: ctx.doc.spots[s.id] ?? null }));
      } else {
        rows = Object.entries(ctx.doc.spots).map(([id, entry]) => ({
          spot: merged.spotsById.get(id) ?? { id, ...(entry.spot ?? {}), name: entry.spot?.name ?? entry.anchor?.name ?? id, lat: entry.anchor?.lat ?? entry.spot?.lat, lng: entry.anchor?.lng ?? entry.spot?.lng },
          entry,
        }));
        if (q) rows = rows.filter((r) => r.spot.name?.includes(q));
      }
      const total = rows.length;
      rows = rows.slice(0, limit);
      if (json) {
        say(JSON.stringify({ kb: ctx.name, total, spots: rows.map((r) => ({ ...r.spot, status: r.entry?.op ?? "official" })) }, null, 2));
        return 0;
      }
      if (!rows.length) { say(opts.all ? "見つかりません" : `ユーザーKB「${ctx.name}」には、まだ何もありません（tabisaki spot add で足せます）`); return 0; }
      for (const r of rows) say(describe(r.spot, r.entry));
      if (total > rows.length) note(`ほか ${total - rows.length} 件（--limit で増やせます）`);
      return 0;
    }

    if (verb === "import") {
      const file = words[0];
      if (!file || words.length > 1) throw usage("取り込むファイルを1つ書いてください。例: tabisaki spot import spots.csv");
      const spotio = await import("../../core/spotio.mjs");
      let bytes;
      try { bytes = await readFile(file); } catch (e) { throw usage(`読めません: ${file}（${e.code ?? e.message}）`); }
      if (bytes.length > 20 * 1024 * 1024) throw usage("ファイルが大きすぎます（20MB まで）");
      let text, encoding;
      try { ({ text, encoding } = spotio.decodeText(bytes, opts.encoding)); } catch (e) { throw usage(e.message); }
      if (opts.format && !spotio.FORMATS.includes(opts.format)) throw usage(`--format は ${spotio.FORMATS.join(" / ")} のどれかです`);
      const parsed = spotio.parseSpots(text, { format: opts.format, fileName: path.basename(file) });
      if (parsed.errors.length) throw usage(parsed.errors.join("\n"));
      // 重なり: 収録・ユーザーKB・同じファイルの中
      const idx = spotio.nearIndex(ctx.merged().spots);
      const dups = [];
      const fresh = [];
      const inFile = spotio.nearIndex();
      for (const r of parsed.ok) {
        const hit = idx.find(r.spot, { radius: 100, sameThing: ctx.sameThing })[0]
          ?? inFile.find(r.spot, { radius: 100, sameThing: ctx.sameThing })[0];
        if (hit && !opts["allow-dup"]) dups.push({ line: r.line, name: r.spot.name, with: hit.spot.id, meters: hit.meters });
        else { fresh.push(r); inFile.add({ ...r.spot, id: `${r.line}行目` }); }
      }
      const failed = parsed.bad.length > 0;
      let added = [];
      if (!opts["dry-run"] && !(opts.strict && (failed || dups.length))) {
        added = fresh.map((r) => ({ line: r.line, id: userkb.addSpot(ctx.doc, r.spot) }));
        if (added.length) await ctx.save();
      }
      const result = {
        file, format: parsed.format, encoding, kb: ctx.name, dryRun: !!opts["dry-run"],
        added: added.length, wouldAdd: fresh.length, duplicates: dups, failed: parsed.bad, ignoredColumns: parsed.ignored,
      };
      if (json) say(JSON.stringify(result, null, 2));
      else {
        const verbWord = opts["dry-run"] ? "足せる行" : "足した行";
        say(`${file}（${parsed.format}・${encoding}）: ${verbWord} ${opts["dry-run"] ? fresh.length : added.length}・重なり ${dups.length}・まちがい ${parsed.bad.length}`);
        for (const b of parsed.bad.slice(0, 20)) note(`  ${b.line}行目${b.name ? ` ${b.name}` : ""}: ${b.errors.join(" / ")}`);
        if (parsed.bad.length > 20) note(`  ほか ${parsed.bad.length - 20} 行`);
        for (const d of dups.slice(0, 20)) note(`  ${d.line}行目 ${d.name}: ${d.with} と重なっています（${d.meters}m）。足すなら --allow-dup`);
        if (parsed.ignored?.length) note(`  使わなかった列: ${parsed.ignored.join(", ")}`);
        if (opts.strict && (failed || dups.length)) note("--strict なので、1行も足していません");
      }
      return failed || (opts.strict && dups.length) ? 1 : 0;
    }

    if (verb === "export") {
      const spotio = await import("../../core/spotio.mjs");
      const format = opts.format ?? (opts.out ? spotio.detectFormat(opts.out) : "csv");
      if (!spotio.FORMATS.includes(format)) throw usage(`--format は ${spotio.FORMATS.join(" / ")} のどれかです`);
      const merged = ctx.merged();
      const pick = (s) => {
        const o = { id: s.id };
        for (const k of ["name", "lat", "lng", ...Object.keys(userkb.SPOT_FIELDS)]) if (s[k] !== undefined && s[k] !== "") o[k] = s[k];
        return o;
      };
      const spots = [];
      for (const [id, e] of Object.entries(ctx.doc.spots)) {
        if (e.op === "add" || (opts["with-edited"] && e.op === "patch")) {
          const s = merged.spotsById.get(id);
          if (s) spots.push(pick(s));
        }
      }
      const text = spotio.formatSpots(spots, format);
      if (opts.out) {
        await writeFile(opts.out, text, { flag: "wx", mode: 0o600 }).catch((e) => {
          if (e.code === "EEXIST") throw usage(`もうあります: ${opts.out}（上書きしません）`);
          throw e;
        });
        note(`書き出しました: ${opts.out}（${spots.length}件・${format}）`);
      } else stdout.write(text);
      return 0;
    }

    if (verb === "dedup") {
      const radius = opts.radius === undefined ? 100 : Number(opts.radius);
      if (!Number.isFinite(radius) || radius <= 0 || radius > 5000) throw usage("--radius は 1〜5000（m）です");
      const spotio = await import("../../core/spotio.mjs");
      const merged = ctx.merged();
      const idx = spotio.nearIndex(merged.spots);
      const pairs = [];
      const seenPair = new Set();
      for (const [id, e] of Object.entries(ctx.doc.spots)) {
        if (e.op !== "add") continue;
        const s = merged.spotsById.get(id);
        if (!s) continue;
        for (const h of idx.find(s, { radius, sameThing: ctx.sameThing, except: s })) {
          const key = [id, h.spot.id].sort().join("|");
          if (seenPair.has(key)) continue;
          seenPair.add(key);
          pairs.push({ id, name: s.name, with: h.spot.id, withName: h.spot.name, official: !userkb.isUserSpotId(h.spot.id), meters: h.meters });
        }
      }
      if (json) { say(JSON.stringify({ kb: ctx.name, radius, pairs }, null, 2)); return 0; }
      if (!pairs.length) { say("重なっていそうなものはありません"); return 0; }
      for (const p of pairs) say(`${p.id} ${p.name} ⇔ ${p.with} ${p.withName}${p.official ? "（収録）" : ""}　${p.meters}m`);
      note("同じものなら、足した方を tabisaki spot rm <id> --yes で消してください");
      return 0;
    }
    return 2;
  } catch (e) {
    note(`tabisaki: ${e?.message ?? e}`);
    if (e?.exitCode) return e.exitCode;
    if (["invalid_input", "invalid_name", "not_found", "exists"].includes(e?.code)) return 2;
    return 1;
  }
}
