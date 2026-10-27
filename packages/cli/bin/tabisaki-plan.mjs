#!/usr/bin/env node
// 旅さき CLI: 端末（SSH の先でも）から旅程を組む。
//
//     node packages/cli/bin/tabisaki-plan.mjs plan "温泉と海をゆっくり楽しみたい" --days=2
//     ./tabisaki plan "京都の寺" --from=新大阪駅 --output=json
//
// 外へは通信しません（AI・実際の乗換・天気は使わず、収録データと距離からの目安で組みます）。
// 終了コード: 0 = 組めた、1 = 組めなかった、2 = 使いかたのまちがい

import { readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `使いかた: tabisaki plan "<希望の文>" [オプション]

  --from=<駅>         出発地（既定: 東京駅）。例: 新大阪駅・博多駅・札幌駅
  --days=<N>          日数 1〜14（既定: 1）
  --date=<YYYY-MM-DD> 出発日（既定: 明日）
  --start=<HH:MM>     出発の時刻（既定: 08:00）
  --back=<HH:MM>      最終日に帰り着く時刻（既定: 20:00）
  --transport=<手段>  any / transit / car / walk / local（既定: any）
  --output=<形式>     markdown / text / json（既定: markdown）
  --lang=<言語>       ja / en（既定: ja。環境変数 TABISAKI_LANG でも決められます）
  --kb=<名前>         ユーザーKB（~/.tabisaki/kbs/<名前>/）を公式の収録に重ねて組む

  tabisaki tui "<希望>" [同じオプション]   組んだ旅程を端末の中で見る（j/k・h/l・Enter・q）
  tabisaki plugins [list|trust <id>|untrust <id>]   プラグインを見る・使ってよいと決める・外す
                      （docs/plugins.md。置き場所は TABISAKI_PLUGIN_DIR か ~/.config/tabisaki/plugins）
  tabisaki help       これを出す
  tabisaki --version  版を出す

例:
  tabisaki plan "温泉と海をゆっくり楽しみたい" --days=2 --output=markdown
  tabisaki plan "京都で歴史を感じたい" --from=新大阪駅 --date=2026-11-03

時刻はすべて日本時間です。移動時間は距離からの目安で、実際の乗換は調べません。
`;

const OPTIONS = new Set(["from", "days", "date", "start", "back", "transport", "output", "lang", "kb"]);
// まだ無いもの（docs/roadmap.md）。黙って無視せず、無いと言います。
const PLANNED = { local: "#352", model: "#352" };

export function parseArgs(argv) {
  const opts = {};
  const words = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { words.push(a); continue; }
    const [, key, value] = m;
    if (key === "help" || key === "version") { opts[key] = true; continue; }
    if (PLANNED[key]) throw usage(`--${key} はまだ使えません（計画中: Issue ${PLANNED[key]}）`);
    if (!OPTIONS.has(key)) throw usage(`知らないオプションです: --${key}（tabisaki help で一覧）`);
    if (value === undefined || value === "") throw usage(`--${key}=<値> の形で書いてください`);
    opts[key] = value;
  }
  return { opts, words };
}

const STATUS = { enabled: "使う", untrusted: "まだ控えていない", changed: "中身が変わった（控え直すまで使わない）", invalid: "宣言にまちがい" };

async function plugins([sub = "list", id], { stdout }) {
  const p = await import("../../core/plugins.mjs");
  const dir = p.pluginDir();
  if (sub === "list") {
    const all = await p.scanPlugins(dir);
    stdout.write(`置き場所: ${dir}\n`);
    if (!all.length) stdout.write("プラグインはありません\n");
    for (const x of all) {
      const m = x.manifest;
      stdout.write(`${x.id}${m ? ` ${m.version}（${m.name}・${m.author}・${m.license}）` : ""}: ${STATUS[x.status]}\n`);
      for (const e of x.errors ?? []) stdout.write(`  - ${e}\n`);
    }
    return 0;
  }
  if (!id) throw usage(`tabisaki plugins ${sub} <id> の形で書いてください`);
  if (sub === "trust") {
    const x = await p.trustPlugin(dir, id);
    const c = x.manifest.contributes;
    stdout.write(`${id} ${x.manifest.version} を控えました（sha256 ${x.sha256.slice(0, 12)}…）。` +
      `ひな形 ${(c.templates ?? []).length} 個・除外 ${(c.constraints ?? []).length} 個\n`);
    return 0;
  }
  if (sub === "untrust") {
    stdout.write((await p.untrustPlugin(dir, id)) ? `${id} を控えから外しました。消すときは ${dir}/${id} を消してください\n` : `${id} は控えにありません\n`);
    return 0;
  }
  throw usage(`plugins のあとは list / trust / untrust のどれかです`);
}

