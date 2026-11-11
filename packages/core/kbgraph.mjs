// スポットどうしの関係・かたまり・回る順番・足りないところ（Issue #357。docs/user-kb.md「関係・かたまり・回る順番」）。
//
// 通信はしません。距離はすべて直線（大圏）の距離で、**移動の時間ではありません**。
// 時間を返す関数はここにありません（目安の分を出すときも、呼ぶ側が速さを渡し、
// 「直線の距離からの目安」と名前の付いた欄に入れます）。

const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * 関係の型。directed が true のものは向きがあります（from → to）。
 * 向きの無いものは、id の小さい方を from にそろえて1件だけ持ちます。
 */
export const RELATION_TYPES = Object.freeze({
  pair: { directed: false, label: "一緒に回る" },
  alternative: { directed: false, label: "どちらか（代わりになる）" },
  related: { directed: false, label: "関わりがある" },
  before: { directed: true, label: "より先に行く", inverse: "より後に行く" },
  part_of: { directed: true, label: "の中にある", inverse: "を含む" },
});

export const GRAPH_LIMITS = Object.freeze({ relations: 5000, note: 200, routeSpots: 200, exactRoute: 9 });

export class GraphError extends Error {
  constructor(code, message) { super(message); this.name = "GraphError"; this.code = code; }
}

const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 80 && !BAD_KEYS.has(id);

