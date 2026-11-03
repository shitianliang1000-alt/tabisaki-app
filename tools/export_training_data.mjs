#!/usr/bin/env node
// 自前のモデルを育てるための学習データ（JSONL）を、収録（kb/）から書き出します。
//
//   node tools/export_training_data.mjs                 # .tabisaki/training/ に書く
//   node tools/export_training_data.mjs --out=dir       # 書く場所
//   node tools/export_training_data.mjs --no-plans      # 旅程の例を作らない（速い）
//   node tools/export_training_data.mjs --with-cc-by-sa # Wikipedia 由来（CC BY-SA）も入れる
//   node tools/export_training_data.mjs --with-odbl     # OpenStreetMap 由来（ODbL）も入れる
//   node tools/export_training_data.mjs --verify=any    # 裏取りの済んでいないものも入れる
//
// 書くもの
//   train.jsonl     学習用。1行 = {"messages":[…], "meta":{…}}（Hugging Face の TRL・Unsloth がそのまま読む形）
//   eval.jsonl      評価用（スポット単位で約5%。学習用と同じ場所は入りません）
//   manifest.json   何を何件入れ、何を何件、なぜ外したか
//
// **ライセンスで外すもの（既定）**。くわしくは docs/own-model.md の「学習に使ってよいデータ」。
//   国土数値情報（src=kokudo、文化施設 P27）   非商用・再配布不可。学習にも使いません
//   座標つき観光地一覧（src=tourlist-geocoded） 座標の9割が Yahoo! の API。保存・再配布の可否が未確認
//   OpenStreetMap（src=osm-tourlist）           ODbL（share-alike）。--with-odbl で入れられます
//   Wikipedia（src=wikipedia*・説明文）         CC BY-SA。--with-cc-by-sa で入れられます
//   出どころ不明（src=opendata）                 条件が分からないので入れません
//
// 通信はしません。kb/ が同じなら、何度走らせても同じ中身になります（日時は manifest だけ）。

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KB = path.join(ROOT, "kb");

export const EXPORT_VERSION = 1;

// --- ライセンスの仕分け ------------------------------------------------------

/**
 * スポット1件の出どころから、学習に使ってよいかの区分を返します。
 * @returns {{group: string, license: string, source: string}}
 */
export function licenseOf(spot) {
  const src = String(spot?.src ?? "");
  if (spot?.dataSource || src === "kokudo") {
    return { group: "kokudo-noncommercial", license: "国土数値情報（非商用）", source: src || "kokudo-p27" };
  }
  if (src === "tourlist-geocoded") return { group: "yahoo-unclear", license: "未確認（Yahoo! JAPAN の座標を含む）", source: src };
  if (src === "osm-tourlist") return { group: "odbl", license: "ODbL-1.0", source: src };
  if (src === "wikipedia" || src === "wikipedia-tourlist") return { group: "cc-by-sa", license: "CC-BY-SA-4.0", source: src };
  if (src === "wikidata") return { group: "cc0", license: "CC0-1.0", source: src };
  if (src === "overture-tourlist") {
    const lic = String(spot?.license ?? "");
    if (/^(CDLA-Permissive-2\.0|Apache-2\.0)$/.test(lic)) return { group: "permissive", license: lic, source: src };
    return { group: "unknown", license: lic || "不明", source: src };
  }
  if (!src) return { group: "project", license: "旅さきの収録データ", source: "curated" };
  return { group: "unknown", license: "不明", source: src };
}

/** 既定で学習に入れる区分。 */
export const DEFAULT_GROUPS = ["cc0", "project", "permissive"];

/** 裏取り（kb/verification-*.json・kb/verification.json）の状態を、3段に分けます。 */
export function verifyLevel(status) {
  const s = String(status ?? "");
  if (s.startsWith("verified")) return "verified";
  if (s === "name_match_high") return "high";
  if (!s) return "none";
  return "low";
}

const VERIFY_ACCEPT = {
  verified: new Set(["verified"]),
  high: new Set(["verified", "high"]),
  any: new Set(["verified", "high", "low", "none"]),
};

