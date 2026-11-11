// 国土数値情報の非商用データ（kb-private/）を、Cloudflare の R2 に入れる道具。
//
// 中継（server/worker.js）は、R2 に入れた元データを**中で判定するだけ**に使い、
// 外には「はい／いいえ」しか返しません（server/private-kb.js）。
// リポジトリ・サイト・PHP 版・アプリには、元データは入りません。
//
// 使いかた（手順は docs/private-kb.md）
//
//   npx wrangler login                                   # 1回だけ。ブラウザで Cloudflare に入る
//   node tools/upload_private_kb.mjs                     # 詰め直して、R2 に上げる
//   node tools/upload_private_kb.mjs --dry-run           # 何を上げるかだけ見る
//   node tools/upload_private_kb.mjs --pack-only         # .private-kb/ を作るだけ（手元の node-proxy 用）
//   node tools/upload_private_kb.mjs --local             # wrangler dev の手元の R2 に入れる
//
//   --src <dir>      元データの場所（既定 kb-private）
//   --out <dir>      詰め直した先（既定 .private-kb。.gitignore 済み）
//   --bucket <name>  R2 のバケット名（既定 tabisaki-private。wrangler.jsonc と合わせる）
//
// 認証情報はこの道具には書きません。wrangler login か、環境変数
// CLOUDFLARE_API_TOKEN（R2 の編集ができるトークン）を 持ち主が入れます。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packPrivateKb } from "../server/private-kb.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const opt = (f, d) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};

const SRC = resolve(ROOT, opt("src", "kb-private"));
const OUT = resolve(ROOT, opt("out", ".private-kb"));
const BUCKET = opt("bucket", "tabisaki-private");
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(BUCKET)) {
  console.error(`バケット名が使えない形です: ${BUCKET}`);
  process.exit(2);
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

// 1. 詰め直す（1度四方のタイルに。名前と座標だけ）
const busIndex = readJson(join(SRC, "stops-bus.json"));
const spotsDoc = readJson(join(SRC, "spots-noncommercial.json"));
if (!busIndex && !spotsDoc) {
  console.error(`${SRC} に stops-bus.json も spots-noncommercial.json もありません。`);
  console.error("プロジェクトの共有フォルダの kb-private/ を、リポジトリの一番上に写してください。");
  process.exit(1);
}
const packed = packPrivateKb({
  busIndex,
  readBusTile: (file) => readJson(join(SRC, file)),
  spotsDoc,
});

// 出力先は、リポジトリに入らない場所に限ります。
const rel = OUT.startsWith(ROOT) ? OUT.slice(ROOT.length + 1) : null;
const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
if (rel !== null && !new RegExp(`^/?${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?$`, "m").test(ignore)) {
  console.error(`${rel}/ は .gitignore に入っていません。リポジトリに入る場所には書き出しません。`);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
for (const [key, value] of packed) {
  const file = join(OUT, key);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}
const manifest = packed.get("manifest.json");
console.log(`詰め直しました: ${OUT}（バス停 ${manifest.counts.bus}件・${manifest.bus.length}枚、`
  + `観光資源・文化施設 ${manifest.counts.spots}件・${manifest.spots.length}枚）`);
if (has("pack-only")) process.exit(0);

// 2. R2 に上げる
const where = has("local") ? "--local" : "--remote";
const run = (cmd) => {
  if (has("dry-run")) { console.log(`  npx wrangler ${cmd.join(" ")}`); return 0; }
  const r = spawnSync("npx", ["wrangler", ...cmd], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
};

if (!has("local")) {
  // あれば「もうある」と言って失敗するだけなので、そのまま進みます。
  run(["r2", "bucket", "create", BUCKET]);
}
// manifest.json は最後に上げます。途中で止まっても、中継は「まだ無い」と見て
// available:false を返すだけです（半端なタイルで間違った答えを出しません）。
const keys = [...packed.keys()].filter((k) => k !== "manifest.json").sort();
let failed = 0;
for (const key of [...keys, "manifest.json"]) {
  const status = run(["r2", "object", "put", `${BUCKET}/${key}`, "--file", join(OUT, key),
    "--content-type", "application/json", where]);
  if (status !== 0) { failed++; console.error(`上がりませんでした: ${key}`); if (key === "manifest.json") break; }
}
if (failed) {
  console.error(`${failed}件が上がりませんでした。もう一度走らせてください（上書きされます）。`);
  process.exit(1);
}
console.log(has("dry-run") ? "（--dry-run なので、何も上げていません）"
  : `R2（${BUCKET}）に ${packed.size}件を上げました。wrangler.jsonc の r2_buckets の // を外して出し直してください。`);
