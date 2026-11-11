// 最長片道切符の経路を求める入口（Issue #431）。
//
//     import { createLongestTicketSolver } from "tabisaki-core/longest-ticket.mjs";
//     const solve = await createLongestTicketSolver();
//     const r = await solve("oneway", { from: null });      // 全国でいちばん長い経路
//     const t = await solve("oneway", { from: "東京" });    // 東京駅から出る、いちばん長い経路
//
// 計算するのは、Rust で書いたソルバーです（solver/longest-ticket/。分枝限定法）。
// WebAssembly にしたもの（rail/longest_ticket.wasm）を読み込んで呼びます。
// ここでするのは、その前後の支度だけです。
//
//   1. 路線網（rail/jr-graph.json。駅と、となりの駅までの営業キロ）を読む
//   2. 分かれ道の駅だけの網に縮める（途中の駅は、1本の辺の中にたたむ）
//   3. ソルバーに渡し、返ってきた辺の並びを、駅の並びに戻す
//
// LLM には計算させません。経路は、ここが返したものをそのまま使います。

import { readFile } from "node:fs/promises";

const HERE = new URL("./rail/", import.meta.url);

/**
 * 駅名の比べかた（「駅」と、終わりのかっこの県名を外す）。
 * 頼みの文から来る名前なので、正規表現の繰り返しは使わず、長さも切ります。
 */
export function stationKey(name) {
  let s = String(name ?? "").slice(0, 100).normalize("NFKC").trim();
  if (s.endsWith(")")) {
    const open = s.lastIndexOf("(");
    if (open >= 0) s = s.slice(0, open).trim();
  }
  if (s.endsWith("駅")) s = s.slice(0, -1);
  return s.trim();
}

/** 路線網を読みます。 */
export async function loadGraph(url = new URL("jr-graph.json", HERE)) {
  return prepare(JSON.parse(await readFile(url, "utf8")));
}

/** 読んだ路線網に、駅ごとの辺の一覧を足します。 */
export function prepare(graph) {
  const at = graph.stations.map(() => []);
  graph.edges.forEach(([a, b], i) => { at[a].push(i); at[b].push(i); });
  return { ...graph, at };
}

/**
 * 駅名から、路線網の駅を探します。同じ名前の駅がいくつもあるときは、
 * 乗り入れる線がいちばん多い駅を採ります（「福島」なら福島県の福島駅）。
 */
export function findStation(graph, name) {
  const key = stationKey(name);
  if (!key) return -1;
  let best = -1;
  graph.stations.forEach((s, i) => {
    if (stationKey(s) !== key) return;
    if (best < 0 || graph.at[i].length > graph.at[best].length) best = i;
  });
  return best;
}

/**
 * 分かれ道の駅だけの網に縮めます。
 *
 * 途中の駅（線が2本だけの駅）は、経路の選びかたに関わりません。分かれ道から
 * 分かれ道までを1本の辺にまとめます。残すのは、行き止まりの駅・分かれ道の駅・
 * 通り抜けの決まりがある駅・出発駅です。
 *
 * @returns {{nodes: number[], segs: object[], forbid: number[][], nodeOf: Map<number, number>}}
 */
