// 自前エンジン（own-engine.mjs）のデータアクセスの抽象（ストア）。
//
// エンジンは、この形の非同期メソッドだけを通して時刻表を読みます。
//
//   dayNumber(ymd)                    "YYYY-MM-DD" -> 日番号（同期・純粋）
//   serviceActive(sid, day)           その運行日に便があるか
//   patternsAtStop(uid)               停留所を含む pattern と位置
//   pattern(pid)                      pattern の停留所並びと便（時刻パック済み）
//   footpathsFrom(uid)                徒歩乗り換え先 [{to, secs}]
//   stop(uid) / route(routeUid)       停留所・路線の情報
//   fareFor(route, fromStop, toStop)  区間の運賃（引けなければ null）
//   stopsWithin(point, radiusM)       半径内の停留所（徒歩秒つき）
//
// 実装は2つあります。
//   - 手元・テスト用: SQLite ファイルをメモリ展開する（own-load.mjs）
//   - Workers 用: D1（TRANSIT_DB）から pattern/trip を読み、停留所の
//     最寄り探しは KV（TRANSIT_KV）の geohash セルから引く。
//     **運賃は区間ごとに SELECT で引く**（全件を JS の Map に載せると
//     heap が約46MB→約409MB に膨らむため。パイロットの実測）。

import { loadLocalDb, stopsWithinMemory, dayNumber, haversineM, WALK_MPS, DETOUR } from "./own-load.mjs";
import { geohashEncode, geohashNeighbors } from "./own-geohash.mjs";

const walkSecsOf = (distM) => Math.ceil((distM / WALK_MPS) * DETOUR);
const nearFilter = (cands, point, radiusM) => {
  const out = [];
  for (const c of cands) {
    const d = haversineM(point.lat, point.lng, c.lat, c.lon);
    if (d <= radiusM) out.push({ uid: c.uid, distM: d, walkSecs: walkSecsOf(d) });
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
};

// ── メモリ展開したデータ（手元・テスト用） ──────────────────

export function memoryStore(data) {
  return {
    dayNumber,
    serviceActive: async (sid, day) => data.serviceActive(sid, day),
    patternsAtStop: async (uid) => data.stopPatterns.get(uid) ?? [],
    pattern: async (pid) => data.patterns.get(pid) ?? null,
    footpathsFrom: async (uid) => data.footpaths.get(uid) ?? [],
    stop: async (uid) => data.stops[uid] ?? null,
    route: async (routeUid) => data.routes.get(routeUid) ?? null,
    fareFor: async (route, fromStop, toStop) => data.fareFor(route, fromStop, toStop),
    stopsWithin: async (point, radiusM) => stopsWithinMemory(data, point, radiusM),
  };
}

const localStores = new Map(); // path -> Promise<store>

/** SQLite ファイルのストア。同じパスは1回だけ読みます（中継は長命なため）。 */
export function localStoreFor(path) {
  if (!localStores.has(path)) {
    localStores.set(path, loadLocalDb(path).then(memoryStore));
  }
  return localStores.get(path);
}

// ── Workers 用（D1 + KV） ──────────────────────────────────

const blobToI32 = (v) => {
  const u8 = v instanceof Uint8Array ? v : new Uint8Array(v);
  const i32 = new Int32Array(u8.length / 4);
  new Uint8Array(i32.buffer).set(u8);
  return i32;
};
const blobToU8 = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));

/**
 * D1 バインディング（env.TRANSIT_DB）から読むストア。
 * pattern/trip は引かれた分だけ読み、検索の中ではキャッシュします。
 * 停留所の最寄り探しは、KV（env.TRANSIT_KV）があれば geohash セルから、
 * 無ければ D1 の範囲検索で代用します。
 */
