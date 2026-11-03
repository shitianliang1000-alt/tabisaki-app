// 全スポットの実在確認（設計ドキュメント §3.3 の自動充実パイプラインの検証部分）。
//
// 第1段: kb の wikipedia フィールド（記事タイトル）を Wikipedia API で一括照合し、
//        記事の有無・概要文・座標を取得する。座標が kb と大きくずれるスポットは
//        「座標の食い違い」として記録する。
// 第2段: wikipedia フィールドの無いスポットを名前で検索し、候補記事との
//        名前一致・座標近接から確度（high / medium / none）を付ける。
//        名前だけの照合は同名の別物を拾いうるため、断定ではなく確度で表す。
//
// 使い方:
//   node tools/verify_spots.mjs --stage a --out ~/workspace/tabisaki-verification
//   node tools/verify_spots.mjs --stage b --out ~/workspace/tabisaki-verification
// 第2段は再開可能（out/stage-b-progress.jsonl に処理済みを追記していく）。
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://ja.wikipedia.org/w/api.php";
const UA = "tabisaki-kb-verifier/1.0 (spot existence verification; contact: repo owner)";

export const MISMATCH_M = 2000; // これより離れていたら座標の食い違いとみなす

/** 2点間の距離（m）。 */
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

async function apiGet(params, tries = 3) {
  const url = `${API}?${new URLSearchParams({ format: "json", maxlag: "5", ...params })}`;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20000), // 応答が止まった接続で全体が固まらないように
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error?.code === "maxlag") throw new Error("maxlag");
      return data;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1) ** 2));
    }
  }
  throw new Error("unreachable");
}

export function loadAllSpots(kbDir) {
  const index = JSON.parse(readFileSync(path.join(kbDir, "index.json"), "utf8"));
  const spots = [];
  for (const shard of index.shards) {
    const data = JSON.parse(readFileSync(path.join(kbDir, shard.file), "utf8"));
    for (const s of data.spots ?? []) spots.push({ ...s, _shard: shard.file });
  }
  return spots;
}

/** タイトル群を50件ずつ照合し、タイトル→{exists, extract, lat, lng} を返す。
 *  onBatch(batchResultMap) があればバッチごとに呼ぶ（途中結果の保存用）。 */
export async function verifyTitles(titles, onProgress = () => {}, onBatch = null) {
  const result = new Map();
  const resolve = (q, title) => {
    const alias = new Map();
    for (const n of q.normalized ?? []) alias.set(n.from, n.to);
    for (const r of q.redirects ?? []) alias.set(r.from, r.to);
    let resolved = title, guard = 0;
    while (alias.has(resolved) && guard++ < 5) resolved = alias.get(resolved);
    return resolved;
  };
  // 第1パス: 座標だけの軽い照合で「ある/ない」と位置を確定する。
  // （概要文まで一括で取ると応答が重く、特定のバッチで極端に遅くなるため分離）
  const batches = [];
  for (let i = 0; i < titles.length; i += 50) batches.push(titles.slice(i, i + 50));
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    let data;
    try {
      data = await apiGet({ action: "query", prop: "coordinates", colimit: "max", titles: batch.join("|") });
    } catch (e) {
      // バッチ単位で諦めて次へ進む。未照合分は進捗ファイルに残らないので、
      // 次回の実行で自動的に再試行される。
      console.error(`  バッチ ${bi + 1} をスキップ（${String(e).slice(0, 60)}）`);
      continue;
    }
    const q = data.query ?? {};
    const pages = new Map();
    for (const p of Object.values(q.pages ?? {})) pages.set(p.title, p);
    for (const title of batch) {
      const resolved = resolve(q, title);
      const page = pages.get(resolved);
      if (!page || "missing" in page) {
        result.set(title, { exists: false });
      } else {
        const coord = page.coordinates?.[0];
        result.set(title, { exists: true, resolvedTitle: resolved, extract: "", lat: coord?.lat, lng: coord?.lon });
      }
    }
    if (onBatch) onBatch(new Map(batch.map((t) => [t, result.get(t)])));
    onProgress(bi + 1, batches.length);
    await new Promise((r) => setTimeout(r, 110));
  }
  // 第2パス: 存在した記事だけ概要文を取りに行く（20件ずつ）。
  const existing = titles.filter((t) => result.get(t)?.exists);
  const exBatches = [];
  for (let i = 0; i < existing.length; i += 20) exBatches.push(existing.slice(i, i + 20));
  for (const batch of exBatches) {
    let data;
    try {
      data = await apiGet({
        action: "query", prop: "extracts", exintro: "1", explaintext: "1",
        exchars: "600", titles: batch.map((t) => result.get(t).resolvedTitle ?? t).join("|"),
      });
    } catch {
      continue; // 概要が取れなくても実在確認の結果は保持する
    }
    const q = data.query ?? {};
    const pages = new Map();
    for (const p of Object.values(q.pages ?? {})) pages.set(p.title, p);
    const sub = new Map();
    for (const title of batch) {
      const rec = result.get(title);
      const page = pages.get(rec.resolvedTitle ?? title);
      if (page?.extract) {
        rec.extract = page.extract.replace(/\s+/g, " ").trim().slice(0, 400);
        sub.set(title, rec);
      }
    }
    if (onBatch && sub.size) onBatch(sub);
    await new Promise((r) => setTimeout(r, 110));
  }
  return result;
}

