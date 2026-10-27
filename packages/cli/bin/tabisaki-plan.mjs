#!/usr/bin/env node
// 旅さき CLI: 端末（SSH の先でも）から旅程を組む。
//
//     node packages/cli/bin/tabisaki-plan.mjs plan "温泉と海をゆっくり楽しみたい" --days=2
//     ./tabisaki plan "京都の寺" --from=新大阪駅 --output=json
//
// 外へは通信しません（AI・実際の乗換・天気は使わず、収録データと距離からの目安で組みます）。
// 例外は sync だけで、指定したカレンダー（CalDAV）にだけ書き込みます。
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
  --output=<形式>     markdown / text / json / ics（既定: markdown）

  tabisaki tui "<希望>" [同じオプション]   組んだ旅程を端末の中で見る（j/k・h/l・Enter・q）
  tabisaki sync "<希望>" --caldav-url=<URL> [同じオプション] [--dry-run] [--yes]
                      組んだ旅程を CalDAV のカレンダーに書き込む（同じ旅は上書き）
  tabisaki sync --remove --caldav-url=<URL> ["<希望>" と同じオプション]
                      旅さきが書いた予定を消す（希望を書かなければ、そのカレンダーの分すべて）
  tabisaki voice-plan <録音.wav> [同じオプション] [--yes]
                      手元の whisper.cpp で声を文字にし、確かめてから組む
  tabisaki help       これを出す
  tabisaki --version  版を出す

例:
  tabisaki plan "温泉と海をゆっくり楽しみたい" --days=2 --output=markdown
  tabisaki plan "京都で歴史を感じたい" --from=新大阪駅 --date=2026-11-03

