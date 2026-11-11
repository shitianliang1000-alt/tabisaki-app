// 最長片道切符のソルバー（Issue #431）。
//
// 計算するのは Rust のソルバー（solver/longest-ticket/）で、その正しさは
// Rust の側のテスト（総当たりとの突き合わせ）で確かめています。
// ここで確かめるのは、Node.js から使う側です。
//
//   ・WebAssembly を読み込んで、答えが返る
//   ・小さな網で、総当たりと同じ長さになる
//   ・返ってきた経路が、ほんとうに路線網の上でつながっている
//   ・JR の路線網（rail/jr-graph.json）で、全国・駅ごとの経路が制限時間内に返る
//   ・core.special() が、何も渡さなくてもこのソルバーを使う

import test from "node:test";
import assert from "node:assert/strict";
import {
  prepare, loadGraph, findStation, contract, createLongestTicketSolver, stationKey,
} from "../packages/core/longest-ticket.mjs";
import { handleSpecial, ticketStart } from "../packages/core/src/special.js";
import { createCore } from "../packages/core/index.mjs";

// 小さな網。A―B―C―D の本線、C から E―F の枝線、D―G―H―C の環状線。
//
//     A ― B ― C ― D
//             | ＼   |
//             E   H ― G
//             |
//             F
const TOY = () => prepare({
  asOf: "2026-11-01",
  stations: ["A", "B", "C", "D", "E", "F", "G", "H"],
  lines: ["本線", "枝線", "環状線"],
  edges: [[0, 1, 10, 0], [1, 2, 20, 0], [2, 3, 30, 0], [2, 4, 15, 1], [4, 5, 25, 1], [3, 6, 12, 2], [6, 7, 13, 2], [7, 2, 14, 2]],
  forbid: [],
});

/** 総当たり（小さな網だけ）。同じ駅を二度通らない。loop なら、最後だけ通った駅に戻ってよい。 */
function brute(g, { from = -1, loop = true, forbid = [] } = {}) {
  let best = 0;
  const banned = (x, e1, e2) => forbid.some(([n, a, b]) => n === x && ((a === e1 && b === e2) || (a === e2 && b === e1)));
  const go = (x, seen, used, km, last) => {
    best = Math.max(best, km);
    for (const e of g.at[x]) {
      if (used.has(e) || (last >= 0 && banned(x, last, e))) continue;
      const y = g.edges[e][0] === x ? g.edges[e][1] : g.edges[e][0];
      if (seen.has(y)) { if (loop) best = Math.max(best, km + g.edges[e][2]); continue; }
      seen.add(y); used.add(e);
      go(y, seen, used, km + g.edges[e][2], e);
      seen.delete(y); used.delete(e);
    }
  };
  const starts = from >= 0 ? [from] : g.stations.map((_, i) => i);
  for (const s of starts) go(s, new Set([s]), new Set(), 0, -1);
  return best / 10;
}

/** 経路が路線網の上でつながっていて、決まりを守っているかを、ソルバーとは別に確かめます。 */
function checkRoute(g, r, { round = false } = {}) {
  const idx = new Map();
  g.stations.forEach((s, i) => { const k = stationKey(s); (idx.get(k) ?? idx.set(k, []).get(k)).push(i); });
  let km10 = 0;
  // 同じ名前の駅がある（福島・小倉…）ので、となりどうしでつながる組を選びます。
  let here = idx.get(r.stations[0]);
  const seen = new Set();
  const usedEdges = new Set();
  let cur = null;
  for (let i = 1; i < r.stations.length; i++) {
    const next = idx.get(r.stations[i]);
    assert.ok(next, `路線網に無い駅です: ${r.stations[i]}`);
    let hit = null;
    for (const a of (cur === null ? here : [cur])) {
      for (const e of g.at[a]) {
        if (usedEdges.has(e)) continue;
        const b = g.edges[e][0] === a ? g.edges[e][1] : g.edges[e][0];
        if (next.includes(b)) { hit = [a, b, e]; break; }
      }
      if (hit) break;
    }
    assert.ok(hit, `${r.stations[i - 1]} と ${r.stations[i]} は、となりどうしではありません`);
    if (cur === null) seen.add(hit[0]);
    usedEdges.add(hit[2]);
    km10 += g.edges[hit[2]][2];
    cur = hit[1];
    if (seen.has(cur)) {
      assert.equal(i, r.stations.length - 1, `${r.stations[i]} を途中で二度通っています`);
      assert.ok(!round, "往復の経路が、通った駅に戻って終わっています");
    }
    seen.add(cur);
  }
  assert.equal(km10 / 10, r.oneWayKm, "区間の営業キロを足しても、答えの長さになりません");
  assert.equal(Math.round(r.legs.reduce((s, l) => s + l.km * 10, 0)) / 10, r.oneWayKm, "乗る線ごとの長さの合計が合いません");
  assert.equal(r.legs[0].from, r.stations[0]);
  assert.equal(r.legs.at(-1).to, r.stations.at(-1));
  return km10 / 10;
}