/** スポットと Wikipedia 座標から検証レコードを作る。 */
export function recordFor(spot, wiki) {
  if (!wiki) return { id: spot.id, status: "no_reference" };
  if (!wiki.exists) return { id: spot.id, status: "not_found", wikiTitle: spot.wikipedia };
  const rec = { id: spot.id, status: "verified", wikiTitle: wiki.resolvedTitle ?? spot.wikipedia };
  if (Number.isFinite(wiki.lat) && Number.isFinite(spot.lat)) {
    rec.coordDistanceM = haversineM(spot.lat, spot.lng, wiki.lat, wiki.lng);
    if (rec.coordDistanceM > MISMATCH_M) rec.coordMismatch = true;
  }
  return rec;
}

/** 第2段の名前照合の確度判定（純関数）。 */
export function confidenceOf(spot, hit) {
  if (!hit) return "none";
  const name = spot.name ?? "";
  const titleHit = hit.title.includes(name) || name.includes(hit.title);
  const coord = hit.lat != null && Number.isFinite(spot.lat)
    ? haversineM(spot.lat, spot.lng, hit.lat, hit.lng) : null;
  if (titleHit && coord != null && coord <= 1000) return "high";
  if (titleHit) return "medium";
  if (coord != null && coord <= 500) return "medium";
  return "none";
}

async function stageA(kbDir, outDir) {
  const spots = loadAllSpots(kbDir);
  const withWiki = spots.filter((s) => s.wikipedia);
  const titles = [...new Set(withWiki.map((s) => s.wikipedia))];
  console.log(`対象スポット ${withWiki.length} 件 / ユニークタイトル ${titles.length} 件`);
  // 再開可能にするため、バッチ結果を JSONL に追記保存する
  const progressFile = path.join(outDir, "stage-a-progress.jsonl");
  const wiki = new Map();
  if (existsSync(progressFile)) {
    for (const line of readFileSync(progressFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); wiki.set(o.title, o.wiki); } catch { /* 壊れた行は無視 */ }
    }
  }
  const remaining = titles.filter((t) => !wiki.has(t));
  console.log(`照合済み ${wiki.size} 件 / 残り ${remaining.length} 件`);
  const fresh = await verifyTitles(remaining, (done, all) => {
    if (done % 20 === 0 || done === all) console.log(`  照合 ${done}/${all} バッチ`);
  }, (sub) => {
    for (const [title, w] of sub) {
      wiki.set(title, w);
      appendFileSync(progressFile, JSON.stringify({ title, wiki: w }) + "\n");
    }
  });
  for (const [t, w] of fresh) wiki.set(t, w);
  const stillMissing = titles.filter((t) => !wiki.has(t));
  if (stillMissing.length) {
    console.log(`未照合 ${stillMissing.length} 件が残りました。再実行すると続きから処理します`);
    return;
  }
  const info = {};
  for (const [title, w] of wiki) if (w.exists) info[title] = w;
  writeFileSync(path.join(outDir, "wiki-info.json"), JSON.stringify(info));
  const records = spots.map((s) => recordFor(s, s.wikipedia ? wiki.get(s.wikipedia) : null));
  writeFileSync(path.join(outDir, "verification-stage-a.json"), JSON.stringify(records));
  const counts = {};
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const mismatches = records.filter((r) => r.coordMismatch);
  console.log("状態別:", JSON.stringify(counts), "/ 座標の食い違い:", mismatches.length);
}