時刻はすべて日本時間です。移動時間は距離からの目安で、実際の乗換は調べません。
sync と voice-plan の設定（合言葉・モデル）は docs/calendar-and-voice.md にあります。
`;

const OPTIONS = new Set(["from", "days", "date", "start", "back", "transport", "output", "caldav-url"]);
// 値を取らない印。
const FLAGS = new Set(["help", "version", "dry-run", "yes", "remove"]);
const COMMANDS = new Set(["plan", "tui", "sync", "voice-plan"]);
// まだ無いもの（docs/roadmap.md）。黙って無視せず、無いと言います。
const PLANNED = { local: "#352", model: "#352" };

export function parseArgs(argv) {
  const opts = {};
  const words = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { words.push(a); continue; }
    const [, key, value] = m;
    if (FLAGS.has(key)) {
      if (value !== undefined) throw usage(`--${key} には値を付けません`);
      opts[key] = true;
      continue;
    }
    if (PLANNED[key]) throw usage(`--${key} はまだ使えません（計画中: Issue ${PLANNED[key]}）`);
    if (!OPTIONS.has(key)) throw usage(`知らないオプションです: --${key}（tabisaki help で一覧）`);
    if (value === undefined || value === "") throw usage(`--${key}=<値> の形で書いてください`);
    opts[key] = value;
  }
  return { opts, words };
}

function usage(message) {
  const e = new Error(message);
  e.exitCode = 2;
  return e;
}

/**
 * 端末で1行たずねます。端末でない（パイプ・cron）ときは null を返します。
 * @returns {Promise<string|null>}
 */
async function ask(question, { stdin, stderr }) {
  if (!stdin?.isTTY) return null;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** 本体のログ（console.log・warn）は stderr へ。stdout は旅程だけにします（パイプで使えるように）。 */
async function quietly(stderr, fn) {
  const log = console.log;
  const warn = console.warn;
  const info = console.info;
  const toErr = (...a) => stderr.write(a.map(String).join(" ") + "\n");
  const quiet = () => {};
  console.log = console.info = process.env.TABISAKI_DEBUG ? toErr : quiet;
  console.warn = process.env.TABISAKI_DEBUG ? toErr : quiet;
  try {
    return await fn();
  } finally {
    console.log = log; console.warn = warn; console.info = info;
  }
}

function planRequest(opts, wish) {
  return {
    wish, from: opts.from, days: opts.days === undefined ? undefined : Number(opts.days),
    date: opts.date, start: opts.start, back: opts.back, transport: opts.transport,
  };
}

async function runCmd(cmd) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("/bin/sh", ["-c", cmd], { encoding: "utf8", timeout: 30_000 }, (err, out) => {
      if (err) reject(Object.assign(new Error("TABISAKI_CALDAV_PASSWORD_CMD が失敗しました"), { exitCode: 2 }));
      else resolve(out);
    });
  });
}

/** tabisaki sync */
async function sync(opts, words, io) {
  const { stdout, stderr, env } = io;
  // 旅程を組むあいだは fetch を「外へ出ない」ものに替えます（packages/core）。
  // カレンダーへは本物の fetch で送るので、替わる前に取っておきます。
  const netFetch = globalThis.fetch;
  const caldav = await import("../../core/caldav.mjs");
  if (!opts["caldav-url"]) throw usage("--caldav-url=<カレンダーの URL> を付けてください（docs/calendar-and-voice.md）");
  const calendar = caldav.checkCalendarUrl(opts["caldav-url"]);
  const file = caldav.statePath(env);
  const state = await caldav.loadState(file);
  const wish = words.join(" ").trim();
  const core = await import("../../core/index.mjs");

  if (opts.remove) {
    let seed;
    if (wish) seed = caldav.tripSeed(await core.normalizeRequest(planRequest(opts, wish)));
    const plan = await caldav.removeEvents({ calendar, seed, state, dryRun: true });
    if (!plan.removed.length) { stderr.write("tabisaki: このカレンダーに、旅さきが書いた予定はありません\n"); return 0; }
    if (opts["dry-run"]) { stdout.write(`消す予定: ${plan.removed.length}件（${calendar.host}）\n`); return 0; }
    if (!opts.yes) {
      const a = await ask(`${calendar.host} から、旅さきが書いた予定 ${plan.removed.length}件を消します。よいですか [y/N] `, io);
      if (a === null) throw usage("端末でないときは --yes を付けてください");
      if (!/^y(es)?$/i.test(a)) { stderr.write("やめました。\n"); return 0; }
    }
    const credentials = await caldav.credentialsFrom(env, runCmd);
    const r = await caldav.removeEvents({ calendar, credentials, seed, state, fetch: netFetch });
    await caldav.saveState(file, state);
    stdout.write(`消しました: ${r.removed.length}件${r.kept.length ? `（消せなかったもの ${r.kept.length}件）` : ""}\n`);
    return r.kept.length ? 1 : 0;
  }

  if (!wish) throw usage('希望の文を書いてください。例: tabisaki sync "温泉" --caldav-url=https://…/calendars/me/travel/');
  const result = await quietly(stderr, async () => (await core.createCore()).plan(planRequest(opts, wish)));
  const seed = caldav.tripSeed(result.request);
  const events = caldav.splitEvents(await core.toIcs(result, { seed }));
  if (!events.length) throw new Error("カレンダーに入れる予定がありませんでした");
  const plan = await caldav.syncEvents({ calendar, events, seed, state, dryRun: true });

  const list = events.map((e) => `  ${e.start.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d).*/, "$2/$3 $4:$5")}  ${e.summary}`).join("\n");
  stderr.write(`${result.itinerary.title ?? "旅程"} を ${calendar.host} に書き込みます（${events.length}件`
    + `${plan.removed.length ? `、前に書いて今回は無い ${plan.removed.length}件を消します` : ""}）:\n${list}\n`);
  if (opts["dry-run"]) { stdout.write(`書き込む予定: ${events.length}件・消す予定: ${plan.removed.length}件（まだ何も送っていません）\n`); return 0; }
  if (!opts.yes) {
    const a = await ask("よいですか [y/N] ", io);
    if (a === null) throw usage("端末でないときは、確かめたうえで --yes を付けてください（--dry-run で中身を見られます）");
    if (!/^y(es)?$/i.test(a)) { stderr.write("やめました。何も送っていません。\n"); return 0; }
  }
  const credentials = await caldav.credentialsFrom(env, runCmd);
  try {
    const r = await caldav.syncEvents({ calendar, credentials, events, seed, state, fetch: netFetch });
    stdout.write(`書き込みました: ${r.put.length}件${r.removed.length ? `・消しました: ${r.removed.length}件` : ""}\n`);
    return r.kept.length ? 1 : 0;
  } finally {
    await caldav.saveState(file, state);
  }
}

/** tabisaki voice-plan。組む文（string）か、やめたときの終了コード（number）を返します。 */
async function voicePlan(opts, words, io) {
  const { stderr, env } = io;
  const { transcribe } = await import("../../core/voice.mjs");
  if (words.length !== 1) throw usage("録音のファイルを1つだけ指定してください。例: tabisaki voice-plan wish.wav");
  const heard = await transcribe(words[0], { env });
  stderr.write(`聞き取った文: ${heard}\n`);
  let wish = heard;
  if (!opts.yes) {
    const a = await ask("Enter でこの文で組みます。直すときは書き直して Enter、やめるときは n: ", io);
    if (a === null) throw usage("端末でないときは、聞き取った文を確かめたうえで --yes を付けてください");
    if (/^n(o)?$/i.test(a)) { stderr.write("やめました。\n"); return 0; }
    if (a) wish = a;
  }
  return wish; // 続きは plan と同じ
}

export async function main(argv, {
  stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env,
} = {}) {
  try {
    const { opts, words } = parseArgs(argv);
    if (opts.version) { stdout.write(`tabisaki ${VERSION}\n`); return 0; }
    const [cmd, ...rest] = words;
    if (opts.help || !cmd || cmd === "help") { stdout.write(HELP); return cmd || opts.help ? 0 : 2; }
    if (!COMMANDS.has(cmd)) throw usage(`知らないコマンドです: ${cmd}（tabisaki help で一覧）`);
    if (opts["caldav-url"] && cmd !== "sync") throw usage("--caldav-url は tabisaki sync で使います");
    if ((opts["dry-run"] || opts.remove) && cmd !== "sync") throw usage("--dry-run と --remove は tabisaki sync で使います");
    if (opts.yes && cmd !== "sync" && cmd !== "voice-plan") throw usage("--yes は sync と voice-plan で使います");
    const io = { stdout, stderr, stdin, env };
    if (cmd === "sync") return await sync(opts, rest, io);
    let wish = rest.join(" ").trim();
    if (cmd === "voice-plan") {
      const picked = await voicePlan(opts, rest, io);
      if (typeof picked === "number") return picked;
      wish = picked;
    }
    if (!wish) throw usage(`希望の文を書いてください。例: tabisaki ${cmd} "温泉と海をゆっくり楽しみたい"`);
    if (cmd === "tui" && !(process.stdin.isTTY && process.stdout.isTTY)) {
      throw usage("tui は端末の中で動かしてください（パイプやファイルに出すときは tabisaki plan）");
    }
    const output = opts.output ?? "markdown";
    if (!["markdown", "md", "text", "json", "ics"].includes(output)) throw usage(`--output は markdown / text / json / ics のどれかです`);

    const core = await import("../../core/index.mjs");
    const result = await quietly(stderr, async () => (await core.createCore()).plan(planRequest(opts, wish)));
    if (cmd === "tui") {
      const { run } = await import("../../tui/tui.mjs");
      await run(result);
      return 0;
    }
    const text = output === "ics" ? await core.toIcs(result)
      : output === "json" ? core.toJson(result)
      : output === "text" ? core.toPlainText(result) : core.toMarkdown(result);
    stdout.write(text);
    return 0;
  } catch (e) {
    stderr.write(`tabisaki: ${e?.message ?? e}\n`);
    if (e?.exitCode) return e.exitCode;
    if (["invalid_input", "unknown_place", "setup", "auth"].includes(e?.code)) return 2;
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("tabisaki-plan.mjs")) {
  process.exitCode = await main(process.argv.slice(2));
}
