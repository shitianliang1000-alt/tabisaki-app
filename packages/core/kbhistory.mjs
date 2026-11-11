// ユーザーKBの履歴・取り消し・項目ごとの出どころ・スナップショット・一括編集・git への写し（Issue #360）。
//
// 設計は docs/user-kb.md の「履歴・取り消し・スナップショット」にあります。決めたことは3つです。
//
//   1. git は要りません。履歴は、ユーザーKBのフォルダの history.jsonl に、書くたびに1行ずつ
//      足します（1つのコマンド = 1行）。undo・history・blame は、これだけを読みます。
//      git が入っていない端末（Windows など）でも、同じように動かすためです。
//   2. git が入っていて、利用者が `kb git init` をしたユーザーKBは、書くたびに git にも
//      コミットします（写し）。git log・git diff・自分のリモートへの push に使えます。
//   3. 取り消しは、履歴を書き換えません。「取り消した」という新しい1行を足します
//      （git revert と同じ考え）。だから、取り消しの取り消し（redo）もできます。
//
// ここは計算と、git を呼ぶところだけです。ファイルの読み書きは userkb.mjs の openStore がします。

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { canonical, entryName, sameEntry } from "./kbmerge.mjs";

export const HISTORY_VERSION = 1;
export const SNAPSHOT_SCHEMA = "tabisaki.user-kb-snapshot/1";
export const SNAPSHOT_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;

// --- 履歴の1行 --------------------------------------------------------------------

/**
 * before から after へ、差分がどう変わったか（id ごと）。
 * @returns {{id: string, before: object|null, after: object|null}[]}
 */