/** overlay の relations を読みます。手で書き換えられていても落ちないよう、おかしいものは使わずに理由を返します。 */
export function readRelations(doc) {
  const raw = doc?.relations;
  const list = [];
  const problems = [];
  if (raw === undefined) return { list, problems };
  if (!Array.isArray(raw)) return { list, problems: ["relations が並びではありません"] };
  const seen = new Set();
  raw.slice(0, GRAPH_LIMITS.relations).forEach((r, i) => {
    const t = RELATION_TYPES[r?.type];
    if (!r || typeof r !== "object" || !Object.hasOwn(RELATION_TYPES, String(r.type))) { problems.push(`${i + 1}件目: 知らない型です（${r?.type}）`); return; }
    if (!validId(r.from) || !validId(r.to) || r.from === r.to) { problems.push(`${i + 1}件目: from・to がおかしいです`); return; }
    const [from, to] = !t.directed && r.from > r.to ? [r.to, r.from] : [r.from, r.to];
    const key = `${r.type}\u0000${from}\u0000${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ from, to, type: r.type, ...(typeof r.note === "string" && r.note ? { note: r.note.slice(0, GRAPH_LIMITS.note) } : {}), at: typeof r.at === "string" ? r.at : null });
  });
  if (raw.length > GRAPH_LIMITS.relations) problems.push(`関係が多すぎます（${raw.length}件。${GRAPH_LIMITS.relations}件まで）`);
  return { list, problems };
}

/** before の向きをたどって、from から to に届くか。 */
function reaches(list, from, to) {
  const next = new Map();
  for (const r of list) if (r.type === "before") (next.get(r.from) ?? next.set(r.from, []).get(r.from)).push(r.to);
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const x = stack.pop();
    if (x === to) return true;
    for (const y of next.get(x) ?? []) if (!seen.has(y)) { seen.add(y); stack.push(y); }
  }
  return false;
}

/**
 * 関係を1つ足します（同じものがあれば、メモだけ書き換えます）。doc を書き換えます。
 * @returns {{relation: object, created: boolean}}
 */
export function addRelation(doc, from, to, type, { note = "", now = new Date() } = {}) {
  if (!Object.hasOwn(RELATION_TYPES, String(type))) throw new GraphError("invalid_input", `関係の型は ${Object.keys(RELATION_TYPES).join(" / ")} のどれかです`);
  if (!validId(from) || !validId(to)) throw new GraphError("invalid_input", "スポットの id がおかしいです");
  if (from === to) throw new GraphError("invalid_input", "同じスポットどうしには付けられません");
  const t = RELATION_TYPES[type];
  const { list } = readRelations(doc);
  const [a, b] = !t.directed && from > to ? [to, from] : [from, to];
  if (t.directed && list.some((r) => r.type === type && r.from === b && r.to === a)) {
    throw new GraphError("conflict", `逆向きの関係がもうあります（${b} → ${a}）。先に spot relate rm で外してください`);
  }
  if (type === "before" && reaches(list, b, a)) throw new GraphError("conflict", "順番がひと回りしてしまいます（ほかの「先に行く」と合いません）");
  const text = String(note ?? "").slice(0, GRAPH_LIMITS.note);
  const hit = list.find((r) => r.type === type && r.from === a && r.to === b);
  if (hit) {
    if (text) hit.note = text; else delete hit.note;
    doc.relations = list;
    return { relation: hit, created: false };
  }
  if (list.length >= GRAPH_LIMITS.relations) throw new GraphError("limit", `関係は ${GRAPH_LIMITS.relations}件までです`);
  const relation = { from: a, to: b, type, ...(text ? { note: text } : {}), at: now.toISOString() };
  list.push(relation);
  doc.relations = list;
  return { relation, created: true };
}

/** 関係を外します。type を書かなければ、その2つのあいだの関係をすべて外します。 @returns {object[]} 外したもの */
export function removeRelation(doc, a, b, type = null) {
  const { list } = readRelations(doc);
  const gone = list.filter((r) => ((r.from === a && r.to === b) || (r.from === b && r.to === a)) && (!type || r.type === type));
  if (gone.length) doc.relations = list.filter((r) => !gone.includes(r));
  return gone;
}

/** そのスポットから見た関係。向きのあるものは、どちら側かで言葉を変えます。 */
export function relationsOf(doc, id) {
  return readRelations(doc).list.filter((r) => r.from === id || r.to === id).map((r) => {
    const t = RELATION_TYPES[r.type];
    const out = r.from === id;
    return { other: out ? r.to : r.from, type: r.type, direction: t.directed ? (out ? "out" : "in") : "both",
      label: t.directed && !out ? t.inverse : t.label, note: r.note ?? "", at: r.at };
  });
}

// ---- 距離 ----

const rad = (x) => x * Math.PI / 180;
/** 2点のあいだの直線（大圏）の距離（km）。座標が無ければ null。 */
export function straightKm(a, b) {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return null;
  const s = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(s)));
}
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const located = (s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng);

// ---- かたまり（DBSCAN） ----

/**
 * 座標でかたまりを作ります（DBSCAN。数を先に決めなくてよく、離れた1件を無理に入れません）。
 * epsKm 以内に minPts 件（自分を含む）ある点を芯にして、つながるものを1つのかたまりにします。
 * 同じ入力からは、いつも同じ結果になります（id の順に見ます）。
 *
 * @returns {{clusters: {n: number, size: number, center: {lat: number, lng: number}, radiusKm: number, spots: object[]}[], noise: object[], skipped: number}}
 */
export function clusterSpots(spots, { epsKm = 1, minPts = 2 } = {}) {
  if (!(epsKm > 0) || epsKm > 500) throw new GraphError("invalid_input", "半径は 0 より大きく 500km までです");
  if (!Number.isInteger(minPts) || minPts < 2) throw new GraphError("invalid_input", "かたまりの最小の数は 2 以上の整数です");
  const pts = spots.filter(located).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const skipped = spots.length - pts.length;
  // 升目に分けて、近くの升だけを見ます（全部どうしを比べない）
  const dLat = epsKm / 111.0;
  const cellOf = (s) => {
    const row = Math.floor(s.lat / dLat);
    const dLng = epsKm / (111.32 * Math.max(0.01, Math.cos(rad((row + 0.5) * dLat))));
    return [row, Math.floor(s.lng / dLng), dLng];
  };
  const rows = new Map();
  pts.forEach((s, i) => {
    const [row] = cellOf(s);
    (rows.get(row) ?? rows.set(row, []).get(row)).push(i);
  });
  const neighbours = (i) => {
    const s = pts[i];
    const [row] = cellOf(s);
    const out = [];
    for (let r = row - 1; r <= row + 1; r++) for (const j of rows.get(r) ?? []) {
      if (Math.abs(pts[j].lng - s.lng) > 3 * cellOf(pts[j])[2] && Math.abs(pts[j].lng - s.lng) < 180) continue;
      if (straightKm(s, pts[j]) <= epsKm) out.push(j);
    }
    return out;
  };
  const label = new Array(pts.length).fill(0); // 0 = まだ、-1 = はぐれ、1.. = かたまり
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    if (label[i]) continue;
    const near = neighbours(i);
    if (near.length < minPts) { label[i] = -1; continue; }
    n++;
    label[i] = n;
    const queue = near.filter((j) => j !== i);
    for (let q = 0; q < queue.length; q++) {
      const j = queue[q];
      if (label[j] === -1) label[j] = n;
      if (label[j]) continue;
      label[j] = n;
      const more = neighbours(j);
      if (more.length >= minPts) for (const k of more) if (!label[k] || label[k] === -1) queue.push(k);
    }
  }
  const groups = new Map();
  pts.forEach((s, i) => { if (label[i] > 0) (groups.get(label[i]) ?? groups.set(label[i], []).get(label[i])).push(s); });
  const clusters = [...groups.values()].map((members) => {
    const center = { lat: members.reduce((a, s) => a + s.lat, 0) / members.length, lng: members.reduce((a, s) => a + s.lng, 0) / members.length };
    const withKm = members.map((s) => ({ ...s, fromCenterKm: round(straightKm(center, s)) })).sort((a, b) => a.fromCenterKm - b.fromCenterKm || String(a.id).localeCompare(String(b.id)));
    return { size: members.length, center: { lat: round(center.lat, 5), lng: round(center.lng, 5) }, radiusKm: withKm.at(-1).fromCenterKm, spots: withKm };
  }).sort((a, b) => b.size - a.size || String(a.spots[0].id).localeCompare(String(b.spots[0].id))).map((c, i) => ({ n: i + 1, ...c }));
  return { clusters, noise: pts.filter((_, i) => label[i] === -1), skipped };
}

// ---- 回る順番 ----

/**
 * 回る順番を決めます。
 *
 * めあて: 直線の距離の合計（loop なら出発点へ戻る分も足す）を小さくする。
 * 条件:   start があれば最初、end があれば最後。before の組 [先, 後] は、その順を守る。
 * 方法:   9か所までは総当たり（いちばん短い順番）。それより多いときは、近い順につないでから
 *         2-opt と1か所の入れ直しで縮める（いちばん短いとは限らない）。
 *
 * 距離は直線です。**移動の時間ではありません**（山や川をはさむと、近くても遠回りになります）。
 * speedKmh を渡したときだけ、目安の分（直線 × detour ÷ 速さ）を roughMinutes に入れます。
 */
export function planRoute(spots, { start = null, end = null, loop = false, before = [], speedKmh = null, detour = 1.3 } = {}) {
  const ids = spots.map((s) => String(s.id));
  if (new Set(ids).size !== ids.length) throw new GraphError("invalid_input", "同じスポットが2回入っています");
  if (spots.length < 2) throw new GraphError("invalid_input", "回る順番は、2か所から決められます");
  if (spots.length > GRAPH_LIMITS.routeSpots) throw new GraphError("limit", `回る順番は ${GRAPH_LIMITS.routeSpots}か所までです`);
  const nowhere = spots.filter((s) => !located(s));
  if (nowhere.length) throw new GraphError("invalid_input", `座標の無いスポットがあります: ${nowhere.map((s) => s.name ?? s.id).join("・")}`);
  if (speedKmh !== null && !(speedKmh > 0 && speedKmh <= 300)) throw new GraphError("invalid_input", "速さは 0 より大きく 300km/h までです");
  const n = spots.length;
  const idx = new Map(ids.map((id, i) => [id, i]));
  const at = (id, what) => {
    if (id === null || id === undefined) return -1;
    if (!idx.has(String(id))) throw new GraphError("invalid_input", `${what}のスポットが、回る場所に入っていません: ${id}`);
    return idx.get(String(id));
  };
  const s0 = at(start, "出発");
  const e0 = loop ? -1 : at(end, "終わり");
  if (loop && end !== null && end !== undefined && String(end) !== String(start ?? end)) throw new GraphError("invalid_input", "ひと回り（loop）のときは、終わりを別に決められません");
  if (s0 >= 0 && s0 === e0) throw new GraphError("invalid_input", "出発と終わりが同じです（ひと回りなら --loop）");
  const prec = before.filter(([a, b]) => idx.has(String(a)) && idx.has(String(b))).map(([a, b]) => [idx.get(String(a)), idx.get(String(b))]);
  for (const [a, b] of prec) {
    if (b === s0) throw new GraphError("conflict", `「${spots[a].name ?? ids[a]}」を先に行く決まりと、出発の指定が合いません`);
    if (a === e0) throw new GraphError("conflict", `「${spots[b].name ?? ids[b]}」を後に行く決まりと、終わりの指定が合いません`);
  }
  const D = spots.map((a) => spots.map((b) => straightKm(a, b)));
  const length = (order) => {
    let t = 0;
    for (let i = 1; i < order.length; i++) t += D[order[i - 1]][order[i]];
    return loop ? t + D[order.at(-1)][order[0]] : t;
  };
  const okOrder = (order) => {
    if (s0 >= 0 && order[0] !== s0) return false;
    if (e0 >= 0 && order.at(-1) !== e0) return false;
    if (!prec.length) return true;
    const pos = new Array(n);
    order.forEach((v, i) => { pos[v] = i; });
    return prec.every(([a, b]) => pos[a] < pos[b]);
  };
  const mustBefore = new Map();
  for (const [a, b] of prec) (mustBefore.get(b) ?? mustBefore.set(b, []).get(b)).push(a);
  const ready = (v, used) => (mustBefore.get(v) ?? []).every((a) => used[a]);

  let best = null;
  let exact = false;
  if (n <= GRAPH_LIMITS.exactRoute) {
    exact = true;
    let bestLen = Infinity;
    const used = new Array(n).fill(false);
    const order = [];
    // ひと回りで出発を決めていないときは、どこから始めても同じなので 0 から始めます（決まりが無いときだけ）
    const firsts = s0 >= 0 ? [s0] : loop && !prec.length ? [0] : [...Array(n).keys()];
    const dfs = (len) => {
      if (len >= bestLen) return;
      if (order.length === n) {
        const total = loop ? len + D[order.at(-1)][order[0]] : len;
        if (total < bestLen - 1e-12 && (e0 < 0 || order.at(-1) === e0)) { bestLen = total; best = [...order]; }
        return;
      }
      for (let v = 0; v < n; v++) {
        if (used[v] || !ready(v, used)) continue;
        if (v === e0 && order.length !== n - 1) continue;
        used[v] = true; order.push(v);
        dfs(order.length > 1 ? len + D[order.at(-2)][v] : 0);
        order.pop(); used[v] = false;
      }
    };
    for (const f of firsts) {
      if (!ready(f, used) || (f === e0 && n > 1)) continue;
      used[f] = true; order.push(f);
      dfs(0);
      order.pop(); used[f] = false;
    }
  } else {
    const greedy = (first) => {
      const used = new Array(n).fill(false);
      const order = [first];
      used[first] = true;
      while (order.length < n) {
        let pick = -1;
        for (let v = 0; v < n; v++) {
          if (used[v] || !ready(v, used)) continue;
          if (v === e0 && order.length !== n - 1) continue;
          if (pick < 0 || D[order.at(-1)][v] < D[order.at(-1)][pick]) pick = v;
        }
        if (pick < 0) return null;
        used[pick] = true; order.push(pick);
      }
      return order;
    };
    const improve = (order) => {
      let cur = order;
      let curLen = length(cur);
      for (let pass = 0, moved = true; moved && pass < 50; pass++) {
        moved = false;
        for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
          // 2-opt: i..j を裏返す
          const a = [...cur.slice(0, i), ...cur.slice(i, j + 1).reverse(), ...cur.slice(j + 1)];
          // 1か所を抜いて、別の場所に入れ直す
          const b = [...cur];
          const [x] = b.splice(i, 1);
          b.splice(j, 0, x);
          for (const cand of [a, b]) {
            if (!okOrder(cand)) continue;
            const l = length(cand);
            if (l < curLen - 1e-9) { cur = cand; curLen = l; moved = true; }
          }
        }
      }
      return cur;
    };
    const firsts = s0 >= 0 ? [s0] : n <= 60 ? [...Array(n).keys()] : [0];
    let bestLen = Infinity;
    for (const f of firsts) {
      if ((mustBefore.get(f) ?? []).length) continue;
      const g = greedy(f);
      if (!g || !okOrder(g)) continue;
      const done = improve(g);
      const l = length(done);
      if (l < bestLen - 1e-9) { bestLen = l; best = done; }
    }
  }
  if (!best) throw new GraphError("conflict", "決まり（出発・終わり・先に行く）をすべて守る順番がありません");

  const legs = [];
  const pairs = best.map((v, i) => [v, best[i + 1]]).slice(0, -1);
  if (loop) pairs.push([best.at(-1), best[0]]);
  for (const [a, b] of pairs) {
    const km = D[a][b];
    legs.push({ from: ids[a], to: ids[b], straightKm: round(km), ...(speedKmh ? { roughMinutes: Math.max(1, Math.round(km * detour / speedKmh * 60)) } : {}) });
  }
  const totalKm = round(length(best));
  return {
    order: best.map((v) => spots[v]), legs, totalStraightKm: totalKm, loop, exact,
    method: exact ? "総当たり（直線の距離でいちばん短い順番）" : "近い順につないでから 2-opt と入れ直しで縮めた順番（いちばん短いとは限りません）",
    basis: "straight_line",
    ...(speedKmh ? { rough: { speedKmh, detour, totalMinutes: legs.reduce((a, l) => a + l.roughMinutes, 0), note: "直線の距離に遠回りの倍率を掛け、速さで割った目安です。時刻表や道の距離ではありません" } } : {}),
  };
}

// ---- 足りないところ ----

/**
 * 地域 × 分類の表から、ほかに比べて少ないところを探します。
 *
 * 見込み = その地域の件数 × その分類の件数 ÷ 全体の件数（地域と分類が無関係だとしたときの数）。
 * 見込みが minExpected 件以上あるのに、実際が 見込み × ratio 以下の升を「少ない」とします。
 * 「その土地に本当に無い」のか「収録が足りない」のかは、ここでは分かりません（海の無い県に海水浴場は無い）。
 *
 * @param {object[]} spots
 * @param {{by?: (s: object) => string, minExpected?: number, ratio?: number, areas?: string[]}} [o]
 *   areas を渡すと、1件も無い地域も出します（都道府県の一覧など）
 */
export function findGaps(spots, { by = (s) => s.prefecture, minExpected = 3, ratio = 0.25, areas = [] } = {}) {
  const table = new Map();
  const colTotal = new Map();
  let total = 0;
  for (const s of spots) {
    const area = by(s);
    const cat = s.category;
    if (!area || !cat) continue;
    const row = table.get(area) ?? table.set(area, new Map()).get(area);
    row.set(cat, (row.get(cat) ?? 0) + 1);
    colTotal.set(cat, (colTotal.get(cat) ?? 0) + 1);
    total++;
  }
  const gaps = [];
  const rows = [];
  for (const [area, row] of table) {
    const rowTotal = [...row.values()].reduce((a, b) => a + b, 0);
    rows.push({ area, total: rowTotal, categories: Object.fromEntries([...row].sort((a, b) => b[1] - a[1])) });
    for (const [cat, n] of colTotal) {
      const expected = rowTotal * n / total;
      const count = row.get(cat) ?? 0;
      if (expected >= minExpected && count <= expected * ratio) gaps.push({ area, category: cat, count, expected: round(expected, 1), short: round(expected - count, 1) });
    }
  }
  gaps.sort((a, b) => b.short - a.short || a.area.localeCompare(b.area, "ja") || a.category.localeCompare(b.category, "ja"));
  rows.sort((a, b) => b.total - a.total || a.area.localeCompare(b.area, "ja"));
  return { total, areas: rows, empty: areas.filter((a) => !table.has(a)), gaps, minExpected, ratio };
}