async function stageB(kbDir, outDir) {
  // 手作業で確認済みのスポット（kb/verification.json）は対象外
  const verifiedIds = new Set();
  try {
    const v = JSON.parse(readFileSync(path.join(kbDir, "verification.json"), "utf8"));
    for (const id of Object.keys(v.records ?? {})) verifiedIds.add(id);
  } catch { /* 記録ファイルが無ければ全件対象 */ }
  const spots = loadAllSpots(kbDir).filter((s) => !s.wikipedia && !verifiedIds.has(s.id));
  const progressFile = path.join(outDir, "stage-b-progress.jsonl");
  const doneIds = new Set();
  if (existsSync(progressFile)) {
    for (const line of readFileSync(progressFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      // エラー（429等）のレコードは「済み」に数えない（次回に再試行する）
      try { const o = JSON.parse(line); if (o.status !== "error") doneIds.add(o.id); } catch { /* 壊れた行は無視 */ }
    }
  }
  // 有名なスポットから先に照合する（無名スポットは記事が無いことが多く、後回しでよい）
  const todo = spots.filter((s) => !doneIds.has(s.id))
    .sort((a, b) => (b.fame_score ?? 0) - (a.fame_score ?? 0));
  console.log(`対象 ${spots.length} 件 / 済み ${doneIds.size} 件 / 残り ${todo.length} 件`);
  let n = 0, cursor = 0;
  const queryCache = new Map(); // 同じ「名前＋都道府県」の検索は1回だけにする
  const processOne = async (spot) => {
    let rec;
    try {
      const q = `${spot.name} ${spot.prefecture ?? ""}`;
      let data = queryCache.get(q);
      if (!data) {
        data = await apiGet({
          action: "query", generator: "search", gsrsearch: q,
          gsrnamespace: "0", gsrlimit: "3", prop: "coordinates", colimit: "max",
        }, 6); // 429 のときは長めのバックオフで粘る
        queryCache.set(q, data);
      }
      const pages = Object.values(data.query?.pages ?? {})
        .sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
      const hit = pages[0]
        ? { title: pages[0].title, lat: pages[0].coordinates?.[0]?.lat, lng: pages[0].coordinates?.[0]?.lon }
        : null;
      const conf = confidenceOf(spot, hit);
      rec = { id: spot.id, status: conf === "none" ? "unresolved" : "name_match",
              confidence: conf, candidate: hit?.title ?? null };
    } catch (e) {
      rec = { id: spot.id, status: "error", error: String(e).slice(0, 80) };
    }
    appendFileSync(progressFile, JSON.stringify(rec) + "\n");
    if (++n % 200 === 0) console.log(`  処理 ${n}/${todo.length}`);
  };
  // 並列度を上げすぎると共有IPが 429 を返し始めるため、2本×約0.9秒間隔に保つ
  const worker = async () => {
    while (cursor < todo.length) {
      const spot = todo[cursor++];
      await processOne(spot);
      await new Promise((r) => setTimeout(r, 900));
    }
  };
  await Promise.all([worker(), worker()]);
  console.log("第2段 完了");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const stage = args[args.indexOf("--stage") + 1];
  const outDir = args[args.indexOf("--out") + 1] ?? "verification-out";
  mkdirSync(outDir, { recursive: true });
  const kbDir = path.join(ROOT, "kb");
  if (stage === "a") await stageA(kbDir, outDir);
  else if (stage === "b") await stageB(kbDir, outDir);
  else { console.error("--stage a|b が必要です"); process.exit(1); }
}
