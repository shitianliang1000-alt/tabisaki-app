// 正規化データセット（SQLite）をメモリへ読み込むローダー。
// 変換ツール tools/own_convert.py が作った DB を、手元（Node）の
// 自前エンジン用に読みます。Workers では D1 から読むので（own-store.mjs）、
// ここは node:sqlite を動的 import にして、Worker のビルドに混ざらない
// ようにしています。

export const WALK_MPS = 1.2;
export const DETOUR = 1.3; // 徒歩の迂回率（出発地・到着地との徒歩にだけ掛ける）

export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const dayNumber = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

/** SQLite ファイルを開いて、メモリ展開したデータ一式を返します。 */
export async function loadLocalDb(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });

  const feedIdx = JSON.parse(
    db.prepare("SELECT value FROM meta WHERE key='feed_idx'").get().value);
  const feedNameByIdx = new Map(Object.entries(feedIdx).map(([k, v]) => [v, k]));

  const stops = [null]; // uid は 1 始まり
  const zoneIntOf = new Map(); // `${feed_idx}|${zone_id}` -> int
  for (const z of db.prepare("SELECT id, feed_idx, zone_id FROM zones").all()) {
    zoneIntOf.set(`${z.feed_idx}|${z.zone_id}`, z.id);
  }
  const stopFeedIdx = [0];
  for (const s of db.prepare(
    "SELECT uid, feed, stop_id, name, lat, lon, zone_id FROM stops ORDER BY uid").all()) {
    const fidx = feedIdx[s.feed];
    stops[s.uid] = {
      uid: s.uid, feed: s.feed, feedIdx: fidx, stopId: s.stop_id,
      name: s.name, lat: s.lat, lon: s.lon,
      zone: zoneIntOf.get(`${fidx}|${s.zone_id ?? ""}`) ?? -1,
    };
    stopFeedIdx[s.uid] = fidx;
  }

  const routes = new Map();
  for (const r of db.prepare(
    "SELECT uid, feed, route_id, agency, short_name, long_name, route_type FROM routes").all()) {
    routes.set(r.uid, {
      uid: r.uid, feed: r.feed, feedIdx: feedIdx[r.feed], routeId: r.route_id,
      agency: r.agency ?? "", shortName: r.short_name ?? "",
      longName: r.long_name ?? "", routeType: r.route_type,
    });
  }

  const services = [null];
  for (const s of db.prepare("SELECT sid, start, bitmap FROM services ORDER BY sid").all()) {
    services[s.sid] = { startDay: dayNumber(s.start), bitmap: new Uint8Array(s.bitmap) };
  }
  const serviceActive = (sid, day) => {
    const sv = services[sid];
    if (!sv) return false;
    const i = day - sv.startDay;
    if (i < 0 || i >= sv.bitmap.length * 8) return false;
    return (sv.bitmap[i >> 3] >> (i & 7)) & 1 ? true : false;
  };

  const patterns = new Map();
  for (const p of db.prepare("SELECT pid, route_uid, stops FROM patterns").all()) {
    patterns.set(p.pid, {
      pid: p.pid, routeUid: p.route_uid,
      stops: p.stops.split(",").map(Number), trips: [],
    });
  }
  const stmt = db.prepare(
    "SELECT pid, service, headsign, first_dep, times FROM trips ORDER BY pid, first_dep");
  for (const t of stmt.all()) {
    const u8 = new Uint8Array(t.times);
    const i32 = new Int32Array(u8.length / 4);
    new Uint8Array(i32.buffer).set(u8);
    patterns.get(t.pid).trips.push({
      service: t.service, headsign: t.headsign ?? "", times: i32, firstDep: t.first_dep,
    });
  }

  // 停留所 -> その停留所を含む pattern と位置
  const stopPatterns = new Map();
  for (const p of patterns.values()) {
    p.stops.forEach((uid, idx) => {
      if (!stopPatterns.has(uid)) stopPatterns.set(uid, []);
      stopPatterns.get(uid).push({ pid: p.pid, idx });
    });
  }

  const footpaths = new Map();
  for (const f of db.prepare("SELECT a, b, secs FROM footpaths").all()) {
    if (!footpaths.has(f.a)) footpaths.set(f.a, []);
    if (!footpaths.has(f.b)) footpaths.set(f.b, []);
    footpaths.get(f.a).push({ to: f.b, secs: f.secs });
    footpaths.get(f.b).push({ to: f.a, secs: f.secs });
  }

  // 運賃: (feed, origin zone, dest zone) -> [{routeUid|-1, price}]
  // 手元では全件をメモリに置けますが、Workers（D1）では全件ロードが
  // heap を膨らませるため、区間ごとに引く形にしています（own-store.mjs）。
  const farePrice = new Map();
  for (const f of db.prepare("SELECT id, price FROM fare_attrs").all()) {
    farePrice.set(f.id, f.price);
  }
  const fareByOD = new Map();
  const fareKey = (fidx, o, d) => fidx * 1e10 + o * 1e5 + d;
  for (const r of db.prepare(
    "SELECT feed_idx, route_uid, origin_id, destination_id, fare_id FROM fare_rules").all()) {
    const price = farePrice.get(r.fare_id);
    if (price == null) continue;
    const k = fareKey(r.feed_idx, r.origin_id, r.destination_id);
    if (!fareByOD.has(k)) fareByOD.set(k, []);
    fareByOD.get(k).push({ routeUid: r.route_uid ?? -1, price });
  }
  const fareFor = (route, fromStop, toStop) => {
    const list = fareByOD.get(fareKey(route.feedIdx, fromStop.zone, toStop.zone));
    if (!list) return null;
    let best = null;
    for (const c of list) {
      if (c.routeUid === -1 || c.routeUid === route.uid) {
        if (best == null || c.price < best) best = c.price;
      }
    }
    return best;
  };

  // stops の粗いグリッド索引（stopsWithin 用）
  const CELL = 0.02; // 約 2km
  const stopGrid = new Map();
  for (let uid = 1; uid < stops.length; uid++) {
    const s = stops[uid];
    if (!s) continue;
    const k = `${Math.floor(s.lat / CELL)},${Math.floor(s.lon / CELL)}`;
    if (!stopGrid.has(k)) stopGrid.set(k, []);
    stopGrid.get(k).push(uid);
  }

  db.close();
  return {
    stops, routes, patterns, stopPatterns, footpaths,
    serviceActive, dayNumber, fareFor, feedNameByIdx, stopGrid, CELL,
  };
}

/** 座標の半径内にある停留所（徒歩秒つき）。徒歩秒は footpaths と同じ式 ×迂回率。 */
export function stopsWithinMemory(data, point, radiusM) {
  const out = [];
  const CELL = data.CELL ?? 0.02;
  const m = Math.ceil(radiusM / 1800) + 1; // セル単位の余白
  const gx = Math.floor(point.lat / CELL), gy = Math.floor(point.lng / CELL);
  for (let dx = -m; dx <= m; dx++) {
    for (let dy = -m; dy <= m; dy++) {
      for (const uid of data.stopGrid?.get(`${gx + dx},${gy + dy}`) ?? []) {
        const s = data.stops[uid];
        const d = haversineM(point.lat, point.lng, s.lat, s.lon);
        if (d <= radiusM) {
          out.push({ uid, distM: d, walkSecs: Math.ceil((d / WALK_MPS) * DETOUR) });
        }
      }
    }
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}
