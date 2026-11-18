// 自前のバス時刻表（ls8h に入っていないバス事業者の GTFS-JP）で経路を引きます。
//
// データは tools/build_bus_timetable.py が data/bus/ に作り、デプロイのときに
// .site/__bus/ に入ります（tools/build_worker.sh）。外からは見えません
// （/__bus/ は Worker が 404 にします）。中継は ASSETS から読みます。
// 手元の中継（server/node-proxy.mjs）は data/bus/ を直に読みます。
//
// 1回の検索で読むのは、出発地・到着地のまわりの区切り（0.02 度四方）と、
// そこを通るパターン（停まる順）の入ったファイルだけです。Workers の無料枠
// （CPU 10ms）に収めるためです。
//
// 探すのは「1本で行ける便」と「1回乗り換え（同じ停留所か、同じ名前で 300m 以内）」
// です。電車をまたぐ経路は ls8h・Transitous の担当で、中継は全部の候補から
// 早く着くものを選びます（server/transit.js の searchAuto）。
//
// docs/bus-timetable.md

/** サイトの中の置き場所。外から開くと Worker が 404 にします。 */
export const BUS_ASSET_DIR = "/__bus/";

export const WALK_RADIUS_M = 800;     // 地点から停留所まで、これより遠いものは使いません
const TRANSFER_RADIUS_M = 300;
const MIN_TRANSFER_SECS = 120;
const MAX_PATTERNS = 40;              // 乗り換えを探すときに読むパターンの上限（CPU のため）
const DAY = 86400;

const cache = new Map();

/** 読み込み（loader は path → JSON か null）。温まった Worker では使い回します。 */
async function load(loader, path) {
  if (cache.has(path)) return cache.get(path);
  const v = await loader(path);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(path, v ?? null);
  return v ?? null;
}

/** 試験用。 */
export function clearBusCache() { cache.clear(); }

export function distanceM(a, b) {
  const R = 6371000;
  const toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR;
  const dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// 道なり（直線の 1.25 倍）を分速 80m で歩く目安。
const walkSecs = (m) => Math.max(60, Math.ceil((m * 1.25) / 80) * 60);

/** 地点のまわりの停留所（近い順）。 */
export async function nearbyStops(loader, index, p, radius = WALK_RADIUS_M) {
  const T = index.tile;
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.cos(p.lat * Math.PI / 180));
  const out = [];
  for (let y = Math.floor((p.lat - dLat) * T); y <= Math.floor((p.lat + dLat) * T); y += 1) {
    for (let x = Math.floor((p.lng - dLng) * T); x <= Math.floor((p.lng + dLng) * T); x += 1) {
      const tile = await load(loader, `tiles/${y}_${x}.json`);
      for (const [feed, stop, name, lat, lng, refs] of tile ?? []) {
        const m = distanceM(p, { lat, lng });
        if (m <= radius) out.push({ feed, stop, name, lat, lng, refs, m, walk: walkSecs(m) });
      }
    }
  }
  return out.sort((a, b) => a.m - b.m);
}

// ── 運行日 ──────────────────────────────────────

/** 東京の日付（YYYYMMDD の数）と曜日の旗（月=1…日=64）と、0 時からの秒。 */
export function jstParts(date) {
  const t = new Date(date.getTime() + 9 * 3600 * 1000);
  const ymd = t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
  const bit = 1 << ((t.getUTCDay() + 6) % 7);
  const secs = t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds();
  return { ymd, bit, secs };
}

export function runs(service, ymd, bit) {
  if (!service) return false;
  if (service.rm?.includes(ymd)) return false;
  if (service.add?.includes(ymd)) return true;
  return Boolean(service.d & bit) && service.s <= ymd && ymd <= service.e;
}

// ── 便を探す ────────────────────────────────────

/**
 * パターンの from 番目を depAfter（今日 0 時からの秒）以降に出て、to 番目に着く、
 * いちばん早く着く便。前日の運行日の 24 時過ぎの便も見ます。
 */
export function earliestTrip(pat, from, to, depAfter, days, cal) {
  let best = null;
  for (const g of pat.tt) {
    const d = g.d ?? g.a;
    for (const day of days) {
      for (const [t0, svc] of g.t) {
        const dep = t0 + d[from] - day.shift;
        if (dep < depAfter) continue;
        const arr = t0 + g.a[to] - day.shift;
        if (best && arr >= best.arr) break; // t は出発順なので、ここから先は遅い
        if (!runs(cal[svc], day.ymd, day.bit)) continue;
        best = { dep, arr, head: g.h ?? "" };
        break;
      }
    }
  }
  return best;
}

