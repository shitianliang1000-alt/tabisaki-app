// スポットどうしの関係・かたまり・回る順番・足りないところ（Issue #357、packages/core/kbgraph.mjs）の試験。

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELATION_TYPES, GRAPH_LIMITS, GraphError, readRelations, addRelation, removeRelation, relationsOf,
  straightKm, clusterSpots, planRoute, findGaps,
} from "../packages/core/kbgraph.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(ROOT, "packages/cli/bin/tabisaki-plan.mjs");
const home = mkdtempSync(path.join(tmpdir(), "tabisaki-graph-"));
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: ROOT, env: { ...process.env, TABISAKI_HOME: home, TABISAKI_KB: "" } });

const P = (id, lat, lng, extra = {}) => ({ id, name: id, lat, lng, ...extra });

test("関係: 型と向き。向きの無い型は、どちらから付けても1件", () => {
  assert.deepEqual(Object.keys(RELATION_TYPES), ["pair", "alternative", "related", "before", "part_of"]);
  const doc = { spots: {} };
  assert.equal(addRelation(doc, "b", "a", "pair").created, true);
  assert.equal(addRelation(doc, "a", "b", "pair", { note: "同じ日に" }).created, false);
  assert.deepEqual(doc.relations.map((r) => [r.from, r.to, r.type, r.note]), [["a", "b", "pair", "同じ日に"]]);
  addRelation(doc, "a", "b", "before");
  addRelation(doc, "x", "a", "part_of");
  assert.deepEqual(relationsOf(doc, "a").map((r) => [r.other, r.type, r.direction, r.label]), [
    ["b", "pair", "both", "一緒に回る"], ["b", "before", "out", "より先に行く"], ["x", "part_of", "in", "を含む"],
  ]);
  assert.deepEqual(relationsOf(doc, "b").find((r) => r.type === "before").label, "より後に行く");
});

test("関係: 自分どうし・知らない型・逆向き・ひと回りする順番は断る", () => {
  const doc = {};
  assert.throws(() => addRelation(doc, "a", "a", "pair"), GraphError);
  assert.throws(() => addRelation(doc, "a", "b", "friend"), /pair \/ alternative/);
  assert.throws(() => addRelation(doc, "__proto__", "b", "pair"), /id/);
  addRelation(doc, "a", "b", "before");
  addRelation(doc, "b", "c", "before");
  assert.throws(() => addRelation(doc, "b", "a", "before"), /逆向き/);
  assert.throws(() => addRelation(doc, "c", "a", "before"), /ひと回り/);
  assert.equal(doc.relations.length, 2);
});

test("関係: 外す。手で書き換えられた relations は、おかしいものだけ使わない", () => {
  const doc = {};
  addRelation(doc, "a", "b", "pair");
  addRelation(doc, "a", "b", "before");
  assert.equal(removeRelation(doc, "b", "a", "pair").length, 1);
  assert.equal(removeRelation(doc, "a", "b").length, 1);
  assert.deepEqual(removeRelation(doc, "a", "b"), []);
  const hand = { relations: [{ from: "a", to: "b", type: "pair" }, { from: "b", to: "a", type: "pair" }, { from: "a", to: "a", type: "pair" }, { from: "a", to: "b", type: "enemy" }, null, { from: "a", to: "c", type: "before", note: "x".repeat(999) }] };
  const { list, problems } = readRelations(hand);
  assert.equal(list.length, 2);
  assert.equal(list[1].note.length, GRAPH_LIMITS.note);
  assert.equal(problems.length, 3);
  assert.deepEqual(readRelations({ relations: "こわれた" }).list, []);
  assert.deepEqual(readRelations({}).problems, []);
});

test("距離: 直線（大圏）の距離。座標が無ければ null", () => {
  // 東京駅 → 新大阪駅 は 直線で約 403km
  const d = straightKm({ lat: 35.6812, lng: 139.7671 }, { lat: 34.7335, lng: 135.5003 });
  assert.ok(d > 398 && d < 408, String(d));
  assert.equal(straightKm({ lat: 35, lng: 139 }, { lat: 35, lng: 139 }), 0);
  assert.equal(straightKm({ lat: 35 }, { lat: 35, lng: 139 }), null);
});

