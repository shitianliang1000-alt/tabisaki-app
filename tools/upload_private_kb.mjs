// 国土数値情報の非商用データ（kb-private/）を、Cloudflare の Workers KV に入れる道具。
//
// 中継（server/worker.js）は、KV に入れた元データを**中で判定するだけ**に使い、
// 外には「はい／いいえ」しか返しません（server/private-kb.js）。
// リポジトリ・サイト・PHP 版・アプリには、元データは入りません。
// KV は Workers の無料プランに入っていて、カードの登録は要りません。
//
// コマンドを使わずに入れるなら、管理画面の「非商用データを入れる」から
// フォルダを選ぶだけです（docs/private-kb.md「入れかた A」）。
//
// 使いかた（入れかた B）
//
//   npx wrangler login                                        # 1回だけ。ブラウザで Cloudflare に入る
//   node tools/upload_private_kb.mjs --namespace-id <ID>      # 詰め直して、KV に一度に入れる
//   node tools/upload_private_kb.mjs --dry-run                # 何を入れるかだけ見る
//   node tools/upload_private_kb.mjs --pack-only              # .private-kb/ を作るだけ（手元の node-proxy・管理画面用）
//
//   --src <dir>           元データの場所（既定 kb-private）
//   --out <dir>           詰め直した先（既定 .private-kb。.gitignore 済み）
//   --namespace-id <ID>   KV の入れ物の ID（ダッシュボードの Workers KV に出ます）。
//                         省くと wrangler.jsonc の PRIVATE_KB を使います
//
// 認証情報はこの道具には書きません。wrangler login か、環境変数
// CLOUDFLARE_API_TOKEN（Workers KV の編集ができるトークン）を持ち主が入れます。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
const NAMESPACE = opt("namespace-id", "");
if (NAMESPACE && !/^[0-9a-f]{32}$/.test(NAMESPACE)) {
  console.error(`KV の ID の形が違います（英数字32文字）: ${NAMESPACE}`);
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

// 2. KV に一度に入れる（wrangler kv bulk put。1回の呼び出しで全部入ります）
// 一括の入力は、リポジトリの外（一時フォルダ）に書きます。
const bulk = join(mkdtempSync(join(tmpdir(), "tabisaki-kv-")), "bulk.json");
const pairs = [...packed].map(([key, value]) => ({ key, value: JSON.stringify(value) }));
// 目次は最後に。KV の一括は順番を約束しないので、目次だけ後から別に入れます。
writeFileSync(bulk, JSON.stringify(pairs.filter((p) => p.key !== "manifest.json")));
const target = NAMESPACE ? ["--namespace-id", NAMESPACE] : ["--binding", "PRIVATE_KB"];
const run = (cmd) => {
  if (has("dry-run")) { console.log(`  npx wrangler ${cmd.join(" ")}`); return 0; }
  const r = spawnSync("npx", ["wrangler", ...cmd], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
};
let status = run(["kv", "bulk", "put", bulk, ...target, "--remote"]);
if (status === 0) {
  status = run(["kv", "key", "put", "manifest.json", "--path", join(OUT, "manifest.json"), ...target, "--remote"]);
}
rmSync(bulk, { force: true });
if (status !== 0) {
  console.error("入りませんでした。もう一度走らせてください（上書きされます）。");
  process.exit(1);
}
console.log(has("dry-run") ? "（--dry-run なので、何も入れていません）"
  : `Workers KV に ${packed.size}件を入れました。`);