// --- 読み込み ----------------------------------------------------------------

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

export function loadKb(kbDir = KB) {
  const index = readJson(path.join(kbDir, "index.json"));
  const regions = new Map(readJson(path.join(kbDir, "regions.json")).regions.map((r) => [r.id, r]));
  const verify = new Map();
  for (const sh of index.shards) {
    const vf = path.join(kbDir, sh.file.replace(/^spots-/, "verification-"));
    try {
      for (const [id, r] of Object.entries(readJson(vf).records ?? {})) verify.set(id, r);
    } catch { /* 無い県もあります */ }
  }
  // 個別に調べた記録（kb/verification.json）が後勝ちです。
  try {
    for (const [id, r] of Object.entries(readJson(path.join(kbDir, "verification.json")).records ?? {})) verify.set(id, r);
  } catch { /* 無くても動きます */ }
  const spots = [];
  for (const sh of index.shards) {
    for (const s of readJson(path.join(kbDir, sh.file)).spots ?? []) {
      spots.push({ ...s, prefecture: s.prefecture ?? regions.get(s.regionId)?.prefecture ?? sh.prefecture });
    }
  }
  const hash = createHash("sha256");
  for (const sh of index.shards) hash.update(readFileSync(path.join(kbDir, sh.file)));
  return { spots, regions, verify, kbHash: hash.digest("hex").slice(0, 16) };
}

// --- 例の作りかた ------------------------------------------------------------

const TAG_LABEL = {
  world_heritage: "世界遺産", autumn_foliage: "紅葉の名所", cherry_blossom: "桜の名所",
  night_view: "夜景", onsen: "温泉", rainy_ok: "雨の日でも楽しめる",
};

/** 1件のスポットについての「事実の答え」。収録にある値だけで書きます（推測で足しません）。 */
export function spotAnswer(spot, region, { withText = false } = {}) {
  const where = region?.name && region.name !== spot.prefecture
    ? `${spot.prefecture}の「${region.name}」エリア` : spot.prefecture;
  const lines = [`${spot.name}は、${where}にある${spot.category ?? "観光地"}です。`];
  const tags = (spot.tags ?? []).map((t) => TAG_LABEL[t]).filter(Boolean);
  if (tags.length) lines.push(`${tags.join("・")}として知られています。`);
  for (const s of spot.season ?? []) {
    if (s?.label && s.from && s.to) lines.push(`${s.label}の見ごろはおよそ${md(s.from)}〜${md(s.to)}です。`);
  }
  if (Number.isFinite(spot.open) && Number.isFinite(spot.close) && !(spot.open === 0 && spot.close === 24)) {
    lines.push(`開いている時間の目安は${spot.open}時〜${spot.close}時です。`);
  }
  if (Number.isFinite(spot.fee)) lines.push(spot.fee === 0 ? "入るのにお金はかかりません（目安）。" : `入場料の目安は${spot.fee}円です。`);
  if (withText && spot.description) lines.push(spot.description);
  lines.push("最新の営業時間や料金は、出かける前に公式の案内で確かめてください。");
  return lines.join("");
}

const md = (s) => { const [m, d] = String(s).split("-").map(Number); return `${m}月${d}日`; };

const ASK = [
  (n) => `「${n}」ってどんなところ？`,
  (n) => `${n}はどこにありますか。`,
  (n) => `${n}について教えてください。`,
];

/** 文字列から 0〜1 の決まった数（分け方と言い回しを毎回同じにするため）。 */
export function unit(key) {
  return createHash("sha1").update(String(key)).digest().readUInt32BE(0) / 2 ** 32;
}

export function isEval(key, rate = 0.05) { return unit(`split:${key}`) < rate; }

function metaOf(task, spots, extra = {}) {
  return {
    task,
    spotIds: spots.map((s) => s.id),
    sources: [...new Set(spots.map((s) => s._lic.source))],
    licenses: [...new Set(spots.map((s) => s._lic.license))],
    verified: spots.map((s) => s._verify),
    ...extra,
  };
}