test("小さな網: 総当たりと同じ長さで、経路がつながっている", async () => {
  const g = TOY();
  const solve = await createLongestTicketSolver({ graph: g });
  const all = await solve("oneway");
  assert.equal(all.km, brute(g));
  assert.equal(all.km, 10.9);
  assert.equal(all.proven, true);
  assert.deepEqual(all.stations, ["F", "E", "C", "D", "G", "H", "C"]);
  checkRoute(g, all);
  // 乗る線ごとの区間
  assert.deepEqual(all.legs.map((l) => [l.line, l.from, l.to, l.km]),
    [["枝線", "F", "C", 4], ["本線", "C", "D", 3], ["環状線", "D", "C", 3.9]]);
  // 出発駅を決める
  for (const from of ["A", "B", "D", "G", "F"]) {
    const r = await solve("oneway", { from });
    assert.equal(r.stations[0], from);
    assert.equal(r.km, brute(g, { from: g.stations.indexOf(from) }), `${from} から`);
    checkRoute(g, r);
  }
  // 往復は、通った駅に戻って終わる形を使わない（逆向きにたどれないため）。長さは2倍。
  const round = await solve("round");
  assert.equal(round.oneWayKm, brute(g, { loop: false }));
  assert.equal(round.km, round.oneWayKm * 2);
  checkRoute(g, round, { round: true });
  // 見つからない駅名は、全国の答えにして、そう書く
  const unknown = await solve("oneway", { from: "どこにもない" });
  assert.equal(unknown.km, all.km);
  assert.match(unknown.note, /どこにもない.*見つからなかった/);
});

test("小さな網: 通り抜けてはいけない駅を、通り抜けない", async () => {
  // P―Q―R―S の本線と、P―X―S の新幹線。X では乗り換えだけ（P―X―S と通り抜けない）。
  //   P ――― X ――― S        X からは枝線が T へ
  //   └ Q ― R ┘
  const g = prepare({
    asOf: "2026-11-01",
    stations: ["P", "Q", "R", "S", "X", "T", "U"],
    lines: ["本線", "新幹線", "枝線"],
    edges: [[0, 1, 10, 0], [1, 2, 10, 0], [2, 3, 10, 0], [0, 4, 15, 1], [4, 3, 15, 1], [4, 5, 50, 2], [3, 6, 5, 0]],
    forbid: [[4, 3, 4]],
  });
  const solve = await createLongestTicketSolver({ graph: g });
  const r = await solve("oneway");
  assert.equal(r.km, brute(g, { forbid: g.forbid }));
  checkRoute(g, r);
  const at = r.stations.indexOf("X");
  const around = [r.stations[at - 1], r.stations[at + 1]].sort().join("");
  assert.notEqual(around, "PS", "X を通り抜けています");
  // 決まりを外すと、もっと長い経路になる（＝決まりが効いている）
  const free = await (await createLongestTicketSolver({ graph: prepare({ ...g, forbid: [] }) }))("oneway");
  assert.ok(free.km >= r.km);
});

test("網を縮める: 途中の駅は辺の中にたたみ、分かれ道だけを残す", () => {
  const g = TOY();
  const net = contract(g);
  // 残るのは A・F（行き止まり）・C（分かれ道）と、輪を割るための1駅。
  assert.deepEqual(net.nodes.map((i) => g.stations[i]).sort(), ["A", "C", "F", "G"]);
  assert.equal(net.segs.reduce((s, x) => s + x.km, 0), g.edges.reduce((s, e) => s + e[2], 0));
  // 出発駅は、途中の駅でも残す
  assert.ok(contract(g, { from: 1 }).nodes.includes(1));
  assert.equal(findStation(g, "C駅"), 2);
  assert.equal(findStation(g, "いない"), -1);
});

test("出発駅の読み取り: 「○○から」「○○発」と書かれたときだけ", () => {
  assert.equal(ticketStart("最長片道切符で旅したい"), null);
  assert.equal(ticketStart("東京から最長片道切符"), "東京");
  assert.equal(ticketStart("最長片道切符で札幌から出発したい"), "札幌");
  assert.equal(ticketStart("新大阪駅発の最長片道切符"), "新大阪");
  assert.equal(ticketStart("家から最長片道切符"), null);
  assert.equal(ticketStart("最長片道切符の発見"), null);
});

// ---------------------------------------------------------------------------
//  JR の路線網
// ---------------------------------------------------------------------------

const graph = await loadGraph();
// 全国の網は最長と確かめきれないので、ソルバーは制限時間いっぱい経路を伸ばします。
// CI の時間を抑えるため、ここでは 2秒にしています（遅い機械のぶん、測る側は余裕を見ます）。
const LIMIT = 2000;
const jr = await createLongestTicketSolver({ graph, limitMs: LIMIT });