export function entryChanges(before = {}, after = {}) {
  const out = [];
  for (const id of [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort()) {
    const b = before?.[id] ?? null;
    const a = after?.[id] ?? null;
    if (!sameEntry(b, a)) out.push({ id, before: b, after: a });
  }
  return out;
}

/** history.jsonl の中身を読みます。こわれた行（書いている途中で止まった最後の行など）は飛ばします。 */
export function parseHistory(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line, (k, v) => (k === "__proto__" || k === "constructor" || k === "prototype" ? undefined : v));
      if (r && Number.isInteger(r.seq) && Array.isArray(r.changes)) out.push(r);
    } catch {
      // 読めない行は無かったものとして扱います
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** 取り消されている行の番号。取り消しを取り消したら（redo）、元の行は生き返ります。 */
export function revertedSeqs(records) {
  const bySeq = new Map(records.map((r) => [r.seq, r]));
  const dead = new Set();
  for (const r of records) {
    if (!r.reverts) continue;
    dead.add(r.reverts);
    const target = bySeq.get(r.reverts);
    if (target?.reverts) dead.delete(target.reverts);
  }
  return dead;
}

const fieldsOf = (e) => {
  const m = new Map();
  if (e?.op === "add") for (const [k, v] of Object.entries(e.spot ?? {})) m.set(k, v);
  if (e?.op === "patch") {
    for (const [k, v] of Object.entries(e.set ?? {})) m.set(k, v);
    for (const k of e.unset ?? []) m.set(k, null);
  }
  return m;
};
const OP_WORD = { add: "足した", patch: "直した", remove: "消した" };
const val = (v) => (v === undefined ? "（そのまま）" : v === null ? "（なし）" : Array.isArray(v) ? v.join(";") : String(v));

/** 1つの変更を、短い言葉にします（「fee: 500 → 800」「足した」など）。 */
export function describeChange(c) {
  const { before: b, after: a } = c;
  if (!b && a) return a.op === "patch" ? `直した（${[...fieldsOf(a)].map(([k, v]) => `${k}=${val(v)}`).join("・")}）` : OP_WORD[a.op] ?? a.op;
  if (b && !a) return `${OP_WORD[b.op] ?? b.op}のを取り消した`;
  if (b.op !== a.op) return a.op === "remove" ? "消した" : `${OP_WORD[b.op]} → ${OP_WORD[a.op]}`;
  const fb = fieldsOf(b);
  const fa = fieldsOf(a);
  const parts = [];
  for (const k of [...new Set([...fb.keys(), ...fa.keys()])].sort()) {
    if (canonical(fb.get(k)) === canonical(fa.get(k)) && fb.has(k) === fa.has(k)) continue;
    parts.push(`${k}: ${val(fb.has(k) ? fb.get(k) : undefined)} → ${val(fa.has(k) ? fa.get(k) : undefined)}`);
  }
  return parts.join("・") || "中身は同じ";
}

/** 日本時間の「2026-11-11 20:10」。 */
export const jst = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? "?" : new Date(t + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
};

/**
 * 履歴を、新しい順の行にします。
 * @param {object[]} records
 * @param {{id?: string, limit?: number}} [opts] id を渡すと、そのスポットに触れた行だけ
 */
export function formatHistory(records, { id = null, limit = 20 } = {}) {
  const dead = revertedSeqs(records);
  const rows = records.filter((r) => !id || r.changes.some((c) => c.id === id)).reverse().slice(0, limit);
  const lines = [];
  for (const r of rows) {
    const mark = dead.has(r.seq) ? "（取り消し済み）" : "";
    lines.push(`#${r.seq}  ${jst(r.at)}  ${r.cmd}${r.note ? `  ${r.note}` : ""}${mark}`);
    const changes = id ? r.changes.filter((c) => c.id === id) : r.changes;
    for (const c of changes.slice(0, id ? 50 : 5)) lines.push(`      ${c.id} ${entryName(c.id, c.after, c.before)}: ${describeChange(c)}`);
    if (changes.length > (id ? 50 : 5)) lines.push(`      ほか ${changes.length - 5} 件`);
  }
  return lines.join("\n");
}

// --- 取り消し ----------------------------------------------------------------------

/**
 * 取り消す行を選び、いまの中身に当てはめられるかを調べます。
 *
 * @param {object[]} records 履歴（古い順）
 * @param {object} spots いまの差分（doc.spots）
 * @param {{seq?: number, id?: string, redo?: boolean}} [opts]
 *   seq = その番号の行を取り消す。id = そのスポットに触れた、いちばん新しい行の、そのスポットの分だけ。
 *   redo = いちばん新しい「取り消し」を取り消す。どれも無ければ、いちばん新しい行。
 * @returns {{target: object|null, apply: {id: string, to: object|null}[], already: string[],
 *            conflicts: {id: string, name: string, later: number[]}[], partial: boolean}}
 *   conflicts = その行のあとで、同じスポットが別に変わっているもの（そのまま戻すと、あとの変更が消えます）
 */
export function planUndo(records, spots, { seq = null, id = null, redo = false } = {}) {
  const dead = revertedSeqs(records);
  const live = (r) => !dead.has(r.seq);
  const bySeq = new Map(records.map((r) => [r.seq, r]));
  const depth = (r, guard = 0) => (r?.reverts && guard < 64 ? 1 + depth(bySeq.get(r.reverts), guard + 1) : 0);
  let target = null;
  if (seq !== null) target = records.find((r) => r.seq === seq) ?? null;
  else {
    for (let i = records.length - 1; i >= 0 && !target; i--) {
      const r = records[i];
      if (!live(r)) continue;
      // undo が狙うのは、ふつうの変更だけ。redo が狙うのは、取り消し（undo）の行だけです。
      // やり直し（redo）の行は、取り消しの取り消しなので、どちらからも狙いません
      // （やり直した変更は、もとの行が生き返っているので、undo はそちらを取り消します）。
      if (redo ? depth(r) % 2 !== 1 : !!r.reverts) continue;
      if (id && !r.changes.some((c) => c.id === id)) continue;
      target = r;
    }
  }
  const empty = { target, apply: [], already: [], conflicts: [], partial: false };
  if (!target) return empty;
  const changes = id ? target.changes.filter((c) => c.id === id) : target.changes;
  const out = { ...empty, partial: changes.length !== target.changes.length };
  for (const c of changes) {
    const cur = spots?.[c.id] ?? null;
    if (sameEntry(cur, c.before)) { out.already.push(c.id); continue; }
    if (!sameEntry(cur, c.after)) {
      const later = records.filter((r) => r.seq > target.seq && r.changes.some((x) => x.id === c.id)).map((r) => r.seq);
      out.conflicts.push({ id: c.id, name: entryName(c.id, cur, c.after, c.before), later });
    }
    out.apply.push({ id: c.id, to: c.before });
  }
  return out;
}

/** planUndo の結果を、差分に当てはめます（doc を書き換えます）。 */
export function applyUndo(doc, plan, { now = new Date(), skip = [] } = {}) {
  const at = now.toISOString();
  const skipped = new Set(skip);
  let n = 0;
  for (const a of plan.apply) {
    if (skipped.has(a.id)) continue;
    if (a.to) doc.spots[a.id] = { ...a.to, at };
    else delete doc.spots[a.id];
    n++;
  }
  if (n) doc.updated = at;
  return n;
}

// --- 項目ごとの出どころ（blame） -----------------------------------------------------

/**
 * スポット1つについて、いまの値を最後に書いた行を、項目ごとに返します。
 *
 * 方式: 履歴を古い順にたどり、その行で値が変わった項目に、その行の番号を付け替えていきます。
 * 差分が取り消されて収録のままに戻ったら、付けた番号をすべて外します。
 *
 * @returns {{fields: Record<string, {seq: number, at: string, cmd: string, note: string}>,
 *            removed: object|null, created: object|null, touched: number}}
 */
export function blameSpot(records, id) {
  let fields = new Map();
  let removed = null;
  let created = null;
  let touched = 0;
  // その行の前の「出どころ」の控え。取り消しは、取り消した行の前の状態に戻すので、出どころも戻します
  // （取り消しややり直しの行ではなく、その値をもともと書いた行を指すように）。
  const stateBefore = new Map();
  for (const r of records) {
    for (const c of r.changes) {
      if (c.id !== id) continue;
      touched++;
      stateBefore.set(r.seq, { fields: new Map(fields), removed, created });
      const undone = stateBefore.get(r.undoes ?? r.reverts);
      if (undone) { ({ removed, created } = undone); fields = new Map(undone.fields); continue; }
      const who = { seq: r.seq, at: r.at, cmd: r.cmd, note: r.note ?? "" };
      if (!c.after) { fields.clear(); removed = null; created = null; continue; }
      if (c.after.op === "remove") { removed = who; continue; }
      removed = null;
      if (!c.before || (c.before.op !== c.after.op && c.before.op !== "remove")) created = who;
      const before = c.before?.op === "remove"
        ? fieldsOf(c.before.spot ? { op: "add", spot: c.before.spot } : c.before.patch ? { op: "patch", ...c.before.patch } : null)
        : fieldsOf(c.before);
      const after = fieldsOf(c.after);
      for (const k of new Set([...before.keys(), ...after.keys()])) {
        if (!after.has(k)) { fields.delete(k); continue; }
        if (!before.has(k) || canonical(before.get(k)) !== canonical(after.get(k))) fields.set(k, who);
      }
    }
  }
  return { fields: Object.fromEntries(fields), removed, created, touched };
}

// --- スナップショット -----------------------------------------------------------------

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
/** スナップショットの指紋。中身（題と差分）だけから決まります。 */
export const snapshotHash = (overlay) => sha256(canonical({ title: overlay?.title ?? "", parent: overlay?.parent ?? null, spots: overlay?.spots ?? {} }));

export function makeSnapshot(doc, label, { note = "", now = new Date(), seq = null } = {}) {
  return {
    schema: SNAPSHOT_SCHEMA, label, note: String(note).slice(0, 200), at: now.toISOString(), seq,
    entries: Object.keys(doc.spots ?? {}).length, sha256: snapshotHash(doc), overlay: doc,
  };
}

/** スナップショットが、取ったときのままか。変わっていたら理由を返します（null = 変わっていない）。 */
export function snapshotProblem(snap) {
  if (snap?.schema !== SNAPSHOT_SCHEMA) return `形の版が違います: ${snap?.schema}`;
  if (!snap.overlay?.spots || typeof snap.overlay.spots !== "object") return "中身（overlay）がありません";
  if (snapshotHash(snap.overlay) !== snap.sha256) return "中身が、取ったときから変わっています（指紋が合いません）";
  return null;
}

// --- 一括編集（spot batch） ------------------------------------------------------------

export const BATCH_LIMITS = Object.freeze({ timeoutMs: 5000, maxOps: 500, hardMaxOps: 20000, scriptBytes: 256 * 1024, logs: 200, memoryMb: 256 });

// スクリプトに渡す道具。中の世界（vm の文脈）で定義して、外の世界のものは1つも渡しません。
const BATCH_PRELUDE = `"use strict";
const __ops = [];
const __logs = [];
const __freeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(__freeze); Object.freeze(o); } return o; };
const spots = __freeze(JSON.parse(__input));
const __cap = __max;
const __push = (op) => { if (__ops.length >= __cap) throw new Error("変更が多すぎます（" + __cap + " 件まで。増やすなら --max）"); __ops.push(op); };
const edit = (id, set, unset) => __push({ do: "edit", id: String(id), set: set && typeof set === "object" ? { ...set } : {}, unset: Array.isArray(unset) ? unset.map(String) : [] });
const remove = (id, reason) => __push({ do: "remove", id: String(id), reason: reason === undefined ? "" : String(reason) });
const restore = (id) => __push({ do: "restore", id: String(id) });
const add = (spot) => __push({ do: "add", spot: spot && typeof spot === "object" ? { ...spot } : {} });
const log = (...a) => { if (__logs.length < ${BATCH_LIMITS.logs}) __logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
const console = Object.freeze({ log });
`;

// 別スレッドの中身（CommonJS）。ここから親へ返すのは、文字と数だけです。
const BATCH_WORKER = String.raw`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { prelude, code, input, maxOps, timeoutMs, filename } = workerData;
const text = (e) => { try { return String((e && e.message) || e); } catch { return "（読めないエラー）"; } };
const lineOf = (e) => {
  try {
    const hit = String((e && e.stack) || "").split("\n").find((l) => l.includes(filename));
    const m = /:(\d+)(?::\d+)?\)?$/.exec(hit || "");
    return m ? Number(m[1]) : null;
  } catch { return null; }
};
const fail = (e, extra) => parentPort.postMessage({ ok: false, message: text(e), line: lineOf(e), ...extra });
let rejected = null;
process.on("unhandledRejection", (e) => { if (!rejected) rejected = { e }; });
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
context.__input = input;
context.__max = maxOps;
try {
  vm.runInContext(prelude, context, { filename: "tabisaki-batch-prelude.js", timeout: timeoutMs });
  vm.runInContext(code, context, { filename, timeout: timeoutMs });
  // 受け取り手のいない Promise の失敗は、次の回りで知らされます。それを待ってから結果を返します。
  setImmediate(() => {
    try {
      if (rejected) return fail(rejected.e, { rejected: true });
      const out = vm.runInContext("JSON.stringify({ ops: __ops, logs: __logs })", context, { timeout: 1000 });
      parentPort.postMessage({ ok: true, out: typeof out === "string" ? out : null });
    } catch (e) { fail(e); }
  });
} catch (e) {
  fail(e, { timeout: !!e && e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" });
}
`;

// import という語（文字や注釈の中でも）。import() は、vm の中からでも Node.js が外の世界で
// 断りのエラーを作って返します。そのエラーの constructor をたどると、外の世界の Function に
// 手が届いてしまう（囲いを抜けられる）ので、動かす前に、語そのものを断ります。
// 文法を読まずに語だけで見るのは、空白や注釈をはさんだ書き方を取りこぼさないためです
// （JavaScript の予約語は、\u0069mport のような書き換えができません）。
const IMPORT_RE = /(?<![\w$])import(?![\w$])/;

// worker に付ける Node.js の旗。権限モデルを付けると、その worker からはファイル・子プロセス・
// 別の worker・ネイティブの部品が使えなくなります（万一 vm を抜けられたときの、もう1枚）。
// 古い Node.js には無い旗なので、順に試して、どれも無ければ付けずに動かします。
const PERMISSION_FLAGS = [["--permission"], ["--experimental-permission"], []];
let permissionFlags = null;

const startWorker = (source, options) => {
  for (const flags of permissionFlags ? [permissionFlags] : PERMISSION_FLAGS) {
    try {
      const worker = new Worker(source, { ...options, execArgv: flags });
      permissionFlags = flags;
      return worker;
    } catch (e) {
      if (e?.code !== "ERR_WORKER_INVALID_EXEC_ARGV" || !flags.length) throw e;
    }
  }
  throw new Error("worker を始められません");
};

/** 一括編集の囲いの様子（権限モデルの旗が使えたか）。試験と `--json` の表示に使います。 */
export async function batchSandbox() {
  if (!permissionFlags) {
    const w = startWorker("", { eval: true, stdout: true, stderr: true });
    await new Promise((resolve) => { w.once("exit", resolve); w.once("error", resolve); });
  }
  return { permission: permissionFlags[0] ?? null, flags: [...permissionFlags] };
}

const batchError = (message) => Object.assign(new Error(message), { code: "batch_failed" });

/**
 * 一括編集のスクリプトを動かし、「こう変えたい」の一覧を受け取ります。ここでは何も書き換えません。
 *
 * 囲いは2重です。
 *   - 別スレッド（worker）: メモリの上限と、時間切れでの打ち切り。使いすぎても、止まるのは
 *     そのスレッドだけです。環境変数は渡しません。Node.js の権限モデルが使えれば付けて、
 *     その worker からファイル・子プロセスを使えなくします。
 *   - その中の node:vm の別の文脈: require・process・fetch・ファイル・タイマーは渡さず、
 *     eval・new Function・import も止めます。渡すのはスポットの写し（文字にして渡し、
 *     中で組み立て直す）と、変更を頼む関数だけです。返ってくるのも文字だけです。
 *
 * ただし vm は安全のための壁ではありません（Node.js の文書にもそうあります）。
 * うっかり手元を壊さないための囲いであって、悪意のあるスクリプトを防ぎきるものではありません。
 * だから、何を書くかは、スクリプトではなく呼んだ側（applyBatchOps）が決めます。
 *
 * @param {string} code スクリプトの中身
 * @param {object[]} spots スクリプトに見せるスポット（写しを渡します）
 * @param {{timeoutMs?: number, maxOps?: number, filename?: string, memoryMb?: number}} [opts]
 * @returns {Promise<{ops: object[], logs: string[]}>}
 */
export async function runBatchScript(code, spots, { timeoutMs = BATCH_LIMITS.timeoutMs, maxOps = BATCH_LIMITS.maxOps, filename = "batch.js", memoryMb = BATCH_LIMITS.memoryMb } = {}) {
  if (typeof code !== "string") throw batchError("スクリプトが読めません");
  if (Buffer.byteLength(code) > BATCH_LIMITS.scriptBytes) throw batchError(`スクリプトが大きすぎます（${BATCH_LIMITS.scriptBytes} バイトまで）`);
  if (IMPORT_RE.test(code)) throw batchError("スクリプトが止まりました: import は使えません。文字や注釈の中でも、import という語は書けません（スクリプトにできるのは、渡されたスポットを見て、変更を頼むことだけです）");
  const tooLong = `時間がかかりすぎました（${timeoutMs}ms まで。増やすなら --timeout）`;
  const msg = await new Promise((resolve) => {
    let worker;
    let timer = null;
    let done = false;
    const finish = (m) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker?.terminate().catch(() => {});
      resolve(m);
    };
    try {
      worker = startWorker(BATCH_WORKER, {
        eval: true,
        workerData: { prelude: BATCH_PRELUDE, code, input: JSON.stringify(spots), maxOps, timeoutMs, filename },
        env: {},
        argv: [],
        stdin: false,
        stdout: true,
        stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      });
    } catch (e) {
      return finish({ ok: false, message: String(e?.message ?? e) });
    }
    // vm の時間切れが先に効きます。こちらは、それでも止まらなかったときの打ち切りです。
    timer = setTimeout(() => finish({ ok: false, timeout: true }), timeoutMs * 2 + 3000);
    worker.once("message", finish);
    worker.once("error", (e) => finish({ ok: false, message: e?.code === "ERR_WORKER_OUT_OF_MEMORY" ? `メモリを使いすぎました（${memoryMb}MB まで）` : String(e?.message ?? e) }));
    worker.once("exit", (c) => finish({ ok: false, message: `途中で終わりました（終了コード ${c}）` }));
  });
  if (!msg?.ok) {
    const what = msg?.timeout ? tooLong : msg?.rejected ? `Promise が失敗したままです: ${msg.message}` : String(msg?.message ?? "分からないエラー");
    throw batchError(`スクリプトが止まりました${msg?.line ? `（${filename} の ${msg.line} 行目）` : ""}: ${what}`);
  }
  if (typeof msg.out !== "string") throw batchError("スクリプトの結果が読めません");
  let parsed;
  try {
    parsed = JSON.parse(msg.out, (k, v) => (k === "__proto__" || k === "constructor" || k === "prototype" ? undefined : v));
  } catch {
    throw batchError("スクリプトの結果が読めません");
  }
  const ops = Array.isArray(parsed?.ops) ? parsed.ops.filter((o) => o && typeof o === "object" && !Array.isArray(o)) : [];
  if (ops.length > maxOps) throw batchError(`変更が多すぎます（${maxOps} 件まで。増やすなら --max）`);
  return { ops, logs: Array.isArray(parsed?.logs) ? parsed.logs.map(String).slice(0, BATCH_LIMITS.logs) : [] };
}