const msg = (user, assistant) => [{ role: "user", content: user }, { role: "assistant", content: assistant }];

/** 収録に無い名前を聞かれたときの答え（作り話をしない練習）。 */
export const UNKNOWN_ANSWER = (n) => `「${n}」は、旅さきの収録には見つかりませんでした。確かめられない場所について、`
  + "場所や見どころを作って答えることはしません。名前の書きかたを変えるか、近くの地名で聞いてみてください。";

const FAKE_SUFFIX = ["天空神社", "七色滝", "月見ヶ原高原", "星降り洞窟", "虹の大橋公園", "風見城跡"];

// --- 本体 ----------------------------------------------------------------------

export async function buildDataset({
  kb = loadKb(), groups = DEFAULT_GROUPS, verify = "verified", withText = false, plans = true,
  planRequests = [], core = null, evalRate = 0.05,
} = {}) {
  const accept = VERIFY_ACCEPT[verify] ?? VERIFY_ACCEPT.verified;
  const allowed = new Set(groups);
  const excluded = {};
  const kept = [];
  const byId = new Map();
  for (const s of kb.spots) {
    const lic = licenseOf(s);
    const v = verifyLevel(kb.verify.get(s.id)?.status);
    if (!allowed.has(lic.group)) { excluded[`license:${lic.group}`] = (excluded[`license:${lic.group}`] ?? 0) + 1; continue; }
    if (!accept.has(v)) { excluded[`verify:${v}`] = (excluded[`verify:${v}`] ?? 0) + 1; continue; }
    const spot = { ...s, _lic: lic, _verify: v };
    kept.push(spot);
    byId.set(s.id, spot);
  }
  // Wikipedia 由来の説明文は、CC BY-SA を入れるときだけ使います。
  const textOk = withText && allowed.has("cc-by-sa");

  const train = [];
  const evalSet = [];
  const put = (key, row) => (isEval(key, evalRate) ? evalSet : train).push(row);

  // 1) スポットの事実
  for (const s of kept) {
    const ask = ASK[Math.floor(unit(`ask:${s.id}`) * ASK.length)](s.name);
    put(s.id, { messages: msg(ask, spotAnswer(s, kb.regions.get(s.regionId), { withText: textOk })), meta: metaOf("spot_fact", [s]) });
  }

  // 2) エリアの中の場所（有名な順に8件まで。評価用に回った場所は使いません）
  const byRegion = new Map();
  for (const s of kept) {
    if (isEval(s.id, evalRate)) continue;
    if (!byRegion.has(s.regionId)) byRegion.set(s.regionId, []);
    byRegion.get(s.regionId).push(s);
  }
  const TIER = { major: 0, known: 1, local: 2 };
  for (const [rid, list] of byRegion) {
    const region = kb.regions.get(rid);
    if (!region?.name || list.length < 3) continue;
    const top = [...list].sort((a, b) => (TIER[a.fame_tier] ?? 3) - (TIER[b.fame_tier] ?? 3) || a.id.localeCompare(b.id)).slice(0, 8);
    const head = region.tagline ? `${region.name}（${region.prefecture}）は「${region.tagline}」です。` : `${region.name}（${region.prefecture}）で、旅さきに収録している主な場所です。`;
    const body = top.map((s) => `・${s.name}（${s.category ?? "観光地"}）`).join("\n");
    train.push({ messages: msg(`${region.name}で行ける場所を教えて。`, `${head}\n${body}`), meta: metaOf("area_list", top, { regionId: rid }) });
  }

  // 3) 収録に無い場所（作り話をしない）
  const names = new Set(kb.spots.map((s) => s.name));
  let fakes = 0;
  for (const region of [...kb.regions.values()].filter((r) => unit(`fake:${r.id}`) < 0.06)) {
    const n = `${region.name}${FAKE_SUFFIX[Math.floor(unit(`fs:${region.id}`) * FAKE_SUFFIX.length)]}`;
    if (names.has(n)) continue;
    fakes++;
    put(`fake:${region.id}`, { messages: msg(ASK[fakes % ASK.length](n), UNKNOWN_ANSWER(n)), meta: { task: "unknown_place", spotIds: [], sources: [], licenses: [], verified: [] } });
  }

  // 4) 旅程（プログラムが組んだものを、そのまま手本にします。外した出どころの場所が1つでも入れば、使いません）
  let planSkipped = 0;
  if (plans && core) {
    for (const req of planRequests) {
      const { id, ...body } = req;
      let itinerary;
      try { ({ itinerary } = await core.plan(body)); } catch { planSkipped++; continue; }
      const items = itinerary.days.flatMap((d, di) => (d.items ?? []).map((it) => ({ ...it, day: di + 1 })));
      const spotItems = items.filter((i) => i.kind === "spot");
      const used = spotItems.map((i) => byId.get(i.spotId));
      if (!spotItems.length || used.some((s) => !s)) { planSkipped++; continue; }
      const lines = [];
      let day = 0;
      for (const it of spotItems) {
        if (it.day !== day) { day = it.day; lines.push(`${day}日目`); }
        lines.push(`・${jst(it.start)} ${it.title}`);
      }
      const ask = `${body.from}から${body.days}日で「${body.wish}」。${body.date}、${body.start}出発・${body.back}までに戻りたい。`;
      const answer = `${itinerary.regionName ?? ""}を中心に組みました。\n${lines.join("\n")}\n移動の時間は目安です。乗る便は出かける前に確かめてください。`;
      put(`plan:${id}`, { messages: msg(ask, answer), meta: metaOf("itinerary", used, { requestId: id }) });
    }
  }

  return {
    train, eval: evalSet,
    manifest: {
      version: EXPORT_VERSION,
      kbHash: kb.kbHash,
      options: { groups, verify, withText: textOk, plans: Boolean(plans && core), evalRate },
      counts: {
        spotsInKb: kb.spots.length, spotsUsed: kept.length, train: train.length, eval: evalSet.length,
        byTask: countBy([...train, ...evalSet], (r) => r.meta.task),
        byLicense: countBy(kept, (s) => s._lic.license),
        byVerify: countBy(kept, (s) => s._verify),
        unknownPlace: fakes, plansSkipped: planSkipped,
      },
      excluded,
      note: "manifest の excluded は、ライセンス・裏取りで外した件数です。docs/own-model.md を見てください。",
    },
  };
}