test("かたまり: 近いものをまとめ、離れた1件ははぐれにする。順番を変えても同じ結果", () => {
  const spots = [
    P("a1", 35.0000, 139.0000), P("a2", 35.0010, 139.0005), P("a3", 35.0020, 139.0010),
    P("b1", 35.1000, 139.1000), P("b2", 35.1005, 139.1005),
    P("far", 36.0, 140.0), P("nowhere", null, null),
  ];
  const r = clusterSpots(spots, { epsKm: 0.3, minPts: 2 });
  assert.deepEqual(r.clusters.map((c) => c.spots.map((s) => s.id).sort()), [["a1", "a2", "a3"], ["b1", "b2"]]);
  assert.deepEqual(r.noise.map((s) => s.id), ["far"]);
  assert.equal(r.skipped, 1);
  assert.ok(r.clusters[0].radiusKm < 0.3);
  const again = clusterSpots([...spots].reverse(), { epsKm: 0.3, minPts: 2 });
  assert.deepEqual(again, r);
  // 鎖のようにつながっていれば、端どうしが離れていても1つのかたまり（密度でつなぐ）
  const chain = Array.from({ length: 10 }, (_, i) => P(`c${i}`, 35 + i * 0.002, 139));
  assert.equal(clusterSpots(chain, { epsKm: 0.3, minPts: 2 }).clusters.length, 1);
  assert.equal(clusterSpots(chain, { epsKm: 0.1, minPts: 2 }).clusters.length, 0);
  assert.equal(clusterSpots(spots, { epsKm: 0.3, minPts: 3 }).clusters.length, 1);
  assert.throws(() => clusterSpots(spots, { epsKm: 0 }), GraphError);
  assert.throws(() => clusterSpots(spots, { minPts: 1 }), GraphError);
});

test("かたまり: 升目で近くだけを見ても、総当たりと同じ分けかたになる", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const spots = Array.from({ length: 300 }, (_, i) => P(`s${String(i).padStart(3, "0")}`, 35 + rnd() * 0.2, 139 + rnd() * 0.2));
  const eps = 0.8;
  const r = clusterSpots(spots, { epsKm: eps, minPts: 3 });
  const label = new Map();
  r.clusters.forEach((c) => c.spots.forEach((s) => label.set(s.id, c.n)));
  // 芯（eps 以内に3件以上）どうしが eps 以内なら、同じかたまりに入っているはず
  const near = (a) => spots.filter((b) => straightKm(a, b) <= eps);
  const core = spots.filter((a) => near(a).length >= 3);
  for (const a of core) {
    assert.ok(label.has(a.id), `${a.id} は芯なのに、はぐれになっています`);
    for (const b of near(a)) assert.equal(label.get(b.id) !== undefined, true);
    for (const b of near(a).filter((x) => core.includes(x))) assert.equal(label.get(a.id), label.get(b.id));
  }
  for (const s of r.noise) assert.ok(near(s).length < 3 && !near(s).some((b) => core.includes(b)));
});

const line = [P("w", 35, 139.00), P("x", 35, 139.01), P("y", 35, 139.02), P("z", 35, 139.03)];

test("回る順番: 9か所までは総当たりで、直線の距離がいちばん短い順番", () => {
  const r = planRoute([line[2], line[0], line[3], line[1]]);
  const ids = r.order.map((s) => s.id).join("");
  assert.ok(ids === "wxyz" || ids === "zyxw", ids);
  assert.equal(r.exact, true);
  assert.equal(r.basis, "straight_line");
  assert.equal(r.legs.length, 3);
  assert.ok(Math.abs(r.totalStraightKm - straightKm(line[0], line[3])) < 0.02);
  const loop = planRoute(line, { loop: true, start: "x" });
  assert.equal(loop.order[0].id, "x");
  assert.equal(loop.legs.length, 4);
  assert.ok(Math.abs(loop.totalStraightKm - 2 * straightKm(line[0], line[3])) < 0.03);
});