test("JR の路線網: 形が整っている", () => {
  assert.ok(graph.stations.length > 4000, `駅が少なすぎます（${graph.stations.length}）`);
  assert.match(graph.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(graph.license, "CC BY-SA 4.0");
  const pairs = new Set();
  for (const [a, b, km, line] of graph.edges) {
    assert.ok(a !== b && graph.stations[a] && graph.stations[b]);
    assert.ok(Number.isInteger(km) && km > 0 && km < 1000, `営業キロがおかしい: ${graph.stations[a]}―${graph.stations[b]} ${km}`);
    assert.ok(graph.lines[line]);
    pairs.add(`${a}-${b}-${km}`);
  }
  assert.equal(pairs.size, graph.edges.length, "同じ辺が二重に入っています");
  // 全部の駅が、線路でつながっている（四国・九州・北海道も、橋とトンネルで）。
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const x = stack.pop();
    for (const e of graph.at[x]) {
      const y = graph.edges[e][0] === x ? graph.edges[e][1] : graph.edges[e][0];
      if (!seen.has(y)) { seen.add(y); stack.push(y); }
    }
  }
  assert.equal(seen.size, graph.stations.length, "つながっていない駅があります");
  // 通り抜けの決まりは、新幹線の乗り換え駅に付いている
  const names = graph.forbid.map(([x]) => graph.stations[x]).sort();
  assert.deepEqual(names, ["古川", "新横浜", "新花巻", "新鳥栖", "燕三条"]);
  // 知られた営業キロ（線の全長）と合う
  const total = (name) => graph.edges.filter((e) => graph.lines[e[3]] === name).reduce((s, e) => s + e[2], 0) / 10;
  assert.equal(total("宗谷本線"), 259.4);
  assert.equal(total("土讃線"), 198.7);
  assert.equal(total("指宿枕崎線"), 87.8);
});

test("JR の路線網: 全国でいちばん長い経路の候補が、制限時間内に返る", async () => {
  const t0 = performance.now();
  const r = await jr("oneway");
  const ms = performance.now() - t0;
  assert.ok(ms < LIMIT + 5000, `時間がかかりすぎです（${Math.round(ms)}ms）`);
  checkRoute(graph, r);
  assert.equal(typeof r.proven, "boolean");
  // 北海道から九州まで通して、1万km 近く。網の全長（17,427.8km）は超えられません。
  assert.ok(r.km > 9500 && r.km < 17427.8, `長さがおかしい: ${r.km}km`);
  assert.ok(r.stations.length > 2000);
  const ends = [r.stations[0], r.stations.at(-1)].map((s) => graph.stations.indexOf(s));
  assert.ok(ends.every((x) => x >= 0));
  if (!r.proven) assert.match(r.note, /候補/);
  // 往復は、片道より短い経路の2倍（通った駅に戻って終わる形を使えないぶん）。
  const round = await jr("round");
  checkRoute(graph, round, { round: true });
  assert.ok(round.oneWayKm > 9000 && round.km === Math.round(round.oneWayKm * 20) / 10);
});

test("JR の路線網: 代表的な出発駅で、経路の候補が制限時間内に返る", async () => {
  for (const from of ["札幌", "東京", "大阪", "博多"]) {
    const t0 = performance.now();
    const r = await jr("oneway", { from });
    const ms = performance.now() - t0;
    assert.ok(ms < LIMIT + 5000, `${from}: 時間がかかりすぎです（${Math.round(ms)}ms）`);
    assert.equal(r.stations[0], from);
    assert.ok(r.km > 8000, `${from}: 短すぎます（${r.km}km）`);
    assert.ok(r.upperKm >= r.km);
    checkRoute(graph, r);
  }
});

// ---------------------------------------------------------------------------
//  旅の形（special.js）とのつなぎ
// ---------------------------------------------------------------------------

test("core.special: 何も渡さなくても、このソルバーで経路を出す", async () => {
  const core = await createCore();
  const r = await core.special({ wish: "最長片道切符で旅したい", from: "東京駅", days: 3, date: "2026-11-21" });
  assert.equal(r.special.status, "handled");
  assert.ok(r.special.route.km > 9500);
  assert.equal(typeof r.special.route.proven, "boolean");
  assert.ok(r.special.route.legs.length > 20);
  assert.match(r.special.notes.join(""), /営業キロ/);
  // 出発駅を書けば、そこから
  const s = await handleSpecial({
    text: "東京から最長片道切符", kb: { spots: [] }, origin: { name: "大阪駅" }, days: 3, date: "2026-11-21",
    solvers: { longestTicket: jr },
  });
  assert.equal(s.route.stations[0], "東京");
});