export function createD1Store(d1, kv = null) {
  const cache = {
    feedIdx: null, services: null,
    stops: new Map(), routes: new Map(), patterns: new Map(), zones: new Map(),
  };

  const feedIdxOf = async () => {
    if (!cache.feedIdx) {
      const row = await d1.prepare("SELECT value FROM meta WHERE key='feed_idx'").first();
      cache.feedIdx = JSON.parse(row.value);
    }
    return cache.feedIdx;
  };

  const servicesOf = async () => {
    if (!cache.services) {
      const { results } = await d1.prepare("SELECT sid, start, bitmap FROM services ORDER BY sid").all();
      const arr = [null];
      for (const s of results) {
        arr[s.sid] = { startDay: dayNumber(s.start), bitmap: blobToU8(s.bitmap) };
      }
      cache.services = arr;
    }
    return cache.services;
  };

  const zoneIntOf = async (feedIdx, zoneId) => {
    const k = `${feedIdx}|${zoneId ?? ""}`;
    if (!cache.zones.has(k)) {
      const row = await d1.prepare("SELECT id FROM zones WHERE feed_idx=? AND zone_id=?")
        .bind(feedIdx, zoneId ?? "").first();
      cache.zones.set(k, row?.id ?? -1);
    }
    return cache.zones.get(k);
  };

  return {
    dayNumber,

    serviceActive: async (sid, day) => {
      const sv = (await servicesOf())[sid];
      if (!sv) return false;
      const i = day - sv.startDay;
      if (i < 0 || i >= sv.bitmap.length * 8) return false;
      return ((sv.bitmap[i >> 3] >> (i & 7)) & 1) ? true : false;
    },

    patternsAtStop: async (uid) => {
      const { results } = await d1.prepare("SELECT pid, idx FROM stop_patterns WHERE uid=?")
        .bind(uid).all();
      return results.map((r) => ({ pid: r.pid, idx: r.idx }));
    },

    pattern: async (pid) => {
      if (!cache.patterns.has(pid)) {
        const head = await d1.prepare("SELECT route_uid, stops FROM patterns WHERE pid=?")
          .bind(pid).first();
        if (!head) { cache.patterns.set(pid, null); return null; }
        const { results } = await d1.prepare(
          "SELECT service, headsign, first_dep, times FROM trips WHERE pid=? ORDER BY first_dep")
          .bind(pid).all();
        cache.patterns.set(pid, {
          pid, routeUid: head.route_uid,
          stops: String(head.stops).split(",").map(Number),
          trips: results.map((t) => ({
            service: t.service, headsign: t.headsign ?? "",
            times: blobToI32(t.times), firstDep: t.first_dep,
          })),
        });
      }
      return cache.patterns.get(pid);
    },

    footpathsFrom: async (uid) => {
      const { results } = await d1.prepare(
        "SELECT b AS t, secs FROM footpaths WHERE a=? UNION ALL SELECT a AS t, secs FROM footpaths WHERE b=?")
        .bind(uid, uid).all();
      return results.map((r) => ({ to: r.t, secs: r.secs }));
    },

    stop: async (uid) => {
      if (!cache.stops.has(uid)) {
        const s = await d1.prepare(
          "SELECT uid, feed, stop_id, name, lat, lon, zone_id FROM stops WHERE uid=?")
          .bind(uid).first();
        if (!s) { cache.stops.set(uid, null); return null; }
        const fidx = (await feedIdxOf())[s.feed];
        cache.stops.set(uid, {
          uid: s.uid, feed: s.feed, feedIdx: fidx, stopId: s.stop_id,
          name: s.name, lat: s.lat, lon: s.lon,
          zone: await zoneIntOf(fidx, s.zone_id),
        });
      }
      return cache.stops.get(uid);
    },

    route: async (routeUid) => {
      if (!cache.routes.has(routeUid)) {
        const r = await d1.prepare(
          "SELECT uid, feed, route_id, agency, short_name, long_name, route_type FROM routes WHERE uid=?")
          .bind(routeUid).first();
        if (!r) { cache.routes.set(routeUid, null); return null; }
        cache.routes.set(routeUid, {
          uid: r.uid, feed: r.feed, feedIdx: (await feedIdxOf())[r.feed], routeId: r.route_id,
          agency: r.agency ?? "", shortName: r.short_name ?? "",
          longName: r.long_name ?? "", routeType: r.route_type,
        });
      }
      return cache.routes.get(routeUid);
    },

    // 運賃は区間ごとに引く（全件ロードは heap が膨らむため禁止）。
    fareFor: async (route, fromStop, toStop) => {
      if (fromStop.zone < 0 || toStop.zone < 0) return null;
      const row = await d1.prepare(
        `SELECT MIN(fa.price) AS price FROM fare_rules fr
         JOIN fare_attrs fa ON fa.id = fr.fare_id
         WHERE fr.feed_idx=? AND fr.origin_id=? AND fr.destination_id=?
           AND (fr.route_uid IS NULL OR fr.route_uid=?)`)
        .bind(route.feedIdx, fromStop.zone, toStop.zone, route.uid).first();
      return row?.price ?? null;
    },

    stopsWithin: async (point, radiusM) => {
      if (kv) {
        const cells = geohashNeighbors(geohashEncode(point.lat, point.lng, 5));
        const values = await Promise.all(cells.map((c) => kv.get(`stops:${c}`, "json")));
        const cands = [];
        for (const v of values) {
          for (const [uid, lat, lon] of v ?? []) cands.push({ uid, lat, lon });
        }
        if (cands.length) return nearFilter(cands, point, radiusM);
        // KV にまだ入っていない範囲は、D1 の範囲検索で代用します。
      }
      const dLat = radiusM / 111_320;
      const dLon = radiusM / (111_320 * Math.max(0.2, Math.cos((point.lat * Math.PI) / 180)));
      const { results } = await d1.prepare(
        "SELECT uid, lat, lon FROM stops WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?")
        .bind(point.lat - dLat, point.lat + dLat, point.lng - dLon, point.lng + dLon).all();
      return nearFilter(results, point, radiusM);
    },
  };
}
