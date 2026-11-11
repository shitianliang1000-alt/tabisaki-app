// tabisaki spot add / edit / rm / restore / list / show / import / export / dedup
//
// 自分のユーザーKB（~/.tabisaki/kbs/<名前>/。docs/user-kb.md）のスポットを、端末から足す・直す・消す・
// 一覧・取り込み・書き出しします。公式の kb/ には書きません。
// 終了コード: 0 = できた、1 = できなかった（一部の行が取り込めなかった、を含む）、2 = 使いかたのまちがい

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

export const VERBS = ["add", "edit", "rm", "restore", "list", "show", "import", "export", "dedup", "undo", "redo", "history", "blame", "batch"];

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

  spot history [<スポット>] [--limit=20]   いつ・どのコマンドで・何を変えたか（新しい順）
  spot undo [<スポット>] [--seq=<番号>] [--dry-run] [--force]
                                   いちばん新しい変更を取り消す（スポットを書くと、その分だけ。
                                   --seq でその番号の変更を取り消す）
  spot redo                        いちばん新しい取り消しを、取り消す
  spot blame <スポット>            項目ごとに、いまの値を最後に書いた変更
  spot batch <スクリプト.js> [--apply] [--all] [--q=語] [--max=500] [--timeout=5000]
                                   JavaScript でまとめて直す（--apply が無ければ試すだけ）

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
  undo: ["kb", "seq", "force", "dry-run", "output"],
  redo: ["kb", "force", "dry-run", "output"],
  history: ["kb", "limit", "output"],
  blame: ["kb", "output"],
  batch: ["kb", "apply", "all", "q", "max", "timeout", "output"],
};
const BOOL = new Set(["all", "yes", "dry-run", "strict", "allow-dup", "with-edited", "force", "apply", "help"]);

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
    async save(log) {
      if (!this.exists) {
        await store.create(name);
        this.exists = true;
      }
      return store.save(name, this.doc, { kb: this.kb, log });
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
    /** 書きます。履歴に残す言葉（cmd・note）を渡します。git への写しができなかったら、ひとこと出します。 */
    const save = async (cmd, noteText = "", extra = {}) => {
      const r = await ctx.save({ cmd, note: noteText, ...extra });
      if (r.git && !r.git.ok && r.git.why) note(`（git への写しはしていません: ${r.git.why}）`);
      return r;
    };

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
      const r = await save("spot add", value.name);
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
      await save("spot edit", `${id}（${[...Object.keys(set), ...unset.map((u) => `-${u}`)].join("・")}）`);
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
      const r = await save("spot rm", `${id} ${name}`);
      say(`消しました: ${id} ${name}（戻すとき: tabisaki spot restore ${id}${r.backup ? `。控え: ${r.backup}` : ""}）`);
      return 0;
    }

    if (verb === "restore") {
      const id = resolveSpot(ctx, words[0]);
      if (!ctx.doc.spots[id]) throw usage(`${id} には差分がありません（収録のままです）`);
      const back = userkb.undoEntry(ctx.doc, id);
      await save("spot restore", id);
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
        if (added.length) await save("spot import", `${path.basename(file)}（${added.length} 件）`);
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
    // --- 履歴・取り消し・出どころ・一括編集（#360） ---------------------------------------
    const { kbhistory, kbmerge } = ctx.core;
    if (!ctx.exists && verb !== "batch") { say(`ユーザーKB「${ctx.name}」は、まだありません（履歴もありません）`); return verb === "history" ? 0 : 1; }
    if (ctx.exists) {
      // 旅さきの外で書き換えられていた分を、先に履歴へ取り込みます。
      await ctx.store.syncHistory(ctx.name);
    }
    const records = ctx.exists ? await ctx.store.history(ctx.name) : [];
    /** スポットを id に決めます。いまは差分が無くても、履歴に出てくる id・名前なら選べます。 */
    const resolveInHistory = (key) => {
      try {
        return resolveSpot(ctx, key);
      } catch (e) {
        const ids = new Set();
        for (const r of records) {
          for (const c of r.changes) if (c.id === key || kbmerge.entryName(c.id, c.after, c.before) === key) ids.add(c.id);
        }
        if (ids.size === 1) return [...ids][0];
        throw e;
      }
    };

    if (verb === "history") {
      const limit = opts.limit === undefined ? 20 : Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw usage("--limit は 1〜10000 の整数です");
      const id = words[0] ? resolveInHistory(words[0]) : null;
      if (json) {
        const dead = kbhistory.revertedSeqs(records);
        const rows = records.filter((r) => !id || r.changes.some((c) => c.id === id)).reverse().slice(0, limit);
        say(JSON.stringify({ kb: ctx.name, total: records.length, records: rows.map((r) => ({ ...r, reverted: dead.has(r.seq) })) }, null, 2));
        return 0;
      }
      const text = kbhistory.formatHistory(records, { id, limit });
      say(text || (id ? `${id} を変えた履歴はありません` : "履歴はまだありません"));
      return 0;
    }

    if (verb === "undo" || verb === "redo") {
      const redo = verb === "redo";
      if (redo && words.length) throw usage("spot redo は、何も書かずに使います（いちばん新しい取り消しを、取り消します）");
      const id = words[0] ? resolveInHistory(words[0]) : null;
      let seq = null;
      if (opts.seq !== undefined) {
        seq = Number(String(opts.seq).replace(/^#/, ""));
        if (!Number.isInteger(seq) || seq < 1) throw usage("--seq は、spot history に出る番号（#12 なら 12）です");
      }
      const plan = kbhistory.planUndo(records, ctx.doc.spots, { seq, id, redo });
      const t = plan.target;
      if (!t) {
        const why = seq !== null ? `#${seq} の変更は履歴にありません` : redo ? "取り消した変更がありません" : id ? `${id} を変えた履歴がありません` : "取り消せる変更がありません";
        if (json) say(JSON.stringify({ ok: false, reason: why })); else note(why);
        return 1;
      }
      const head = `#${t.seq} ${t.cmd}${t.note ? `（${t.note}）` : ""}`;
      if (plan.conflicts.length && !opts.force) {
        if (json) { say(JSON.stringify({ ok: false, target: t.seq, conflicts: plan.conflicts }, null, 2)); return 1; }
        note(`${head}を取り消せません。そのあとで、同じスポットが変わっています:`);
        for (const c of plan.conflicts) note(`  ${c.id} ${c.name}${c.later.length ? `（${c.later.map((n) => `#${n}`).join("・")} で変更）` : ""}`);
        note(`あとの変更を先に取り消す（tabisaki spot undo --seq=${plan.conflicts[0].later.at(-1) ?? "<番号>"}）か、あとの変更ごと戻すなら --force を付けてください`);
        return 1;
      }
      if (!plan.apply.length) { say(`${head} は、もう取り消されています`); return 0; }
      if (opts["dry-run"]) {
        if (json) { say(JSON.stringify({ ok: true, dryRun: true, target: t.seq, apply: plan.apply.map((a) => a.id) }, null, 2)); return 0; }
        say(`${head} を取り消すと（試し。書き込みません）:`);
        for (const a of plan.apply) say(`  ${a.id} ${kbmerge.entryName(a.id, a.to, ctx.doc.spots[a.id])}: ${kbhistory.describeChange({ before: ctx.doc.spots[a.id] ?? null, after: a.to })}`);
        return 0;
      }
      const n = kbhistory.applyUndo(ctx.doc, plan);
      const whole = !plan.partial;
      const r = await save(redo ? "spot redo" : "spot undo", `#${t.seq} ${t.cmd} を取り消した${id ? `（${id} だけ）` : ""}`, whole ? { reverts: t.seq, undoes: t.seq } : { undoes: t.seq });
      if (json) say(JSON.stringify({ ok: true, target: t.seq, changed: n, seq: r.seq, backup: r.backup }));
      else say(`${redo ? "やり直しました" : "取り消しました"}: ${head}・${n} 件（これを取り消すとき: tabisaki spot ${redo || !whole ? "undo" : "redo"}）`);
      return 0;
    }

    if (verb === "blame") {
      const id = resolveInHistory(words[0]);
      const b = kbhistory.blameSpot(records, id);
      const entry = ctx.doc.spots[id] ?? null;
      const spot = ctx.merged().spotsById.get(id) ?? ctx.kb.spotsById.get(id) ?? (entry?.spot ? { ...entry.spot, id } : null);
      if (!spot) throw usage(`${id} は、いまのユーザーKBにも収録にもありません（履歴は tabisaki spot history ${id}）`);
      const who = (w) => (w ? `#${w.seq}  ${kbhistory.jst(w.at)}  ${w.cmd}${w.note ? `  ${w.note}` : ""}` : null);
      const rows = [];
      for (const k of Object.keys(userkb.SPOT_FIELDS)) {
        const unset = entry?.op === "patch" && entry.unset?.includes(k);
        if (spot[k] === undefined && !unset) continue;
        const own = entry?.op === "add" ? k in (entry.spot ?? {}) : entry?.op === "patch" && (k in (entry.set ?? {}) || unset);
        // 足したスポットで、利用者が書いていない項目（エリアなど）は、まとめるときに自動で付いた値です。
        const source = own ? (b.fields[k] ? "history" : "before_history") : entry?.op === "add" ? "derived" : "official";
        rows.push({ field: k, value: unset ? null : spot[k], by: own ? b.fields[k] ?? null : null, source });
      }
      if (json) { say(JSON.stringify({ id, name: spot.name, status: entry?.op ?? "official", removed: b.removed, fields: rows }, null, 2)); return 0; }
      say(`${spot.name}（${id}）${entry ? ` ［${STATUS[entry.op]}］` : ""}`);
      if (entry?.op === "remove") say(`  消した: ${who(b.removed) ?? "（履歴より前）"}`);
      for (const r of rows) {
        const v = r.value === null ? "（なし）" : Array.isArray(r.value) ? r.value.join(", ") : String(r.value);
        say(`  ${r.field}: ${v.length > 40 ? `${v.slice(0, 40)}…` : v}\t${r.source === "official" ? "収録" : r.source === "derived" ? "（自動で付いた値）" : who(r.by) ?? "（履歴を取りはじめる前）"}`);
      }
      return 0;
    }

    if (verb === "batch") {
      const file = words[0];
      if (!file || words.length > 1) throw usage("スクリプトのファイルを1つ書いてください。例: tabisaki spot batch fix.js（書き込むときは --apply）");
      const num = (key, def, min, max) => {
        if (opts[key] === undefined) return def;
        const v = Number(opts[key]);
        if (!Number.isInteger(v) || v < min || v > max) throw usage(`--${key} は ${min}〜${max} の整数です`);
        return v;
      };
      const maxOps = num("max", kbhistory.BATCH_LIMITS.maxOps, 1, kbhistory.BATCH_LIMITS.hardMaxOps);
      const timeoutMs = num("timeout", kbhistory.BATCH_LIMITS.timeoutMs, 100, 120000);
      let code;
      try { code = await readFile(file, "utf8"); } catch (e) { throw usage(`読めません: ${file}（${e.code ?? e.message}）`); }
      const merged = ctx.merged();
      const pick = (s, status) => {
        const o = { id: s.id, status };
        for (const k of [...Object.keys(userkb.SPOT_FIELDS), "region", "prefecture"]) if (s[k] !== undefined) o[k] = s[k];
        return o;
      };
      let list = [];
      if (opts.all) {
        list = merged.spots.map((s) => pick(s, ctx.doc.spots[s.id]?.op ?? "official"));
      } else {
        for (const [id, e] of Object.entries(ctx.doc.spots)) {
          const s = merged.spotsById.get(id);
          if (s) list.push(pick(s, e.op));
          else if (e.op === "remove") list.push(pick({ id, ...(e.spot ?? {}), name: e.spot?.name ?? e.anchor?.name, lat: e.spot?.lat ?? e.anchor?.lat, lng: e.spot?.lng ?? e.anchor?.lng }, "remove"));
        }
      }
      const q = opts.q?.trim();
      if (q) list = list.filter((s) => s.name?.includes(q) || s.region?.includes(q) || s.prefecture?.includes(q) || s.category?.includes(q));
      let ops, logs;
      try {
        ({ ops, logs } = await kbhistory.runBatchScript(code, list, { timeoutMs, maxOps, filename: path.basename(file) }));
      } catch (e) {
        if (e.code !== "batch_failed") throw e;
        note(`tabisaki: ${e.message}`);
        return 1;
      }
      const work = structuredClone(ctx.doc);
      const { errors } = kbhistory.applyBatchOps(work, ops, { userkb, official: ctx.kb.spotsById });
      const changes = kbmerge.diffOverlays(ctx.doc, work);
      const result = { kb: ctx.name, script: file, seen: list.length, ops: ops.length, changed: changes.length, errors, logs, applied: false };
      const written = !!opts.apply && !errors.length && changes.length > 0;
      if (written) {
        ctx.doc = work;
        const r = await save("spot batch", `${path.basename(file)}（${changes.length} 件）`);
        result.applied = true;
        result.backup = r.backup;
      }
      if (json) { say(JSON.stringify({ ...result, changes }, null, 2)); return errors.length ? 1 : 0; }
      for (const l of logs) say(`  ｜${l}`);
      say(`${file}: 見せたスポット ${list.length}・頼まれた変更 ${ops.length}・変わるスポット ${changes.length}・まちがい ${errors.length}`);
      if (changes.length) say(kbmerge.formatDiff(changes.slice(0, 50), { from: "いま", to: "スクリプト" }));
      if (changes.length > 50) say(`  ほか ${changes.length - 50} 件`);
      for (const e of errors.slice(0, 20)) note(`  ✗ ${e.index + 1}番目の ${e.op}（${e.id}）: ${e.message}`);
      if (errors.length) { note("まちがいがあるので、1つも書き込んでいません"); return 1; }
      if (written) say(`書き込みました（取り消すとき: tabisaki spot undo）`);
      else if (changes.length) say("試しです。書き込むには --apply を付けてください");
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
