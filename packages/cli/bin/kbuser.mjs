// tabisaki kb ls / create / fork / switch / current / diff / merge / validate / stats / rm / backups / restore
//
// 自分のユーザーKB（~/.tabisaki/kbs/<名前>/。docs/user-kb.md）を、分ける・切り替える・比べる・
// まとめる・点検するコマンドです（Issue #358）。公式の kb/ には書きません。
// 終了コード: 0 = できた、1 = できなかった（解けていない競合がある・点検でまちがいが見つかった）、
//             2 = 使いかたのまちがい

import path from "node:path";
import { createInterface } from "node:readline/promises";

export const VERBS = ["ls", "create", "fork", "switch", "current", "diff", "merge", "validate", "stats", "rm", "backups", "restore"];

export const HELP = `使いかた: tabisaki kb <コマンド> … [--kb=<名前>]

  kb ls                          ユーザーKBの一覧（* が、いま使っているもの）
  kb create <名前> [--title=…]   空のユーザーKBを作る
  kb fork [<元>] <先> [--title=…] [--switch]
                                 ユーザーKBを分ける（元を書かなければ、いま使っているもの）
  kb switch <名前>               いま使うユーザーKBを切り替える（spot・kb・plan の既定になります）
  kb switch --official           切り替えをやめる（plan は公式の収録だけで組みます）
  kb current                     いま使っているユーザーKBの名前
  kb diff [<a>] [<b>]            a から b への違い。1つだけ書くと「いまの KB → それ」、
                                 何も書かないと「公式の収録 → いまの KB」
                                 a・b は 名前 / 名前@控え / ファイル（.json） / official
  kb merge <相手> [--ours|--theirs] [--pick=<競合>=ours|theirs,…] [--dry-run] [--base=<ファイル>]
                                 相手（名前かファイル）の変更を、いまの KB に取り込む
  kb merge --continue [--pick=…] [--ours|--theirs]   競合を解いて、途中の統合を続ける
  kb merge --abort               途中の統合をやめる（いまの KB は変わっていません）
  kb validate [<名前>] [--strict]  形・必須の項目・座標・公式の収録とのつながりを点検する
  kb stats [<名前>]              件数・都道府県の分布・更新の時刻など
  kb backups [<名前>]            控えの一覧（書くたびに自動で取っています）
  kb restore <控え>              控えの中身に戻す（戻す前の中身も控えます）
  kb rm <名前> --yes             ユーザーKBを消す（trash/ へ動かすだけ）

  --kb=<名前>    相手にするユーザーKB（既定: 環境変数 TABISAKI_KB、kb switch で決めたもの、無ければ mine）
  --output=json  ls・diff・merge・validate・stats の結果を JSON で

  地域の切り出しと索引は、これまでどおり tabisaki kb extract / kb index です（tabisaki help）。
`;

const FLAGS = {
  ls: ["output"],
  create: ["title"],
  fork: ["title", "switch", "kb"],
  switch: ["official"],
  current: [],
  diff: ["kb", "output"],
  merge: ["kb", "ours", "theirs", "pick", "dry-run", "base", "continue", "abort", "output"],
  validate: ["kb", "strict", "output"],
  stats: ["kb", "output"],
  rm: ["yes"],
  backups: ["kb"],
  restore: ["kb"],
};
const BOOL = new Set(["switch", "official", "ours", "theirs", "dry-run", "continue", "abort", "strict", "yes", "help"]);

function usage(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}
function fail(message) {
  const e = new Error(message);
  e.exitCode = 1;
  return e;
}