test("回る順番: 出発・終わり・先に行く決まりを守る。守れなければ断る", () => {
  const r = planRoute(line, { start: "y", end: "x" });
  assert.equal(r.order[0].id, "y");
  assert.equal(r.order.at(-1).id, "x");
  const b = planRoute(line, { start: "w", before: [["z", "x"]] });
  const pos = (id) => b.order.findIndex((s) => s.id === id);
  assert.ok(pos("z") < pos("x"));
  assert.throws(() => planRoute(line, { start: "x", before: [["z", "x"]] }), /出発の指定が合いません/);
  assert.throws(() => planRoute(line, { before: [["w", "x"], ["x", "w"]] }), /守る順番がありません/);
  assert.throws(() => planRoute(line, { start: "どこか" }), /入っていません/);
  assert.throws(() => planRoute([line[0]]), /2か所から/);
  assert.throws(() => planRoute([line[0], { id: "n", name: "座標なし" }]), /座標の無い/);
  assert.throws(() => planRoute([line[0], line[0]]), /2回/);
});

test("回る順番: 時間は返さない。速さを渡したときだけ「目安」の欄に入れる", () => {
  const r = planRoute(line);
  assert.equal(JSON.stringify(r).includes("inutes"), false, "分の欄は無い");
  assert.equal("rough" in r, false);
  const s = planRoute(line, { speedKmh: 4 });
  assert.ok(s.legs.every((l) => l.roughMinutes >= 1 && l.straightKm > 0));
  assert.match(s.rough.note, /時刻表や道の距離ではありません/);
  // 直線 0.91km × 1.3 ÷ 4km/h ≒ 18分
  assert.equal(s.legs[0].roughMinutes, Math.round(s.legs[0].straightKm * 1.3 / 4 * 60));
  assert.throws(() => planRoute(line, { speedKmh: 0 }), /速さ/);
});

test("回る順番: 10か所以上は近似。総当たりの答えに近く、決まりも守る", () => {
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pts = Array.from({ length: 9 }, (_, i) => P(`p${i}`, 35 + rnd() * 0.1, 139 + rnd() * 0.1));
  const exact = planRoute(pts);
  // 同じ9点に、1点目のすぐそばの点を足して近似の道に入れます
  const ten = [...pts, P("p9", pts[0].lat + 0.00001, pts[0].lng)];
  const approx = planRoute(ten);
  assert.equal(approx.exact, false);
  assert.match(approx.method, /いちばん短いとは限りません/);
  assert.equal(new Set(approx.order.map((s) => s.id)).size, 10);
  assert.ok(approx.totalStraightKm <= exact.totalStraightKm * 1.15 + 0.01, `${approx.totalStraightKm} と ${exact.totalStraightKm}`);
  const big = Array.from({ length: 40 }, (_, i) => P(`q${String(i).padStart(2, "0")}`, 35 + rnd() * 0.3, 139 + rnd() * 0.3));
  const r = planRoute(big, { start: "q05", end: "q06", before: [["q10", "q02"], ["q02", "q30"]] });
  const pos = (id) => r.order.findIndex((s) => s.id === id);
  assert.equal(pos("q05"), 0);
  assert.equal(pos("q06"), 39);
  assert.ok(pos("q10") < pos("q02") && pos("q02") < pos("q30"));
  assert.throws(() => planRoute(Array.from({ length: GRAPH_LIMITS.routeSpots + 1 }, (_, i) => P(`r${i}`, 35, 139 + i * 0.001))), /か所まで/);
});

test("足りないところ: 見込みに比べて少ない 地域 × 分類 と、1件も無い地域", () => {
  const spots = [];
  const add = (prefecture, category, n) => { for (let i = 0; i < n; i++) spots.push({ id: `${prefecture}-${category}-${i}`, prefecture, category }); };
  add("A県", "寺院", 20); add("A県", "温泉", 20);
  add("B県", "寺院", 20); add("B県", "温泉", 1);
  add("C県", "寺院", 2);
  const r = findGaps(spots, { areas: ["A県", "B県", "C県", "D県"] });
  assert.equal(r.total, 63);
  assert.deepEqual(r.empty, ["D県"]);
  assert.deepEqual(r.gaps.map((g) => [g.area, g.category, g.count]), [["B県", "温泉", 1]]);
  assert.equal(r.gaps[0].expected, 7);
  // 件数の少ない地域（C県の温泉の見込みは 0.7 件）は、少ないと言わない
  assert.equal(r.gaps.some((g) => g.area === "C県"), false);
  assert.equal(r.areas[0].area, "A県");
  assert.deepEqual(findGaps([]).gaps, []);
});