const countBy = (list, key) => list.reduce((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});

function jst(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

// --- 走らせる ------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const has = (name) => args.includes(`--${name}`);
  const out = path.resolve(opt("out") ?? path.join(ROOT, ".tabisaki", "training"));
  const groups = [...DEFAULT_GROUPS];
  if (has("with-cc-by-sa")) groups.push("cc-by-sa");
  if (has("with-odbl")) groups.push("odbl");
  let core = null;
  let planRequests = [];
  if (!has("no-plans")) {
    const bench = await import(pathToFileURL(path.join(ROOT, "tools", "plan_bench.mjs")).href);
    const { createCore } = await import(pathToFileURL(path.join(ROOT, "packages", "core", "index.mjs")).href);
    core = await createCore();
    planRequests = [...bench.loadFixedRequests(), ...bench.randomRequests(Number(opt("seed") ?? 7001), Number(opt("plans") ?? 120))];
  }
  const ds = await buildDataset({ groups, verify: opt("verify") ?? "verified", withText: has("with-cc-by-sa"), core, planRequests });
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "train.jsonl"), toJsonl(ds.train));
  writeFileSync(path.join(out, "eval.jsonl"), toJsonl(ds.eval));
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ ...ds.manifest, generatedAt: new Date().toISOString() }, null, 1) + "\n");
  console.log(`${out} に書きました: 学習 ${ds.train.length} 行・評価 ${ds.eval.length} 行（スポット ${ds.manifest.counts.spotsUsed} / ${ds.manifest.counts.spotsInKb} 件を使用）`);
  console.log("外した件数:", ds.manifest.excluded);
}
