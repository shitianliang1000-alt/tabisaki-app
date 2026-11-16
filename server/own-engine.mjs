// 自作JSエンジン v1: RAPTOR 方式の出発検索と、逆向き探索による終電。
// 時刻表は「ストア」（own-store.mjs）越しに読みます（手元では SQLite の
// メモリ展開、Workers では D1/KV）。戻り値は中継（server/transit.js）の
// routeFrom と同じ形に揃えます。

// GTFS route_type -> 中継の vehicle 語彙（LS8H_KIND と同じ語彙）
const VEHICLE = {
  0: "tram", 1: "subway", 2: "rail", 3: "bus", 4: "ferry", 5: "cable",
  6: "ropeway", 7: "cable", 11: "bus", 12: "monorail",
};
const vehicleOf = (routeType) => VEHICLE[routeType] ?? "bus";

/** 秒（運行日0時起点、24時超あり） -> "HH:MM" */
export function fmt(secs) {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}
const minutesOf = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };

/** 中継 otpLine と同じだった路線名の作り方（番号だけ取り、事業者名を前に付ける） */
export function lineName(route) {
  const agency = (route.agency ?? "").trim();
  let name = (route.shortName || route.longName || "").trim();
  if (name.includes("：")) name = name.split("：")[0].trim();
  if (name.length > 24) name = `${name.slice(0, 23)}…`;
  if (!agency || name.startsWith(agency)) return name || agency;
  return name ? `${agency} ${name}` : agency;
}

const DEFAULT_RADIUS_M = 1500;

// ---------------------------------------------------------------------------
// ラベル: { uid, time, prev, via }
//   via = {type:'access', walkSecs}
//       | {type:'walk', fromUid, walkSecs}
//       | {type:'ride', trip, pattern, boardUid, alightIdx}
// prev は直前のラベル（不変オブジェクトへの参照）。
// ---------------------------------------------------------------------------

async function footpathClosure(store, labels) {
  // labels: Map uid->label（到達済みの最速）。徒歩で広げて新しい Map を返す。
  const out = new Map(labels);
  const queue = [...out.keys()];
  const inQueue = new Set(queue);
  while (queue.length) {
    const uid = queue.pop();
    inQueue.delete(uid);
    const e = out.get(uid);
    for (const fp of await store.footpathsFrom(uid)) {
      const nt = e.time + fp.secs;
      const cur = out.get(fp.to);
      if (!cur || nt < cur.time) {
        out.set(fp.to, { uid: fp.to, time: nt, prev: e, rides: e.rides ?? 0,
                         via: { type: "walk", fromUid: uid, walkSecs: fp.secs } });
        if (!inQueue.has(fp.to)) { queue.push(fp.to); inQueue.add(fp.to); }
      }
    }
  }
  return out;
}

async function patternOf(store, ctx, pid) {
  if (!ctx.patterns.has(pid)) ctx.patterns.set(pid, await store.pattern(pid));
  return ctx.patterns.get(pid);
}

// その日に動く便だけを pattern ごとにメモ化する（探索中ずっと同じ日付のため）
async function activeTrips(store, ctx, pattern) {
  let a = ctx.active.get(pattern.pid);
  if (!a) {
    const flags = await Promise.all(
      pattern.trips.map((t) => store.serviceActive(t.service, ctx.day)));
    a = pattern.trips.filter((_, i) => flags[i]);
    ctx.active.set(pattern.pid, a);
  }
  return a;
}

/** pattern の便のうち、idx 番目の停留所を ready 以降に出る最も早い便 */
async function earliestTrip(store, ctx, pattern, idx, ready) {
  let best = null;
  for (const t of await activeTrips(store, ctx, pattern)) {
    const dep = t.times[2 * idx + 1];
    if (dep < ready) continue;
    if (!best || dep < best.times[2 * idx + 1]) best = t;
  }
  return best;
}

/** pattern の便のうち、idx 番目の停留所に limit 以前に着く最も遅い便 */
async function latestTrip(store, ctx, pattern, idx, limit) {
  let best = null;
  for (const t of await activeTrips(store, ctx, pattern)) {
    const arr = t.times[2 * idx];
    if (arr > limit) continue;
    if (!best || arr > best.times[2 * idx]) best = t;
  }
  return best;
}