function prevDay(ymd) {
  const y = Math.floor(ymd / 10000);
  const m = Math.floor(ymd / 100) % 100;
  const d = ymd % 100;
  const t = new Date(Date.UTC(y, m - 1, d) - DAY * 1000);
  return { ymd: t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate(), bit: 1 << ((t.getUTCDay() + 6) % 7) };
}

/** 秒（今日 0 時から）を「HH:MM」に。24 時を超えたら 24 時台のまま。 */
export function hm(secs) {
  const s = Math.max(0, Math.round(secs / 60));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function lineName(feedMeta, pat, head) {
  const op = pat.ag || feedMeta?.short || feedMeta?.name || "";
  const route = String(pat.r ?? "").trim();
  const h = head ? ` ${head.replace(/行き?$/, "")}行` : "";
  return `${op}${route && route !== op ? ` ${route}` : ""}${h}`.trim();
}

/**
 * 経路を探します。返すのは {legs, attribution} の配列です。legs は server/transit.js の
 * routeFrom に渡す区間の並び（vehicle・from・to・departure・arrival・line）、
 * attribution は使った時刻表の出典（CC BY は表記が義務）です。
 */
export async function searchBus(loader, q, { maxResults = 3 } = {}) {
  if (!q.fromAt || !q.toAt || q.search === "last") return [];
  const index = await load(loader, "index.json");
  if (!index?.feeds?.length) return [];
  if (distanceM(q.fromAt, q.toAt) < 500) return []; // 歩いたほうが早い
  const feeds = Object.fromEntries(index.feeds.map((f) => [f.id, f]));
  const [origins, dests] = await Promise.all([
    nearbyStops(loader, index, q.fromAt), nearbyStops(loader, index, q.toAt),
  ]);
  if (!origins.length || !dests.length) return [];

  const now = jstParts(q.at);
  const yest = prevDay(now.ymd);
  const days = [{ ymd: now.ymd, bit: now.bit, shift: 0 }, { ...yest, shift: DAY }];
  const cals = {};
  const calOf = async (feed) => (cals[feed] ??= (await load(loader, `${feed}/cal.json`)) ?? []);
  const chunkOf = (feed, c) => load(loader, `${feed}/p${c}.json`);
  const patOf = async (feed, c, p) => (await chunkOf(feed, c))?.[p] ?? null;

  // 停留所ごとに、いちばん近い（歩く時間の短い）乗り場だけを残してパターンを集めます。
  const collect = (stops) => {
    const m = new Map();
    for (const s of stops) {
      for (const [c, p, pos] of s.refs) {
        const k = `${s.feed}:${c}:${p}`;
        const cur = m.get(k) ?? [];
        cur.push({ ...s, c, p, pos });
        m.set(k, cur);
      }
    }
    return m;
  };
  const fromPats = collect(origins);
  const toPats = collect(dests);
  const results = [];

  const walkLeg = (from, to, dep, secs) => ({ vehicle: "walk", from, to, dep, arr: dep + secs, line: "" });
  const rideLeg = (feed, pat, a, b, trip) => ({
    vehicle: pat.v ?? "bus", from: a.name, to: b.name, dep: trip.dep, arr: trip.arr,
    line: lineName(feeds[feed], pat, trip.head), feed,
  });

  // 1本で行ける便
  for (const [k, os] of fromPats) {
    const ds = toPats.get(k);
    if (!ds) continue;
    const [feed, c, p] = k.split(":");
    const pat = await patOf(feed, +c, +p);
    if (!pat) continue;
    const cal = await calOf(feed);
    let best = null;
    for (const o of os) {
      for (const d of ds) {
        if (o.pos >= d.pos) continue;
        const trip = earliestTrip(pat, o.pos, d.pos, now.secs + o.walk, days, cal);
        if (!trip) continue;
        const end = trip.arr + d.walk;
        if (!best || end < best.end) best = { end, o, d, trip };
      }
    }
    if (best) {
      const { o, d, trip } = best;
      results.push({ end: best.end, legs: [
        walkLeg(q.from, o.name, trip.dep - o.walk, o.walk),
        rideLeg(feed, pat, { name: o.name }, { name: d.name }, trip),
        walkLeg(d.name, q.to, trip.arr, d.walk),
      ] });
    }
  }

  // 1回乗り換え（1本で行けないときだけ。CPU を使うため）
  if (!results.length) {
    const firsts = [...fromPats.entries()].slice(0, MAX_PATTERNS);
    const seconds = [...toPats.entries()].slice(0, MAX_PATTERNS);
    const stopsOf = {};
    const stopList = async (feed) => (stopsOf[feed] ??= (await load(loader, `${feed}/stops.json`)) ?? []);
    // 2本目の乗り場：停留所の名前 → [{feed, pat, pos(乗る), dest(降りる情報)}]
    const boardByName = new Map();
    for (const [k, ds] of seconds) {
      const [feed, c, p] = k.split(":");
      const pat = await patOf(feed, +c, +p);
      if (!pat) continue;
      const st = await stopList(feed);
      const d = ds.reduce((a, b) => (a.walk <= b.walk ? a : b));
      for (let j = 0; j < d.pos; j += 1) {
        const s = st[pat.s[j]];
        if (!s) continue;
        const arr = boardByName.get(s[0]) ?? [];
        arr.push({ feed, pat, j, d, stop: pat.s[j], lat: s[1], lng: s[2] });
        boardByName.set(s[0], arr);
      }
    }
    for (const [k, os] of firsts) {
      const [feed, c, p] = k.split(":");
      const pat = await patOf(feed, +c, +p);
      if (!pat) continue;
      const st = await stopList(feed);
      const cal = await calOf(feed);
      const o = os.reduce((a, b) => (a.walk <= b.walk ? a : b));
      // 先に1本目の便を決めます（早く着くほど乗り継ぎも早い）。
      const lastPos = pat.s.length - 1;
      const first = earliestTrip(pat, o.pos, lastPos, now.secs + o.walk, days, cal);
      if (!first) continue;
      for (let i = o.pos + 1; i < pat.s.length; i += 1) {
        const s = st[pat.s[i]];
        if (!s) continue;
        const boards = boardByName.get(s[0]);
        if (!boards) continue;
        const t1 = earliestTrip(pat, o.pos, i, now.secs + o.walk, days, cal);
        if (!t1) continue;
        for (const b of boards) {
          if (b.pat === pat) continue;
          const sameStop = b.feed === feed && b.stop === pat.s[i];
          const gap = sameStop ? 0 : distanceM({ lat: s[1], lng: s[2] }, b);
          if (gap > TRANSFER_RADIUS_M) continue;
          const change = Math.max(MIN_TRANSFER_SECS, walkSecs(gap));
          const t2 = earliestTrip(b.pat, b.j, b.d.pos, t1.arr + change, days, await calOf(b.feed));
          if (!t2) continue;
          const end = t2.arr + b.d.walk;
          if (results.length >= maxResults * 4 && end >= Math.max(...results.map((r) => r.end))) continue;
          const legs = [
            walkLeg(q.from, o.name, t1.dep - o.walk, o.walk),
            rideLeg(feed, pat, { name: o.name }, { name: s[0] }, t1),
          ];
          if (!sameStop) legs.push(walkLeg(s[0], s[0], t1.arr, walkSecs(gap)));
          legs.push(rideLeg(b.feed, b.pat, { name: s[0] }, { name: b.d.name }, t2));
          legs.push(walkLeg(b.d.name, q.to, t2.arr, b.d.walk));
          results.push({ end, legs });
        }
      }
    }
  }

  results.sort((a, b) => a.end - b.end);
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const key = r.legs.filter((l) => l.vehicle !== "walk").map((l) => `${l.dep}/${l.line}`).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    const used = [...new Set(r.legs.map((l) => l.feed).filter(Boolean))];
    out.push({
      legs: r.legs.map(({ dep, arr, feed, ...l }) => ({ ...l, departure: hm(dep), arrival: hm(arr) })),
      attribution: used.map((id) => attributionOf(feeds[id])).join(" / "),
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

/** 答えに添える出典の1行。 */
export function attributionOf(f) {
  if (!f) return "";
  const by = [f.publisher, f.source].filter(Boolean).join("・");
  return `${f.name}（${by ? `${by}、` : ""}${f.license}）`;
}

/** index.json の出典（credits と答えの attribution に使う）。 */
export async function busSources(loader) {
  const index = await load(loader, "index.json");
  return (index?.feeds ?? []).map((f) => ({ id: f.id, name: f.name, license: f.license, publisher: f.publisher, source: f.source }));
}

/** 中継の ASSETS から読む loader（Cloudflare）。 */
export function assetsLoader(env) {
  if (!env?.ASSETS || String(env?.BUS_TIMETABLE ?? "").trim().toLowerCase() === "off") return null;
  return async (path) => {
    const res = await env.ASSETS.fetch(new Request(`https://assets.local${BUS_ASSET_DIR}${path}`));
    if (!res.ok) return null;
    return res.json();
  };
}