export function contract(graph, { from = -1 } = {}) {
  const keep = new Set();
  graph.at.forEach((es, i) => { if (es.length && es.length !== 2) keep.add(i); });
  for (const [x] of graph.forbid ?? []) keep.add(x);
  if (from >= 0) keep.add(from);
  const other = (e, x) => (graph.edges[e][0] === x ? graph.edges[e][1] : graph.edges[e][0]);

  const walk = () => {
    const seen = new Set();
    const segs = [];
    const from1 = (start, e0) => {
      const path = [start];
      const edges = [];
      const kms = [0];
      let x = start;
      let e = e0;
      for (;;) {
        seen.add(e);
        edges.push(e);
        x = other(e, x);
        path.push(x);
        kms.push(kms.at(-1) + graph.edges[e][2]);
        if (keep.has(x)) break;
        e = graph.at[x].find((y) => y !== e);
      }
      return { a: start, b: x, km: kms.at(-1), path, kms, edges };
    };
    for (const k of keep) for (const e of graph.at[k]) if (!seen.has(e)) segs.push(from1(k, e));
    return { segs, seen };
  };

  let { segs, seen } = walk();
  // 分かれ道が1つも無い輪（ぐるっと回るだけの線）は、どこか1駅を残します。
  graph.edges.forEach((ed, e) => {
    if (!seen.has(e) && !keep.has(ed[0])) { keep.add(ed[0]); ({ segs, seen } = walk()); }
  });
  // 同じ駅に戻ってくる辺は、まん中の駅で2つに割ります（ソルバーは両端が同じ辺を受けません）。
  for (let again = true; again;) {
    again = false;
    for (const s of segs) {
      if (s.a === s.b) { keep.add(s.path[Math.floor(s.path.length / 2)]); again = true; }
    }
    if (again) ({ segs } = walk());
  }

  const nodes = [...keep].filter((k) => graph.at[k].length).sort((x, y) => x - y);
  const nodeOf = new Map(nodes.map((s, i) => [s, i]));
  const segOf = new Map();
  segs.forEach((s, i) => {
    for (const e of s.edges) segOf.set(e, i);
    const lines = new Map();
    for (const e of s.edges) lines.set(graph.edges[e][3], (lines.get(graph.edges[e][3]) ?? 0) + graph.edges[e][2]);
    s.line = [...lines].sort((p, q) => q[1] - p[1])[0][0];
    // 分かれ道のとなりの駅から出る・となりの駅で終わるときの長さ。
    s.stubA = s.path.length > 2 ? s.km - s.kms[1] : 0;
    s.stubB = s.path.length > 2 ? s.kms.at(-2) : 0;
  });
  const forbid = (graph.forbid ?? []).map(([x, e1, e2]) => [nodeOf.get(x), segOf.get(e1), segOf.get(e2)])
    .filter(([, s1, s2]) => s1 !== undefined && s2 !== undefined && s1 !== s2);
  return { nodes, segs, forbid, nodeOf };
}

/** ソルバーに渡す文（solver/longest-ticket/src/lib.rs の parse が読む形）。 */
export function problemText(net, { start = -1, loop = true, limitMs = 5000, maxStates = 3000000 } = {}) {
  const out = [`n ${net.nodes.length}`];
  for (const s of net.segs) {
    out.push(`e ${net.nodeOf.get(s.a)} ${net.nodeOf.get(s.b)} ${s.km} ${s.stubA} ${s.stubB}`);
  }
  if (start >= 0) out.push(`start ${net.nodeOf.get(start)}`);
  out.push(`loop ${loop ? 1 : 0}`);
  for (const [x, a, b] of net.forbid) out.push(`forbid ${x} ${a} ${b}`);
  out.push(`limit ${Math.max(0, Math.round(limitMs))}`, `maxstates ${maxStates}`);
  return out.join("\n") + "\n";
}

/** WebAssembly のソルバーを読み込み、(文) → 結果 の関数にします。 */
export async function loadSolver(url = new URL("longest_ticket.wasm", HERE)) {
  const bytes = await readFile(url);
  const { instance } = await WebAssembly.instantiate(bytes, { env: { now_ms: () => performance.now() } });
  const { memory, lt_alloc: alloc, lt_free: free, lt_solve: run } = instance.exports;
  return (text) => {
    const input = new TextEncoder().encode(text);
    const ptr = alloc(input.length);
    new Uint8Array(memory.buffer, ptr, input.length).set(input);
    const out = run(ptr, input.length);
    free(ptr, input.length);
    const len = new DataView(memory.buffer).getUint32(out, true);
    const json = new TextDecoder().decode(new Uint8Array(memory.buffer, out + 4, len));
    free(out, len + 4);
    const result = JSON.parse(json);
    if (result.error) throw new Error(result.error);
    return result;
  };
}

