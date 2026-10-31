// kb 全スポットへの fetchedAt（確認日）付与ツール。
//
// 背景: js/confidence.js・js/ui.js・admin/kbcheck.js は spot.fetchedAt（epoch ms）を
// 使って「最終確認 YYYY-MM-DD」を表示するが、kb の実データには fetchedAt が
// 1件も無く、鮮度表示が機能していなかった（設計ドキュメント §1.2 / Issue #421）。
//
// 使い方:
//   node tools/stamp_fetched_at.mjs              付与状況のレポートのみ
//   node tools/stamp_fetched_at.mjs --write      不足分に今日の日付を付与
//   node tools/stamp_fetched_at.mjs --write --date 2026-10-31
//   node tools/stamp_fetched_at.mjs --write --from-git
//        シャードごとに git の最終コミット日時をそのシャードの確認日として使う
//
// 既存の fetchedAt は上書きしない（再確認したスポットだけを個別に更新する想定）。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** spots 配列のうち fetchedAt が有限数でない件数を数える。 */
export function countMissing(spots) {
  let missing = 0;
  for (const s of spots) if (!Number.isFinite(s.fetchedAt)) missing++;
  return missing;
}

/** fetchedAt が無いスポットに dateMs を付与した新しい配列を返す（既存値は保持）。 */
export function stampSpots(spots, dateMs) {
  let stamped = 0;
  const out = spots.map((s) => {
    if (Number.isFinite(s.fetchedAt)) return s;
    stamped++;
    return { ...s, fetchedAt: dateMs };
  });
  return { spots: out, stamped };
}

/** "YYYY-MM-DD" をその日の UTC 0時の epoch ms に変換する。 */
export function dateToMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? "");
  if (!m) throw new Error(`日付は YYYY-MM-DD で指定してください: ${ymd}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function shardFiles(kbDir) {
  const index = JSON.parse(readFileSync(path.join(kbDir, "index.json"), "utf8"));
  return index.shards.map((s) => s.file);
}

function gitLastCommitMs(repoRoot, relFile) {
  const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", relFile], {
    cwd: repoRoot, encoding: "utf8",
  }).trim();
  const sec = Number(out);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

export function runStamp({ kbDir, repoRoot, write = false, dateMs = null, fromGit = false }) {
  const files = shardFiles(kbDir);
  let total = 0, missingBefore = 0, stampedTotal = 0;
  const perFile = [];
  for (const file of files) {
    const full = path.join(kbDir, file);
    const data = JSON.parse(readFileSync(full, "utf8"));
    const spots = data.spots ?? [];
    const missing = countMissing(spots);
    total += spots.length;
    missingBefore += missing;
    let stamped = 0;
    if (write && missing > 0) {
      let ms = dateMs;
      if (fromGit) ms = gitLastCommitMs(repoRoot, path.relative(repoRoot, full)) ?? dateMs;
      if (!Number.isFinite(ms)) throw new Error(`${file}: 付与する日付が決まりません`);
      const r = stampSpots(spots, ms);
      stamped = r.stamped;
      writeFileSync(full, JSON.stringify({ ...data, spots: r.spots }));
    }
    stampedTotal += stamped;
    perFile.push({ file, count: spots.length, missing, stamped });
  }
  return { total, missingBefore, stampedTotal, perFile };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = new Set(process.argv.slice(2));
  const dateIdx = process.argv.indexOf("--date");
  const dateMs = dateIdx >= 0 ? dateToMs(process.argv[dateIdx + 1]) : Date.now();
  const r = runStamp({
    kbDir: path.join(ROOT, "kb"),
    repoRoot: ROOT,
    write: args.has("--write"),
    dateMs,
    fromGit: args.has("--from-git"),
  });
  for (const f of r.perFile) {
    if (f.missing > 0 || f.stamped > 0) {
      console.log(`${f.file}: 全${f.count}件中 ${f.count - f.missing} 件付与済み` +
        (f.stamped ? `（今回 ${f.stamped} 件を付与）` : ""));
    }
  }
  console.log(`合計 ${r.total} 件 / 不足 ${r.missingBefore} 件` +
    (r.stampedTotal ? ` / 今回付与 ${r.stampedTotal} 件` : ""));
}