/**
 * スクリプトが頼んだ変更を、差分の写しに当てはめます。spot edit などと同じ関数を通すので、
 * 決まりに合わない値はここで断られます。1つでも断られたら、呼んだ側は何も書きません。
 *
 * @param {object} doc 差分（書き換えます。写しを渡してください）
 * @param {object[]} ops runBatchScript の ops
 * @param {{userkb: object, official: Map<string, object>}} deps
 * @returns {{applied: number, errors: {index: number, op: string, id: string, message: string}[]}}
 */
export function applyBatchOps(doc, ops, { userkb, official }) {
  const errors = [];
  let applied = 0;
  ops.forEach((op, index) => {
    try {
      if (op.do === "add") userkb.addSpot(doc, op.spot);
      else if (op.do === "edit") {
        if (doc.spots[op.id]?.op === "remove") throw new Error("消した印が付いています。先に restore(id) してください");
        userkb.patchSpot(doc, official.get(op.id), op.id, { set: op.set ?? {}, unset: op.unset ?? [] });
      } else if (op.do === "remove") {
        if (doc.spots[op.id]?.op !== "remove") userkb.removeSpot(doc, official.get(op.id), op.id, { reason: op.reason ?? "" });
      } else if (op.do === "restore") {
        if (!doc.spots[op.id]) throw new Error("差分がありません（収録のままです）");
        userkb.undoEntry(doc, op.id);
      } else throw new Error(`知らない操作です: ${op.do}`);
      applied++;
    } catch (e) {
      errors.push({ index, op: String(op?.do), id: String(op?.id ?? op?.spot?.name ?? ""), message: String(e?.message ?? e) });
    }
  });
  return { applied, errors };
}

