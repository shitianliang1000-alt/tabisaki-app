// 国土数値情報の非商用データを、公開する kb/ から外して kb-private/ に移す道具。
//
// 2026-11-03 の方針（docs/kokudo-licenses.md）: 非商用のデータの JSON は公開しない。
// 外すもの
//   観光資源 P12（src="kokudo"）        kb/spots-jp*.json の中の該当スポット
//   文化施設 P27（dataSource=…P27…）    同上
//   バス停留所 P11                      kb/stops-bus.json と kb/stops-bus/
// 外したスポットのタグ（tags-*）と裏取りの記録（verification-*）も一緒に移します。
//
// kb-private/ は .gitignore してあり、リポジトリ・サイト・PHP 版の zip・アプリには入りません。
// データは消しません。手元での学習や確かめには kb-private/ のほうを読みます。
//
//     node tools/split_noncommercial.mjs            数えるだけ
//     node tools/split_noncommercial.mjs --write    kb/ から外して kb-private/ に移す
//
// 戻すとき（手元で全部そろえて試したいとき）は --restore。**戻したまま commit しないでください**
// （tests/noncommercial.test.js が止めます）。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const KB = join(ROOT, "kb");
const PRIVATE = join(ROOT, "kb-private");
const dump = (obj) => JSON.stringify(obj);
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** 公開しないデータか（P12・P27）。 */
export function isNoncommercialSpot(s) {
  return s?.src === "kokudo" || /P27|文化施設/.test(String(s?.dataSource ?? ""));
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const restore = args.includes("--restore");

const files = readdirSync(KB).filter((f) => /^spots-jp.*\.json$/.test(f)).sort();

if (restore) {
  const saved = read(join(PRIVATE, "spots-noncommercial.json"));
  for (const [file, spots] of Object.entries(saved.shards)) {
    const doc = read(join(KB, file));
    const have = new Set(doc.spots.map((s) => s.id));
    doc.spots.push(...spots.filter((s) => !have.has(s.id)));
    writeFileSync(join(KB, file), dump(doc));
    for (const [kind, recs] of [["tags", saved.tags?.[file]], ["verification", saved.verification?.[file]]]) {
      if (!recs) continue;
      const p = join(KB, file.replace(/^spots-/, `${kind}-`));
      const d = read(p);
      Object.assign(kind === "tags" ? d.tags : d.records, recs);
      writeFileSync(p, dump(d));
    }
  }
  const vRecs = saved.verification?.["verification.json"];
  if (vRecs) {
    const p = join(KB, "verification.json");
    const d = read(p);
    Object.assign(d.records, vRecs);
    writeFileSync(p, JSON.stringify(d, null, 1) + "\n");
  }
  if (existsSync(join(PRIVATE, "stops-bus.json"))) cpSync(join(PRIVATE, "stops-bus.json"), join(KB, "stops-bus.json"));
  if (existsSync(join(PRIVATE, "stops-bus"))) cpSync(join(PRIVATE, "stops-bus"), join(KB, "stops-bus"), { recursive: true });
  recount();
  console.log("kb/ に戻しました。**この状態で commit しないでください。** 外し直すには --write。");
  process.exit(0);
}

const shards = new Map(files.map((f) => [f, read(join(KB, f))]));
const moved = {};
let n = 0;
let p12 = 0;
for (const [file, doc] of shards) {
  const out = doc.spots.filter(isNoncommercialSpot);
  if (!out.length) continue;
  moved[file] = out;
  n += out.length;
  p12 += out.filter((s) => s.src === "kokudo").length;
}
const busThere = existsSync(join(KB, "stops-bus.json")) || existsSync(join(KB, "stops-bus"));
console.log(`公開しないスポット ${n}件（観光資源 P12 ${p12}件・文化施設 P27 ${n - p12}件）、バス停 P11 ${busThere ? "あり" : "なし（外し済み）"}`);

if (!write) {
  if (n || busThere) console.log("--write を付けると kb-private/ に移します。");
  process.exit(0);
}

mkdirSync(PRIVATE, { recursive: true });
const savedPath = join(PRIVATE, "spots-noncommercial.json");
const saved = existsSync(savedPath) ? read(savedPath) : { version: 1, note: "", shards: {}, tags: {}, verification: {} };
saved.note = "国土数値情報（非商用）。公開しないこと（docs/kokudo-licenses.md）。tools/split_noncommercial.mjs が作ります。";
for (const [file, spots] of Object.entries(moved)) {
  const ids = new Set(spots.map((s) => s.id));
  const keep = (saved.shards[file] ?? []).filter((s) => !ids.has(s.id));
  saved.shards[file] = [...keep, ...spots];
  const doc = shards.get(file);
  doc.spots = doc.spots.filter((s) => !ids.has(s.id));
  writeFileSync(join(KB, file), dump(doc));
  for (const kind of ["tags", "verification"]) {
    const p = join(KB, file.replace(/^spots-/, `${kind}-`));
    if (!existsSync(p)) continue;
    const d = read(p);
    const box = kind === "tags" ? d.tags : d.records;
    const out = {};
    for (const id of ids) if (id in box) { out[id] = box[id]; delete box[id]; }
    saved[kind][file] = { ...(saved[kind][file] ?? {}), ...out };
    writeFileSync(p, dump(d));
  }
}
// 個別に調べた記録（kb/verification.json）からも外します。
const vAll = join(KB, "verification.json");
if (existsSync(vAll)) {
  const all = new Set(Object.values(saved.shards).flat().map((s) => s.id));
  const d = read(vAll);
  const out = {};
  for (const id of Object.keys(d.records ?? {})) if (all.has(id)) { out[id] = d.records[id]; delete d.records[id]; }
  if (Object.keys(out).length) {
    saved.verification["verification.json"] = { ...(saved.verification["verification.json"] ?? {}), ...out };
    writeFileSync(vAll, JSON.stringify(d, null, 1) + "\n");
  }
}
writeFileSync(savedPath, dump(saved));

for (const name of ["stops-bus.json", "stops-bus"]) {
  const from = join(KB, name);
  if (!existsSync(from)) continue;
  const to = join(PRIVATE, name);
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
}
recount();
console.log(`kb-private/ に移しました（スポット ${n}件とバス停）。`);

/** 件数（index.json・regions.json）と名前の索引（names.json）を作り直します。drop_not_spots.mjs と同じ作り。 */
function recount() {
  const docs = new Map(files.map((f) => [f, read(join(KB, f))]));
  const all = [...docs.values()].flatMap((d) => d.spots);
  const perRegion = new Map();
  for (const s of all) perRegion.set(s.regionId, (perRegion.get(s.regionId) ?? 0) + 1);
  const regionsPath = join(KB, "regions.json");
  const regions = read(regionsPath);
  for (const r of regions.regions) if ("spotCount" in r) r.spotCount = perRegion.get(r.id) ?? 0;
  writeFileSync(regionsPath, dump(regions));
  const indexPath = join(KB, "index.json");
  const index = read(indexPath);
  for (const sh of index.shards ?? []) {
    const doc = docs.get(sh.file);
    if (!doc) continue;
    sh.count = doc.spots.length;
    sh.regions = [...new Set(doc.spots.map((s) => s.regionId).filter(Boolean))].sort();
  }
  if (index.counts) index.counts.spots = all.length;
  writeFileSync(indexPath, dump(index));
  const seen = new Set();
  const names = [];
  for (const s of all) if (s.name && !seen.has(s.name)) { seen.add(s.name); names.push(s.name); }
  writeFileSync(join(KB, "names.json"), dump({ names: names.join("\n") }));
}