test("tabisaki spot relate / route / cluster / gap: 端末から使え、kb/ は変えない", () => {
  const kbDir = path.join(ROOT, "kb");
  const stamp = () => readdirSync(kbDir).map((f) => `${f}:${readFileSync(path.join(kbDir, f)).length}`).join("|");
  const before = stamp();

  const rel = run("spot", "relate", "箱根神社", "大涌谷", "--type=before", "--note=午前に");
  assert.equal(rel.status, 0, rel.stderr);
  assert.match(rel.stdout, /付けました: 箱根神社（hakone-2） → 大涌谷（hakone-3）/);
  assert.equal(run("spot", "relate", "大涌谷", "箱根神社", "--type=before").status, 2);
  assert.equal(run("spot", "relate", "大涌谷", "箱根神社").status, 2, "--type が要る");
  const ls = JSON.parse(run("spot", "relate", "ls", "大涌谷", "--output=json").stdout);
  assert.deepEqual(ls.relations.map((r) => [r.other, r.type, r.direction, r.otherName]), [["hakone-2", "before", "in", "箱根神社"]]);
  const doc = JSON.parse(readFileSync(path.join(home, "kbs", "mine", "overlay.json"), "utf8"));
  assert.deepEqual(doc.relations.map((r) => [r.from, r.to, r.type]), [["hakone-2", "hakone-3", "before"]]);
  assert.deepEqual(doc.spots, {});

  // 決まり（箱根神社が先）を守り、時間ではなく直線の距離を出す
  const route = run("spot", "route", "大涌谷", "ポーラ美術館", "箱根神社", "芦ノ湖", "--output=json");
  assert.equal(route.status, 0, route.stderr);
  const j = JSON.parse(route.stdout);
  const names = j.order.map((s) => s.name);
  assert.ok(names.indexOf("箱根神社") < names.indexOf("大涌谷"));
  assert.equal(j.basis, "straight_line");
  assert.equal(JSON.stringify(j).includes("inutes"), false);
  const text = run("spot", "route", "大涌谷", "ポーラ美術館", "箱根神社");
  assert.match(text.stdout, /直線の距離の合計: [\d.]+km/);
  assert.match(text.stderr, /移動の時間ではありません/);
  assert.match(run("spot", "route", "大涌谷", "ポーラ美術館", "--speed=4").stdout, /目安 \d+分/);
  assert.equal(run("spot", "route", "大涌谷").status, 2);
  assert.equal(run("spot", "route", "大涌谷", "箱根神社", "--start=大涌谷").status, 2, "決まりと合わない出発は断る");

  const cl = JSON.parse(run("spot", "cluster", "--region=箱根町", "--eps=0.5", "--min=3", "--output=json").stdout);
  assert.ok(cl.clusters.length >= 2);
  assert.ok(cl.clusters.every((c) => c.size >= 3 && c.spots.length === c.size));
  assert.match(run("spot", "cluster").stdout, /自分が足した・直したスポットがありません/);
  assert.equal(run("spot", "cluster", "--eps=0").status, 2);

  const gap = JSON.parse(run("spot", "gap", "--prefecture=神奈川県", "--output=json").stdout);
  assert.equal(gap.by, "region");
  assert.ok(gap.total > 500);
  assert.equal(run("spot", "gap", "--prefecture=かながわ").status, 2);

  const rm = run("spot", "relate", "rm", "大涌谷", "箱根神社");
  assert.equal(rm.status, 0, rm.stderr);
  assert.match(run("spot", "relate", "ls").stdout, /付けた関係はありません/);
  assert.equal(stamp(), before, "kb/ は1バイトも変えない");
});