// --- git への写し ---------------------------------------------------------------------

const run = (args, { cwd, timeout = 15000 } = {}) => new Promise((resolve) => {
  execFile("git", args, { cwd, timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
    (error, stdout, stderr) => resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
});

/** git が使えるか（版の文字。使えなければ null）。 */
export async function gitVersion() {
  const r = await run(["--version"]);
  return r.ok ? r.stdout.trim().replace(/^git version\s*/, "") : null;
}

// フック・外の道具を動かす設定を、こちらが呼ぶときは止めます。
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "core.pager=cat", "-c", "gc.auto=0"];

// .git/config に書いてあってよいもの。これ以外（filter・include・alias・credential など、
// 外の道具を動かせる設定）があったら、こちらからは git を呼びません。
// よそから写してきたフォルダの .git に、仕掛けが入っていることがあるためです。
const CONFIG_ALLOWED = {
  core: new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "precomposeunicode", "symlinks", "autocrlf"]),
  user: new Set(["name", "email"]),
  remote: new Set(["url", "fetch"]),
  branch: new Set(["remote", "merge"]),
  init: new Set(["defaultbranch"]),
};

/** .git/config を読み、知らない設定があればその名前を返します（null = だいじょうぶ）。 */
export function unsafeGitConfig(text) {
  let section = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (head) {
      section = head[1].toLowerCase();
      if (!CONFIG_ALLOWED[section]) return `[${section}]`;
      continue;
    }
    const key = /^([A-Za-z][A-Za-z0-9-]*)\s*(=|$)/.exec(line)?.[1]?.toLowerCase();
    if (!section || !key) return line.slice(0, 40);
    if (!CONFIG_ALLOWED[section].has(key)) return `${section}.${key}`;
  }
  return null;
}