/** ソルバーの結果（辺の並び）を、駅の並びに戻します。 */
export function expand(graph, net, solution) {
  const name = (i) => stationKey(graph.stations[i]);
  const stations = [];
  const junctions = [];
  const legs = [];
  for (const [e, fromNode, , mode] of solution.route) {
    const s = net.segs[e];
    const forward = net.nodes[fromNode] === s.a;
    let path = forward ? s.path : [...s.path].reverse();
    let edges = forward ? s.edges : [...s.edges].reverse();
    // 分かれ道のとなりの駅から出る（1）・となりの駅で終わる（2）ときは、端の1駅ぶんを外します。
    if (mode === 1) { path = path.slice(1); edges = edges.slice(1); }
    if (mode === 2) { path = path.slice(0, -1); edges = edges.slice(0, -1); }
    if (!stations.length) { stations.push(path[0]); junctions.push(path[0]); }
    stations.push(...path.slice(1));
    junctions.push(path.at(-1));
    // 乗る線ごとにまとめます（同じ線が続くあいだは、1つの区間）。
    edges.forEach((ed, i) => {
      const line = graph.lines[graph.edges[ed][3]];
      const km10 = graph.edges[ed][2];
      const last = legs.at(-1);
      if (last && last.line === line) { last.to = name(path[i + 1]); last.km10 += km10; }
      else legs.push({ line, from: name(path[i]), to: name(path[i + 1]), km10 });
    });
  }
  for (const l of legs) { l.km = l.km10 / 10; delete l.km10; }
  return {
    km: solution.total / 10,
    stations: stations.map(name),
    junctions: junctions.map(name),
    legs,
  };
}

/**
 * special.js の solvers.longestTicket に渡せる関数を作ります。
 *
 * @param {{limitMs?: number, graph?: object, solver?: Function}} [opts]
 *   limitMs: 制限時間（既定 5秒）。JR 全国の網は大きすぎて、最長だと確かめきるところまでは
 *   行けません。そのときは時間いっぱい経路を組み替えて伸ばし、いちばん長かった候補を返します
 *   （1秒でも、10秒かけたときの 98% ほどの長さが出ます）。小さな網なら、最長と確かめて早く返ります。
 * @returns {Promise<(kind: "oneway"|"round", opts?: {from?: string|null}) => Promise<object>>}
 */
export async function createLongestTicketSolver({ limitMs = 5000, graph = null, solver = null } = {}) {
  const g = graph ?? await loadGraph();
  const run = solver ?? await loadSolver();
  const memo = new Map();
  return async (kind = "oneway", { from = null } = {}) => {
    const round = kind === "round";
    const start = from ? findStation(g, from) : -1;
    const key = `${round}:${start}`;
    // 見つからない駅名は全国の答えと同じ計算なので、覚えた答えに断り書きだけ足します。
    const missing = from && start < 0 ? `「${from}」という駅が路線網に見つからなかったので、全国でいちばん長い経路を出しています。` : "";
    if (memo.has(key)) return withNote(memo.get(key), missing);
    const net = contract(g, { from: start });
    const solution = run(problemText(net, { start, loop: !round, limitMs }));
    const r = expand(g, net, solution);
    const notes = [];
    notes.push(solution.proven
      ? "これより長い経路が無いことを、計算で確かめています。"
      : "制限時間内に見つかったいちばん長い候補です。もっと長い経路があるかもしれません（全国の網では、最長と確かめきるところまでは計算しません）。");
    if (round) notes.push("往復は、同じ経路を引き返します（通った駅に戻って終わる形は、逆向きにたどれないので使いません）。");
    notes.push(`距離は営業キロです（${g.asOf} 時点の路線網。BRT と船は入れていません）。`);
    const out = {
      route: r.junctions,
      km: round ? Math.round(r.km * 2 * 10) / 10 : r.km,
      oneWayKm: r.km,
      stations: r.stations,
      legs: r.legs,
      proven: solution.proven,
      upperKm: (round ? 2 : 1) * solution.upper / 10,
      stats: solution.stats,
      solver: "longest-ticket（分枝限定法）",
      note: notes.join(""),
    };
    memo.set(key, out);
    return withNote(out, missing);
  };
}

const withNote = (out, note) => (note ? { ...out, note: note + out.note } : out);