async function scanForward(store, labels, ctx) {
  // labels（徒歩閉包済み）から1回乗る到達を作る。Map uid->label を返す。
  const rides = new Map();
  const pids = new Set();
  for (const uid of labels.keys()) {
    for (const sp of await store.patternsAtStop(uid)) pids.add(sp.pid);
  }
  for (const pid of pids) {
    const pattern = await patternOf(store, ctx, pid);
    if (!pattern) continue;
    const stops = pattern.stops;
    let trip = null, boardEntry = null;
    for (let idx = 0; idx < stops.length; idx++) {
      const uid = stops[idx];
      if (trip) {
        const arr = trip.times[2 * idx];
        const cur = rides.get(uid);
        if (!cur || arr < cur.time) {
          rides.set(uid, { uid, time: arr, prev: boardEntry, rides: (boardEntry.rides ?? 0) + 1,
            via: { type: "ride", trip, pattern, boardUid: boardEntry.uid, alightIdx: idx } });
        }
      }
      const src = labels.get(uid);
      if (src) {
        const t2 = await earliestTrip(store, ctx, pattern, idx, src.time);
        if (t2 && (!trip || t2.times[2 * idx + 1] < trip.times[2 * idx + 1])) {
          trip = t2; boardEntry = src;
        }
      }
    }
  }
  return rides;
}