const GITIGNORE = "# 旅さきが書きました。控え・鍵・途中のファイルは git に入れません。\nbackups/\n.lock\n*.tmp\nMERGE.json\n";

/** このフォルダが、旅さきの写し先の git リポジトリか。 */
export async function gitState(dir) {
  const st = await fsp.lstat(path.join(dir, ".git")).catch(() => null);
  if (!st) return { repo: false };
  if (!st.isDirectory() || st.isSymbolicLink()) return { repo: true, usable: false, why: ".git がふつうのフォルダではありません" };
  const cfg = await fsp.readFile(path.join(dir, ".git", "config"), "utf8").catch(() => "");
  const bad = unsafeGitConfig(cfg);
  if (bad) return { repo: true, usable: false, why: `.git/config に、旅さきが知らない設定があります（${bad}）。安全のため、自動のコミットを止めています` };
  return { repo: true, usable: true };
}

/** ユーザーKBのフォルダを git リポジトリにして、いまの中身を最初のコミットにします。 */
export async function gitInit(dir, { name = "" } = {}) {
  if (!(await gitVersion())) return { ok: false, why: "git が見つかりません（入れてから、もう一度）" };
  const state = await gitState(dir);
  if (state.repo && !state.usable) return { ok: false, why: state.why };
  if (!state.repo) {
    const r = await run([...SAFE, "init", "-q"], { cwd: dir });
    if (!r.ok) return { ok: false, why: r.stderr.trim() || "git init に失敗しました" };
  }
  const ignore = path.join(dir, ".gitignore");
  if (!(await fsp.lstat(ignore).catch(() => null))) await fsp.writeFile(ignore, GITIGNORE, { mode: 0o600 });
  const c = await gitCommit(dir, `tabisaki: ユーザーKB「${name}」の履歴を git に写しはじめる`);
  return { ok: c.ok || c.skipped === "clean", created: !state.repo, why: c.why };
}