function usage(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { opts, words } = parseArgs(argv);
    if (opts.version) { stdout.write(`tabisaki ${VERSION}\n`); return 0; }
    const [cmd, ...rest] = words;
    if (opts.help || !cmd || cmd === "help") { stdout.write(HELP); return cmd || opts.help ? 0 : 2; }
    if (cmd === "plugins") return await plugins(rest, { stdout });
    if (cmd !== "plan" && cmd !== "tui") throw usage(`知らないコマンドです: ${cmd}（tabisaki help で一覧）`);
    const wish = rest.join(" ").trim();
    if (!wish) throw usage(`希望の文を書いてください。例: tabisaki ${cmd} "温泉と海をゆっくり楽しみたい"`);
    if (cmd === "tui" && !(process.stdin.isTTY && process.stdout.isTTY)) {
      throw usage("tui は端末の中で動かしてください（パイプやファイルに出すときは tabisaki plan）");
    }
    const output = opts.output ?? "markdown";
    if (!["markdown", "md", "text", "json"].includes(output)) throw usage(`--output は markdown / text / json のどれかです`);
    const core = await import("../../core/index.mjs");
    if (opts.lang !== undefined && !core.pickLang(opts.lang)) throw usage(`--lang は ${core.LANGS.join(" / ")} のどれかです`);
    const lang = core.resolveLang(opts.lang);
    const days = opts.days === undefined ? undefined : Number(opts.days);

    // 本体のログ（console.log・warn）は stderr へ。stdout は旅程だけにします（パイプで使えるように）。
    const log = console.log;
    const warn = console.warn;
    const info = console.info;
    const toErr = (...a) => stderr.write(a.map(String).join(" ") + "\n");
    const quiet = () => {};
    console.log = console.info = process.env.TABISAKI_DEBUG ? toErr : quiet;
    console.warn = process.env.TABISAKI_DEBUG ? toErr : quiet;
    let result;
    try {
      // 控えた（trust した）プラグインだけを読みます。TABISAKI_PLUGINS=0 で読みません。
      const plugins = process.env.TABISAKI_PLUGINS === "0" ? [] : await core.loadPlugins();
      const c = await core.createCore({ plugins, ...(opts.kb ? { userKb: opts.kb } : {}) });
      const rep = c.overlayReport;
      if (rep && (rep.orphans.length || rep.conflicts.length || rep.invalid.length)) {
        stderr.write(`tabisaki: ユーザーKB「${rep.name}」: 見失った差分 ${rep.orphans.length}件・公式と食い違う項目 ${rep.conflicts.length}件・使えない差分 ${rep.invalid.length}件\n`);
      }
      result = await c.plan({
        wish, from: opts.from, days, date: opts.date, start: opts.start, back: opts.back,
        transport: opts.transport,
      });
    } finally {
      console.log = log; console.warn = warn; console.info = info;
    }
    if (result.template) stderr.write(`ひな形「${result.template.name}」を使いました（プラグイン ${result.template.plugin}）\n`);
    if (cmd === "tui") {
      const { run } = await import("../../tui/tui.mjs");
      await run(result);
      return 0;
    }
    const text = output === "json" ? core.toJson(result)
      : output === "text" ? core.toPlainText(result, { lang }) : core.toMarkdown(result, { lang });
    stdout.write(text);
    return 0;
  } catch (e) {
    stderr.write(`tabisaki: ${e?.message ?? e}\n`);
    if (e?.exitCode) return e.exitCode;
    if (["invalid_input", "unknown_place", "invalid_name", "not_found"].includes(e?.code)) return 2;
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("tabisaki-plan.mjs")) {
  process.exitCode = await main(process.argv.slice(2));
}