function mergeLabels(base, extra) {
  const out = new Map(base);
  for (const [uid, e] of extra) {
    const cur = out.get(uid);
    if (!cur || e.time < cur.time) out.set(uid, e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 経路の組み立て（ラベルの鎖 → 中継の routes 形式）
// ---------------------------------------------------------------------------

async function buildRoute(store, destEntry, egressWalkSecs, q, originTimeSecs) {
  const stopCache = new Map();
  const stopOf = async (uid) => {
    if (!stopCache.has(uid)) stopCache.set(uid, await store.stop(uid));
    return stopCache.get(uid);
  };
  const chain = [];
  for (let e = destEntry; e; e = e.prev) chain.unshift(e);
  // chain[0] は access ラベル。乗り物区間を取り出す。
  const rideLegs = [];
  let pendingWalk = 0; // 徒歩ラベルの蓄積（access / walk）
  const intermediates = [];
  for (const e of chain) {
    if (e.via.type === "ride") {
      const { trip, pattern, boardUid, alightIdx } = e.via;
      const boardIdx = pattern.stops.indexOf(boardUid);
      const route = await store.route(pattern.routeUid);
      const fromStop = await stopOf(boardUid);
      const toStop = await stopOf(e.uid);
      rideLegs.push({
        vehicle: vehicleOf(route.routeType), route, trip,
        fromStop, toStop, boardIdx, alightIdx,
        depSecs: trip.times[2 * boardIdx + 1], arrSecs: trip.times[2 * alightIdx],
        walkBeforeSecs: pendingWalk,
      });
      for (let i = boardIdx + 1; i < alightIdx; i++) {
        intermediates.push((await stopOf(pattern.stops[i])).name);
      }
      pendingWalk = 0;
    } else {
      pendingWalk += e.via.walkSecs ?? 0;
    }
  }
  if (!rideLegs.length) return null; // 歩くだけは乗り換え検索の答えにしない

  const legs = [];
  rideLegs.forEach((r, i) => {
    if (i === 0) {
      legs.push({
        kind: "walk", from: q.from.name ?? "出発地", to: r.fromStop.name,
        departure: fmt(originTimeSecs), arrival: fmt(originTimeSecs + r.walkBeforeSecs),
        minutes: Math.round(r.walkBeforeSecs / 60), line: "", vehicle: "walk",
        _secs: [originTimeSecs, originTimeSecs + r.walkBeforeSecs],
      });
    } else if (r.walkBeforeSecs > 0) {
      const prevArr = rideLegs[i - 1].arrSecs;
      legs.push({
        kind: "walk", from: rideLegs[i - 1].toStop.name, to: r.fromStop.name,
        departure: fmt(prevArr), arrival: fmt(prevArr + r.walkBeforeSecs),
        minutes: Math.round(r.walkBeforeSecs / 60), line: "", vehicle: "walk",
        _secs: [prevArr, prevArr + r.walkBeforeSecs],
      });
    }
    legs.push({
      kind: "ride", from: r.fromStop.name, to: r.toStop.name,
      departure: fmt(r.depSecs), arrival: fmt(r.arrSecs),
      minutes: minutesOf(fmt(r.arrSecs)) - minutesOf(fmt(r.depSecs)),
      line: lineName(r.route), vehicle: r.vehicle,
      _secs: [r.depSecs, r.arrSecs],
    });
  });
  const last = rideLegs.at(-1);
  const arrTotal = last.arrSecs + egressWalkSecs;
  legs.push({
    kind: "walk", from: last.toStop.name, to: q.to.name ?? "目的地",
    departure: fmt(last.arrSecs), arrival: fmt(arrTotal),
    minutes: Math.round(egressWalkSecs / 60), line: "", vehicle: "walk",
    _secs: [last.arrSecs, arrTotal],
  });

  // 運賃: 区間ごとに引いて合計。1区間でも引けなければ null。
  let fareYen = 0;
  for (const r of rideLegs) {
    const f = await store.fareFor(r.route, r.fromStop, r.toStop);
    if (f == null) { fareYen = null; break; }
    fareYen += f;
  }

  const cleanLegs = legs.map(({ _secs, ...l }) => l);
  const departure = cleanLegs[0].departure;
  const arrival = cleanLegs.at(-1).arrival;
  const transfers = rideLegs.length - 1;
  const fare = fareYen ? ` / ${fareYen.toLocaleString("ja-JP")}円` : "";
  return {
    departure, arrival,
    summary: `${departure}発→${arrival}着 / 乗換${transfers}回${fare}`,
    transfers, fareYen, distanceKm: null,
    legs: cleanLegs, intermediateStops: intermediates,
    _arrSecs: arrTotal, _depSecs: originTimeSecs,
  };
}

// ---------------------------------------------------------------------------
// 出発検索: 指定時刻以降で最も早く着く経路
// ---------------------------------------------------------------------------

export async function searchDepart(store, q) {
  const ctx = { day: store.dayNumber(q.date), active: new Map(), patterns: new Map() };
  const t0 = q.timeSecs;
  const radius = q.radiusM ?? DEFAULT_RADIUS_M;
  const maxTransfers = q.maxTransfers ?? 3;
  const access = await store.stopsWithin(q.from, radius);
  const egress = await store.stopsWithin(q.to, radius);
  if (!access.length || !egress.length) return null;
  const egressMap = new Map(egress.map((e) => [e.uid, e.walkSecs]));

  let labels = new Map();
  for (const a of access) {
    labels.set(a.uid, { uid: a.uid, time: t0 + a.walkSecs, prev: null, rides: 0,
                        via: { type: "access", walkSecs: a.walkSecs } });
  }
  labels = await footpathClosure(store, labels);

  let best = null; // {entry, egressWalkSecs, total}
  const check = (ls, needRide = true) => {
    for (const [uid, w] of egressMap) {
      const e = ls.get(uid);
      if (!e) continue;
      if (needRide && !(e.rides >= 1)) continue; // 歩くだけは答えにしない
      const total = e.time + w;
      if (!best || total < best.total) best = { entry: e, egressWalkSecs: w, total };
    }
  };
  check(labels);
  for (let round = 1; round <= maxTransfers + 1; round++) {
    const rides = await scanForward(store, labels, ctx);
    if (!rides.size) break;
    check(rides, false); // 乗車到達はマージで歩行ラベルに隠れる前に拾う
    labels = await footpathClosure(store, mergeLabels(labels, rides));
    check(labels);
  }
  if (!best) return null;
  const route = await buildRoute(store, best.entry, best.egressWalkSecs, q, t0);
  if (!route) return null;
  route.minutes = Math.round((route._arrSecs - t0) / 60);
  route.rideMinutes = Math.round((route._arrSecs - route._depSecs) / 60);
  delete route._arrSecs; delete route._depSecs;
  return route;
}

// ---------------------------------------------------------------------------
// 終電: その運行日のうち、完走できる最も遅い出発（逆向き RAPTOR）
// 逆ラベル: { uid, time(その停留所にいられる最も遅い時刻), next, via }
//   via = {type:'egress', walkSecs} | {type:'walk', toUid, walkSecs}
//       | {type:'ride', trip, pattern, alightUid, alightEntry}
// ---------------------------------------------------------------------------

// 逆向きでは「乗車を含むラベル」を「徒歩だけのラベル」より優先する。
// 徒歩だけのラベルは CAP（30:00）由来の大きな時刻を持ち、乗車ラベルを
// 隠してしまうため、時刻の大小より先に rides の有無で比べる。
function betterReverse(a, b) {
  if (!b) return true;
  const ar = (a.rides ?? 0) >= 1, br = (b.rides ?? 0) >= 1;
  if (ar !== br) return ar;
  return a.time > b.time;
}

async function footpathClosureReverse(store, labels) {
  const out = new Map(labels);
  const queue = [...out.keys()];
  const inQueue = new Set(queue);
  while (queue.length) {
    const uid = queue.pop();
    inQueue.delete(uid);
    const e = out.get(uid);
    for (const fp of await store.footpathsFrom(uid)) {
      const nt = e.time - fp.secs;
      if (nt < 0) continue;
      const cand = { uid: fp.to, time: nt, next: e, rides: e.rides ?? 0,
                     via: { type: "walk", toUid: uid, walkSecs: fp.secs } };
      if (betterReverse(cand, out.get(fp.to))) {
        out.set(fp.to, cand);
        if (!inQueue.has(fp.to)) { queue.push(fp.to); inQueue.add(fp.to); }
      }
    }
  }
  return out;
}

async function scanReverse(store, labels, ctx) {
  const rides = new Map();
  const pids = new Set();
  for (const uid of labels.keys()) {
    for (const sp of await store.patternsAtStop(uid)) pids.add(sp.pid);
  }
  for (const pid of pids) {
    const pattern = await patternOf(store, ctx, pid);
    if (!pattern) continue;
    const stops = pattern.stops;
    let trip = null, alightEntry = null, alightUid = null, alightIdx = -1;
    for (let idx = stops.length - 1; idx >= 0; idx--) {
      const uid = stops[idx];
      if (trip && idx < alightIdx) {
        const dep = trip.times[2 * idx + 1];
        const cur = rides.get(uid);
        if (!cur || dep > cur.time) {
          rides.set(uid, { uid, time: dep, next: alightEntry, rides: (alightEntry.rides ?? 0) + 1,
            via: { type: "ride", trip, pattern, alightUid } });
        }
      }
      const src = labels.get(uid);
      if (src) {
        const t2 = await latestTrip(store, ctx, pattern, idx, src.time);
        if (t2 && (!trip || t2.times[2 * idx] > trip.times[2 * idx])) {
          trip = t2; alightEntry = src; alightUid = uid; alightIdx = idx;
        }
      }
    }
  }
  return rides;
}

async function buildRouteReverse(store, originEntry, originDepSecs, q) {
  const stopCache = new Map();
  const stopOf = async (uid) => {
    if (!stopCache.has(uid)) stopCache.set(uid, await store.stop(uid));
    return stopCache.get(uid);
  };
  // originEntry から next を辿って前向きの区間列にする
  const rideLegs = [];
  let e = originEntry;
  const intermediates = [];
  while (e) {
    if (e.via.type === "ride") {
      const { trip, pattern, alightUid } = e.via;
      const boardIdx = pattern.stops.indexOf(e.uid);
      const alightIdx = pattern.stops.indexOf(alightUid);
      const route = await store.route(pattern.routeUid);
      rideLegs.push({
        vehicle: vehicleOf(route.routeType), route, trip,
        fromStop: await stopOf(e.uid), toStop: await stopOf(alightUid),
        boardIdx, alightIdx,
        depSecs: trip.times[2 * boardIdx + 1], arrSecs: trip.times[2 * alightIdx],
        walkBeforeSecs: 0,
      });
      for (let i = boardIdx + 1; i < alightIdx; i++) {
        intermediates.push((await stopOf(pattern.stops[i])).name);
      }
      e = e.next;
    } else if (e.via.type === "walk") {
      if (rideLegs.length) rideLegs.at(-1).walkAfterSecs = e.via.walkSecs;
      e = e.next;
    } else { // egress
      if (rideLegs.length) rideLegs.at(-1).egressWalkSecs = e.via.walkSecs;
      e = e.next;
    }
  }
  if (!rideLegs.length) return null;

  const legs = [];
  rideLegs.forEach((r, i) => {
    if (i === 0) {
      // 最初の徒歩は access + footpath の合算（出発点 -> 最初の乗車停留所）
      legs.push({ kind: "walk", from: q.from.name ?? "出発地", to: r.fromStop.name,
        departure: fmt(originDepSecs), arrival: fmt(r.depSecs),
        minutes: Math.round((r.depSecs - originDepSecs) / 60), line: "", vehicle: "walk" });
    } else if (rideLegs[i - 1].walkAfterSecs) {
      const prevArr = rideLegs[i - 1].arrSecs;
      legs.push({ kind: "walk", from: rideLegs[i - 1].toStop.name, to: r.fromStop.name,
        departure: fmt(prevArr), arrival: fmt(prevArr + rideLegs[i - 1].walkAfterSecs),
        minutes: Math.round(rideLegs[i - 1].walkAfterSecs / 60), line: "", vehicle: "walk" });
    }
    legs.push({ kind: "ride", from: r.fromStop.name, to: r.toStop.name,
      departure: fmt(r.depSecs), arrival: fmt(r.arrSecs),
      minutes: minutesOf(fmt(r.arrSecs)) - minutesOf(fmt(r.depSecs)),
      line: lineName(r.route), vehicle: r.vehicle });
  });
  const last = rideLegs.at(-1);
  const egressWalkSecs = last.egressWalkSecs ?? 0;
  const arrTotal = last.arrSecs + egressWalkSecs;
  legs.push({ kind: "walk", from: last.toStop.name, to: q.to.name ?? "目的地",
    departure: fmt(last.arrSecs), arrival: fmt(arrTotal),
    minutes: Math.round(egressWalkSecs / 60), line: "", vehicle: "walk" });

  let fareYen = 0;
  for (const r of rideLegs) {
    const f = await store.fareFor(r.route, r.fromStop, r.toStop);
    if (f == null) { fareYen = null; break; }
    fareYen += f;
  }
  const departure = legs[0].departure;
  const arrival = legs.at(-1).arrival;
  const transfers = rideLegs.length - 1;
  const fare = fareYen ? ` / ${fareYen.toLocaleString("ja-JP")}円` : "";
  return {
    departure, arrival,
    summary: `${departure}発→${arrival}着 / 乗換${transfers}回${fare}`,
    transfers, fareYen, distanceKm: null,
    legs, intermediateStops: intermediates,
    minutes: Math.round((arrTotal - originDepSecs) / 60),
    rideMinutes: Math.round((arrTotal - originDepSecs) / 60),
    _depSecs: rideLegs[0].depSecs,
  };
}

export async function searchLast(store, q) {
  const ctx = { day: store.dayNumber(q.date), active: new Map(), patterns: new Map() };
  const radius = q.radiusM ?? DEFAULT_RADIUS_M;
  const maxTransfers = q.maxTransfers ?? 3;
  const access = await store.stopsWithin(q.from, radius);
  const egress = await store.stopsWithin(q.to, radius);
  if (!access.length || !egress.length) return null;
  const CAP = 30 * 3600;

  let labels = new Map();
  for (const g of egress) {
    labels.set(g.uid, { uid: g.uid, time: CAP, next: null, rides: 0,
                        via: { type: "egress", walkSecs: g.walkSecs } });
  }
  labels = await footpathClosureReverse(store, labels);
  const accessMap = new Map(access.map((a) => [a.uid, a.walkSecs]));

  let best = null; // {entry, depSecs}
  const check = (ls) => {
    for (const [uid, w] of accessMap) {
      const e = ls.get(uid);
      if (!e || e.time >= CAP) continue;
      if (!(e.rides >= 1)) continue; // 歩くだけの到達は終電にしない
      const dep = e.time - w;
      if (!best || dep > best.depSecs) best = { entry: e, depSecs: dep, accessWalkSecs: w };
    }
  };
  check(labels);
  for (let round = 1; round <= maxTransfers + 1; round++) {
    const rides = await scanReverse(store, labels, ctx);
    if (!rides.size) break;
    const merged = new Map(labels);
    for (const [uid, e] of rides) {
      if (betterReverse(e, merged.get(uid))) merged.set(uid, e);
    }
    check(merged); // 徒歩閉包で乗車ラベルが隠れる前に拾う
    labels = await footpathClosureReverse(store, merged);
    check(labels);
  }
  if (!best) return null;
  const route = await buildRouteReverse(store, best.entry, best.depSecs, q);
  if (!route) return null;
  delete route._depSecs;
  return route;
}