/**
 * いまの中身をコミットします。失敗しても投げません（ユーザーKBへの書き込みは、もう済んでいます）。
 * @returns {Promise<{ok: boolean, skipped?: string, why?: string, commit?: string}>}
 */
export async function gitCommit(dir, message) {
  const state = await gitState(dir);
  if (!state.repo) return { ok: false, skipped: "no_repo" };
  if (!state.usable) return { ok: false, skipped: "unsafe", why: state.why };
  let r = await run([...SAFE, "add", "-A", "--", "."], { cwd: dir });
  if (!r.ok) return { ok: false, why: r.stderr.trim().split("\n")[0] || "git add に失敗しました" };
  r = await run([...SAFE, "diff", "--cached", "--quiet"], { cwd: dir });
  if (r.ok) return { ok: false, skipped: "clean" };
  // 名前とメールを決めていない端末でも止まらないよう、無ければこちらの名前で書きます。
  const who = await run([...SAFE, "config", "user.email"], { cwd: dir });
  const ident = who.ok && who.stdout.trim() ? [] : ["-c", "user.name=tabisaki", "-c", "user.email=tabisaki@localhost"];
  r = await run([...SAFE, ...ident, "commit", "-q", "--no-verify", "-m", message], { cwd: dir });
  if (!r.ok) return { ok: false, why: r.stderr.trim().split("\n")[0] || "git commit に失敗しました" };
  const head = await run([...SAFE, "rev-parse", "--short", "HEAD"], { cwd: dir });
  return { ok: true, commit: head.stdout.trim() };
}

/** git のコミットの文。1行目は「コマンド: メモ」、あとに履歴の番号を書きます。 */
export function commitMessage({ cmd, note = "", seq = null, changes = 0 }) {
  const first = `${cmd}${note ? `: ${note}` : ""}`.replace(/\s+/g, " ").slice(0, 100);
  return `${first}\n\nTabisaki-Seq: ${seq ?? "-"}\nTabisaki-Changes: ${changes}\n`;
}

/** 最後のコミットと、まだコミットしていない変更があるか。 */
export async function gitSummary(dir) {
  const state = await gitState(dir);
  if (!state.repo || !state.usable) return state;
  const log = await run([...SAFE, "log", "-1", "--format=%h %cI %s"], { cwd: dir });
  const count = await run([...SAFE, "rev-list", "--count", "HEAD"], { cwd: dir });
  const dirty = await run([...SAFE, "status", "--porcelain"], { cwd: dir });
  return { ...state, last: log.ok ? log.stdout.trim() : null, commits: count.ok ? Number(count.stdout.trim()) : 0, dirty: dirty.stdout.trim().length > 0 };
}
