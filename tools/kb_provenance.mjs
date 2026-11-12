#!/usr/bin/env node
// 収録のデータの出どころを、項目ごとに点検する・分けて書き出す（Issue #426）。
//
//   node tools/kb_provenance.mjs                 点検（出どころの分からない項目があれば 1 で終わる）
//   node tools/kb_provenance.mjs --stats         出どころごとの件数と、使っている項目
//   node tools/kb_provenance.mjs --spot <id>     1件を、出どころごとに分けた形で見る
//   node tools/kb_provenance.mjs --split <dir>   kb/ の段を、分けた形にして <dir> に書く（移行）
//   node tools/kb_provenance.mjs --verify <dir>  <dir> を元に戻すと kb/ と同じになるか確かめる
//
// 決まりは packages/core/src/provenance.js にあります。ここは kb/ を読んで
// 当てはめるだけです。kb/ は書き換えません（--split は別の場所に書きます）。
// 移行の手順は docs/data-provenance.md に。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SOURCES, auditSpots, joinSources, licenseSummary, splitBySource,
} from "../packages/core/src/provenance.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** kb/ の段を順に読みます。 */
export function readShards(kbDir = path.join(ROOT, "kb")) {
  const index = JSON.parse(readFileSync(path.join(kbDir, "index.json"), "utf8"));
  return index.shards.map((sh) => ({
    file: sh.file,
    doc: JSON.parse(readFileSync(path.join(kbDir, sh.file), "utf8")),
  }));
}

export function allSpots(kbDir) {
  return readShards(kbDir).flatMap(({ doc }) => (doc.spots ?? []).map(joinSources));
}

/** 段を、出どころごとに分けた形にします（段ごとのまとめも付けます）。 */
export function splitShard(doc) {
  const spots = (doc.spots ?? []).map(joinSources);
  return {
    ...doc,
    license_summary: licenseSummary(spots),
    // 1件ごとのまとめは付けません（段のまとめと同じことの繰り返しで、倍の大きさになります）。
    spots: spots.map((s) => splitBySource(s, { summary: false })),
  };
}

function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const kbDir = arg("--kb") ?? path.join(ROOT, "kb");

  if (argv.includes("--spot")) {
    const id = arg("--spot");
    const hit = allSpots(kbDir).find((s) => s.id === id);
    if (!hit) { console.error(`その id の収録はありません: ${id}`); return 1; }
    console.log(JSON.stringify(splitBySource(hit), null, 2));
    return 0;
  }

  if (argv.includes("--split")) {
    const out = arg("--split");
    if (!out) { console.error("書き出す先を付けてください: --split <dir>"); return 1; }
    if (path.resolve(out) === path.resolve(kbDir)) { console.error("kb/ そのものには書きません。別の場所を指定してください"); return 1; }
    mkdirSync(out, { recursive: true });
    let n = 0;
    for (const { file, doc } of readShards(kbDir)) {
      const next = splitShard(doc);
      writeFileSync(path.join(out, file), JSON.stringify(next));
      n += next.spots.length;
    }
    console.log(`${n} 件を、出どころごとに分けて ${out} に書きました。確かめるには --verify ${out}`);
    return 0;
  }

  if (argv.includes("--verify")) {
    const dir = arg("--verify");
    let n = 0;
    for (const { file, doc } of readShards(kbDir)) {
      const other = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
      const back = (other.spots ?? []).map(joinSources);
      const want = (doc.spots ?? []).map(joinSources);
      if (!isDeepStrictEqual(back, want)) { console.error(`${file}: 元に戻すと kb/ と違います`); return 1; }
      n += back.length;
    }
    console.log(`${n} 件、元に戻すと kb/ と同じです`);
    return 0;
  }

  const spots = allSpots(kbDir);
  const audit = auditSpots(spots);
  if (argv.includes("--stats")) {
    const sum = licenseSummary(spots);
    for (const s of sum.sources) {
      console.log(`${s.id.padEnd(18)} ${String(s.spots).padStart(6)} 件  ${s.license}${s.shareAlike ? "（継承あり）" : ""}`);
      console.log(`  ${s.fields.join(" ")}`);
    }
    console.log(`\n書くべき表記:\n  ${sum.attribution.join("\n  ")}`);
  }
  if (audit.problems.length) {
    console.error(audit.problems.join("\n"));
    console.error(`\n出どころを追えない項目があります。packages/core/src/provenance.js の決まりに足してください`);
    return 1;
  }
  const known = Object.keys(audit.bySource).filter((id) => !SOURCES[id]);
  if (known.length) { console.error(`台帳に無い出どころ: ${known.join(", ")}`); return 1; }
  console.log(`${audit.spots} 件、どの項目も出どころを追えます（出どころ ${Object.keys(audit.bySource).length} 種）`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main(process.argv.slice(2)));
}