export function parseKbArgs(verb, argv) {
  const opts = {};
  const words = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(a);
    if (!m) { words.push(a); continue; }
    const [, key, value] = m;
    if (key === "help") { opts.help = true; continue; }
    if (!FLAGS[verb].includes(key)) throw usage(`kb ${verb} に --${key} はありません（tabisaki kb help）`);
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

/** --pick=takao-1#fee=theirs,takao-2=ours を { 競合: どちら } にします。 */
export function parsePicks(text) {
  const out = {};
  for (const part of String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.lastIndexOf("=");
    const key = i > 0 ? part.slice(0, i) : "";
    const side = part.slice(i + 1);
    if (!key || (side !== "ours" && side !== "theirs")) throw usage(`--pick は「<競合>=ours」か「<競合>=theirs」を , で並べます: ${part}`);
    out[key] = side;
  }
  return out;
}

const isFileRef = (ref) => /[\\/]/.test(ref) || /\.json$/i.test(ref);
/** 時刻を日本時間の「2026-11-11 20:10」にします。 */
const day = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? "?" : new Date(t + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
};

/** 公式の収録を、本体のログを黙らせて読みます。 */
async function loadOfficial(core) {
  const saved = [console.log, console.warn, console.info];
  console.log = console.warn = console.info = () => {};
  try {
    return (await core.createCore()).kb;
  } finally {
    [console.log, console.warn, console.info] = saved;
  }
}

/**
 * @param {string} verb
 * @param {string[]} argv
 * @param {{stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, stdin?: NodeJS.ReadableStream, env?: object}} [io]
 * @returns {Promise<number>} 終了コード
 */
export async function runKb(verb, argv, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env } = {}) {
  const say = (s) => stdout.write(s.endsWith("\n") ? s : `${s}\n`);
  const note = (s) => stderr.write(`${s}\n`);
  try {
    if (verb === "help" || verb === "--help") { say(HELP); return 0; }
    if (!VERBS.includes(verb)) throw usage(`kb に「${verb}」はありません（tabisaki kb help）`);
    const { opts, words } = parseKbArgs(verb, argv);
    if (opts.help) { say(HELP); return 0; }
    const json = opts.output === "json";
    if (opts.output && !json) throw usage("--output は json だけです");

    const core = await import("../../core/index.mjs");
    const { userkb, kbmerge } = core;
    const store = userkb.openStore({ home: userkb.userKbHome(env) });
    const current = async () => userkb.validateKbName(opts.kb ?? (env.TABISAKI_KB?.trim() || null) ?? (await store.current()) ?? "mine");
    const tty = !!(stdin.isTTY && stdout.isTTY);
    const mustLoad = async (name) => {
      try {
        return await store.load(name);
      } catch (e) {
        if (e.code === "not_found") throw usage(`ユーザーKB「${name}」はありません（tabisaki kb ls で一覧、tabisaki kb create ${name} で作れます）`);
        throw e;
      }
    };
    /** 名前 / 名前@控え / ファイル / official を、ユーザーKBの中身にします。 */
    const resolveRef = async (ref) => {
      if (ref === "official") return { label: "公式の収録", doc: userkb.emptyOverlay("official"), kind: "official" };
      const at = /^[a-z0-9][a-z0-9_-]{0,39}@[^\\/]+$/.test(ref) ? ref.indexOf("@") : -1;
      if (at < 0 && isFileRef(ref)) return { label: ref, doc: await userkb.readOverlayFile(ref), kind: "file" };
      if (at > 0) {
        const name = userkb.validateKbName(ref.slice(0, at));
        const backup = ref.slice(at + 1);
        const all = await store.backups(name);
        if (!all.includes(backup)) throw usage(`「${name}」に控え ${backup} はありません（tabisaki kb backups ${name}）`);
        return { label: ref, doc: await userkb.readOverlayFile(path.join(path.dirname(store.path(name)), "backups", backup)), kind: "backup" };
      }
      const name = userkb.validateKbName(ref);
      return { label: name, doc: await mustLoad(name), kind: "kb", name };
    };

    if (verb === "ls") {
      const cur = await store.current();
      const names = await store.list();
      const rows = [];
      for (const n of names) {
        try {
          const doc = await store.load(n);
          const c = { add: 0, patch: 0, remove: 0 };
          for (const e of Object.values(doc.spots)) if (e?.op in c) c[e.op]++;
          rows.push({ name: n, current: n === cur, title: doc.title ?? "", counts: c, updated: doc.updated ?? null, parent: doc.parent?.name ?? null });
        } catch (e) {
          rows.push({ name: n, current: n === cur, error: e.message });
        }
      }
      if (json) { say(JSON.stringify({ current: cur, kbs: rows }, null, 2)); return 0; }
      if (!rows.length) { say("ユーザーKBはまだありません（tabisaki spot add か tabisaki kb create <名前> で作れます）"); return 0; }
      for (const r of rows) {
        if (r.error) { say(`${r.current ? "*" : " "} ${r.name}\t（読めません: ${r.error}）`); continue; }
        say(`${r.current ? "*" : " "} ${r.name}\t${r.title || "（題なし）"}\t足した ${r.counts.add}・直した ${r.counts.patch}・消した ${r.counts.remove}\t更新 ${day(r.updated)}${r.parent ? `\t${r.parent} から分けた` : ""}`);
      }
      if (!cur) note("（* が無いときは、--kb を書かなければ mine を使います。plan は公式の収録だけで組みます）");
      return 0;
    }

    if (verb === "create") {
      if (words.length !== 1) throw usage("作るユーザーKBの名前を1つ書いてください。例: tabisaki kb create family");
      if (words[0] === "official") throw usage("official は公式の収録を指す名前なので、使えません");
      const doc = await store.create(userkb.validateKbName(words[0]), { title: opts.title ?? "" });
      say(`作りました: ${doc.name}（使うとき: tabisaki kb switch ${doc.name}）`);
      return 0;
    }

    if (verb === "fork") {
      if (words.length < 1 || words.length > 2) throw usage("使いかた: tabisaki kb fork [<元>] <先>");
      const src = words.length === 2 ? userkb.validateKbName(words[0]) : await current();
      const dst = userkb.validateKbName(words[words.length - 1]);
      if (src === dst) throw usage("元と先が同じ名前です");
      if (dst === "official") throw usage("official は公式の収録を指す名前なので、使えません");
      await mustLoad(src);
      const doc = await store.fork(src, dst, { title: opts.title });
      if (opts.switch) await store.switchTo(dst);
      say(`分けました: ${src} → ${dst}（差分 ${Object.keys(doc.spots).length} 件を写しました${opts.switch ? "。いま使うのは " + dst : ""}）`);
      if (!opts.switch) note(`使うとき: tabisaki kb switch ${dst}　戻すとき（まとめる）: tabisaki kb merge ${dst} --kb=${src}`);
      return 0;
    }

    if (verb === "switch") {
      if (opts.official) {
        if (words.length) throw usage("--official のときは、名前を書きません");
        await store.switchTo(null);
        say("切り替えをやめました（spot・kb は mine、plan は公式の収録だけを使います）");
        return 0;
      }
      if (words.length !== 1) throw usage("切り替える先の名前を1つ書いてください。例: tabisaki kb switch family");
      const name = userkb.validateKbName(words[0]);
      await mustLoad(name);
      await store.switchTo(name);
      say(`切り替えました: ${name}（spot・kb・plan がこれを使います。やめるとき: tabisaki kb switch --official）`);
      return 0;
    }

    if (verb === "current") {
      const cur = await store.current();
      if (env.TABISAKI_KB?.trim()) note(`（環境変数 TABISAKI_KB=${env.TABISAKI_KB.trim()} が先に使われます）`);
      say(cur ?? "（決めていません。spot・kb は mine を使い、plan は公式の収録だけで組みます）");
      return 0;
    }

    if (verb === "diff") {
      if (words.length > 2) throw usage("使いかた: tabisaki kb diff [<a>] [<b>]");
      let a, b;
      if (words.length === 0) { a = await resolveRef("official"); b = await resolveRef(await current()); }
      else if (words.length === 1) { a = await resolveRef(await current()); b = await resolveRef(words[0]); }
      else { a = await resolveRef(words[0]); b = await resolveRef(words[1]); }
      const changes = kbmerge.diffOverlays(a.doc, b.doc);
      if (json) { say(JSON.stringify({ from: a.label, to: b.label, changes }, null, 2)); return 0; }
      if (!changes.length) { say(`違いはありません（${a.label} と ${b.label}）`); return 0; }
      say(`${a.label} → ${b.label}: ${changes.length} 件`);
      say(kbmerge.formatDiff(changes, { from: a.label, to: b.label }));
      return 0;
    }

    if (verb === "merge") {
      const into = await current();
      const state = await store.mergeState(into).catch(() => null);
      if (opts.abort) {
        if (opts.continue) throw usage("--abort と --continue は、どちらかだけにしてください");
        if (!state) { say(`「${into}」に、途中の統合はありません`); return 0; }
        await store.setMergeState(into, null);
        say(`やめました（「${into}」は、統合を始める前のままです）`);
        return 0;
      }
      if (opts.ours && opts.theirs) throw usage("--ours と --theirs は、どちらかだけにしてください");
      const ours = await mustLoad(into);
      let theirs, base, from;
      let picks = {};
      if (opts.continue) {
        if (words.length) throw usage("--continue のときは、相手を書きません（始めたときの相手で続けます）");
        if (!state) throw usage(`「${into}」に、途中の統合はありません`);
        if (state.schema !== kbmerge.MERGE_SCHEMA || !state.theirs?.spots) throw fail("途中の統合の控え（MERGE.json）が読めません。tabisaki kb merge --abort でやめて、やり直してください");
        ({ theirs, base = null, from } = state);
        if (state.applying && kbmerge.overlayFingerprint(ours) === state.applying) {
          // 書き込みは済んでいて、後片付けの前に止まっていた。
          if (from.kind === "kb") await store.setBase(into, from.name, theirs);
          await store.setMergeState(into, null);
          say(`統合は書き込み済みでした（${from.label} → ${into}）。後片付けをしました`);
          return 0;
        }
        if (kbmerge.overlayFingerprint(ours) !== state.ours) {
          throw fail(`統合を始めてから「${into}」が変わっています。tabisaki kb merge --abort でやめて、やり直してください`);
        }
        picks = { ...(state.picks ?? {}) };
      } else {
        if (state) throw fail(`「${into}」には、途中の統合があります（相手: ${state.from?.label ?? "?"}）。続けるなら --continue、やめるなら --abort`);
        if (words.length !== 1) throw usage("取り込む相手を1つ書いてください。例: tabisaki kb merge family");
        const ref = await resolveRef(words[0]);
        if (ref.kind === "official") throw usage("公式の収録は取り込めません（もとから重なっています）");
        if (ref.kind === "kb" && ref.name === into) throw usage("自分自身は取り込めません");
        theirs = ref.doc;
        from = { kind: ref.kind, label: ref.label, ...(ref.kind === "kb" ? { name: ref.name } : {}) };
        if (opts.base) base = (await resolveRef(opts.base)).doc;
        else base = ref.kind === "kb" ? (await store.commonBase(into, ref.name))?.overlay ?? null : null;
      }
      Object.assign(picks, parsePicks(opts.pick));

      const merged = kbmerge.mergeOverlays(base, ours, theirs);
      const keys = new Set(merged.conflicts.map((c) => c.key));
      for (const k of Object.keys(picks)) if (!keys.has(k)) throw usage(`そういう競合はありません: ${k}（あるのは ${[...keys].join("、") || "なし"}）`);
      const all = opts.ours ? "ours" : opts.theirs ? "theirs" : null;
      if (all) for (const c of merged.conflicts) picks[c.key] ??= all;

      const journal = () => ({
        schema: kbmerge.MERGE_SCHEMA, into, from, startedAt: state?.startedAt ?? new Date().toISOString(),
        ours: kbmerge.overlayFingerprint(ours), theirs, base, picks,
      });
      // 端末なら、残った競合を1つずつ聞きます。答えるたびに控えるので、途中でやめても続きからできます。
      if (tty && !opts["dry-run"] && !json && merged.conflicts.some((c) => !picks[c.key])) {
        const rl = createInterface({ input: stdin, output: stdout });
        try {
          for (const c of merged.conflicts) {
            if (picks[c.key]) continue;
            say(kbmerge.formatConflict(c, { ours: into, theirs: from.label, hasBase: merged.hasBase }));
            let a = "";
            while (!/^[ots]$/.test(a)) a = (await rl.question("  どちらを取りますか [o=自分 / t=相手 / s=あとで]: ")).trim().toLowerCase();
            if (a === "s") break;
            picks[c.key] = a === "o" ? "ours" : "theirs";
            await store.setMergeState(into, journal());
          }
        } finally {
          rl.close();
        }
      }

      const { spots, unresolved } = kbmerge.resolveMerge(merged, theirs, picks);
      const picked = { ours: 0, theirs: 0 };
      for (const c of merged.conflicts) if (picks[c.key]) picked[picks[c.key]]++;
      const result = {
        into, from: from.label, base: base ? "あり" : "なし", dryRun: !!opts["dry-run"], written: false,
        counts: { ...merged.counts, pickedOurs: picked.ours, pickedTheirs: picked.theirs, unresolved: unresolved.length },
        taken: merged.taken, unresolved, picks,
      };
      const summary = `足す ${merged.counts.added}・置き換える ${merged.counts.replaced}・項目を取り込む ${merged.counts.fields}・差分を消す ${merged.counts.dropped}`
        + `・競合 ${merged.conflicts.length}（自分 ${picked.ours}・相手 ${picked.theirs}・まだ ${unresolved.length}）`;
      const listConflicts = () => {
        for (const c of unresolved) note(kbmerge.formatConflict(c, { ours: into, theirs: from.label, hasBase: merged.hasBase }));
      };

      if (opts["dry-run"]) {
        if (json) say(JSON.stringify(result, null, 2));
        else {
          say(`${from.label} → ${into}（試し。書き込みません）: ${summary}`);
          for (const t of merged.taken.slice(0, 40)) say(`  ${t.how === "add" ? "+" : t.how === "drop" ? "-" : "~"} ${t.id} ${t.name}${t.fields ? `（${t.fields.join("・")}）` : ""}`);
          if (merged.taken.length > 40) say(`  ほか ${merged.taken.length - 40} 件`);
          listConflicts();
        }
        return unresolved.length ? 1 : 0;
      }
      if (unresolved.length) {
        await store.setMergeState(into, journal());
        if (json) say(JSON.stringify(result, null, 2));
        else {
          note(`${from.label} → ${into}: ${summary}`);
          note("競合が残っているので、まだ書き込んでいません:");
          listConflicts();
          note(`続けるとき: tabisaki kb merge --continue --pick=${unresolved[0].key}=theirs（または =ours。全部なら --ours / --theirs）`);
          note("やめるとき: tabisaki kb merge --abort");
        }
        return 1;
      }

      const nothing = !merged.taken.length && !picked.theirs;
      let backup = null;
      if (!nothing) {
        const doc = { ...ours, spots: kbmerge.normalizeAdded(spots), updated: new Date().toISOString() };
        kbmerge.checkMerged(doc);
        // 書き込む前に「これを書く」と控えます。書いた直後に止まっても、--continue で後片付けできます。
        await store.setMergeState(into, { ...journal(), applying: kbmerge.overlayFingerprint(doc) });
        ({ backup } = await store.save(into, doc, { log: { cmd: "kb merge", note: `${from.label} を取り込んだ` } }));
        result.written = true;
        result.backup = backup;
      }
      if (from.kind === "kb") await store.setBase(into, from.name, theirs);
      await store.setMergeState(into, null);

      let dups = [];
      if (merged.counts.added) {
        const kb = await loadOfficial(core);
        const { sameThing } = await import("../../core/src/dedupe.js");
        const view = userkb.applyOverlay(kb, { ...ours, spots }, { sameThing }).kb.spots;
        dups = kbmerge.mergeDuplicates(merged.taken, spots, view, { sameThing });
        result.duplicates = dups;
      }
      if (json) { say(JSON.stringify(result, null, 2)); return 0; }
      if (nothing) { say(`取り込むものはありません（${from.label} → ${into}）`); return 0; }
      say(`取り込みました（${from.label} → ${into}）: ${summary.replace("足す", "足した").replace("置き換える", "置き換えた").replace("項目を取り込む", "項目を取り込んだ").replace("差分を消す", "差分を消した")}`);
      for (const d of dups.slice(0, 20)) note(`  重なっていそうです: ${d.id} ${d.name} ⇔ ${d.with} ${d.withName}（${d.meters}m）。同じものなら tabisaki spot rm ${d.id} --yes`);
      if (backup) note(`戻すとき: tabisaki kb restore ${backup} --kb=${into}`);
      return 0;
    }

    if (verb === "validate" || verb === "stats") {
      if (words.length > 1) throw usage(`使いかた: tabisaki kb ${verb} [<名前>]`);
      const name = words[0] ? userkb.validateKbName(words[0]) : await current();
      let doc;
      try {
        doc = await store.load(name);
      } catch (e) {
        if (e.code === "not_found") throw usage(`ユーザーKB「${name}」はありません（tabisaki kb ls で一覧）`);
        if (verb === "stats") throw e;
        // 読めないこと自体が、点検の結果です。
        const r = { name, ok: false, errors: [{ id: "", code: e.code ?? "broken_file", message: e.message }], warnings: [], checked: 0 };
        if (json) say(JSON.stringify(r, null, 2)); else note(`✗ ${e.message}`);
        return 1;
      }
      const kb = await loadOfficial(core);
      const { sameThing } = await import("../../core/src/dedupe.js");
      const { kb: view, report } = userkb.applyOverlay(kb, doc, { sameThing });
      const info = await store.info(name);
      if (verb === "stats") {
        const s = { ...kbmerge.kbStats(doc, view, kb), bytes: info.bytes, backups: info.backups, merging: info.merging };
        if (json) { say(JSON.stringify(s, null, 2)); return 0; }
        say(`${s.name}${s.title ? `（${s.title}）` : ""}: 差分 ${s.total} 件（足した ${s.counts.add}・直した ${s.counts.patch}・消した ${s.counts.remove}）`);
        say(`  作った日 ${day(s.created)}・最後に書いた日 ${day(s.updated)}${s.parent ? `・${s.parent.name} から分けた（${day(s.parent.forkedAt)}）` : ""}`);
        say(`  ファイル ${s.bytes.toLocaleString("en-US")} バイト・控え ${s.backups} 個${s.merging ? "・途中の統合あり" : ""}`);
        say(`  公式の収録の版: 書いたとき ${s.base.stamp || "（控えなし）"}・今 ${s.base.current}${s.base.changed ? "（変わっています。tabisaki kb validate で確かめられます）" : ""}`);
        const row = (label, list) => { if (list.length) say(`  ${label}: ${list.map((x) => `${x.name} ${x.count}`).join("・")}`); };
        row("都道府県", s.prefectures);
        row("エリア（上位10）", s.regions);
        row("足したスポットのジャンル", s.genres);
        row("足したスポットの分類", s.categories);
        row("直した項目", s.editedFields);
        return 0;
      }
      const v = kbmerge.validateKb(doc, kb, { report, names: await store.list(), sameThing, bytes: info.bytes });
      if (info.merging) v.warnings.push({ id: "", code: "merging", message: "途中の統合があります（tabisaki kb merge --continue か --abort）" });
      const bad = !v.ok || (opts.strict && v.warnings.length > 0);
      if (json) { say(JSON.stringify({ name, ...v, ok: !bad }, null, 2)); return bad ? 1 : 0; }
      for (const e of v.errors) say(`✗ ${e.id || name}: ${e.message}`);
      for (const w of v.warnings) say(`△ ${w.id || name}: ${w.message}`);
      say(`${name}: 差分 ${v.checked} 件を点検しました。まちがい ${v.errors.length}・気をつけること ${v.warnings.length}${bad ? "" : "（使えます）"}`);
      return bad ? 1 : 0;
    }

    if (verb === "backups") {
      if (words.length > 1) throw usage("使いかた: tabisaki kb backups [<名前>]");
      const name = words[0] ? userkb.validateKbName(words[0]) : await current();
      await mustLoad(name);
      const all = await store.backups(name);
      if (!all.length) { say(`「${name}」に控えはまだありません`); return 0; }
      for (const b of all) say(b);
      note(`戻すとき: tabisaki kb restore <控え> --kb=${name}　比べるとき: tabisaki kb diff ${name}@<控え> ${name}`);
      return 0;
    }

    if (verb === "restore") {
      if (words.length !== 1) throw usage("戻す控えを1つ書いてください（tabisaki kb backups で一覧）");
      const name = await current();
      await mustLoad(name);
      const r = await store.restore(name, words[0]);
      say(`戻しました: ${name} ← ${r.restored}${r.backup ? `（戻す前の中身は ${r.backup} に控えました）` : ""}`);
      return 0;
    }

    if (verb === "rm") {
      if (words.length !== 1) throw usage("消すユーザーKBの名前を1つ書いてください");
      const name = userkb.validateKbName(words[0]);
      if (!opts.yes) throw usage(`消すときは --yes を付けてください: ${name}（フォルダは trash/ へ動かすだけで、消しません）`);
      // 中身がこわれていて読めないユーザーKBも、片付けられるようにします（読まずに動かします）。
      const to = await store.drop(name);
      say(`消しました: ${name}（${to} に動かしました）`);
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
