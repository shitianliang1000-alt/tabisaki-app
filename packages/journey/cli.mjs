// tabisaki build / test / diff / narrate（旅程ファイルを使うコマンド）。
// packages/cli/bin/tabisaki-plan.mjs から呼びます。
//
// 終了コード:
//   build・narrate  0 = できた、1 = 組めなかった、2 = ファイルのまちがい
//   test            0 = 条件をすべて守っている、1 = 守れていない条件がある、2 = ファイルのまちがい
//   diff            0 = 違いなし、1 = 違いあり、2 = ファイルのまちがい（diff コマンドと同じ）

import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { loadJourney, buildJourney, checkJourney, diffJourneys, narrate, JourneyError, STYLES, FORMATS } from "./index.mjs";

export const JOURNEY_COMMANDS = ["build", "test", "diff", "narrate"];

export const JOURNEY_HELP = `旅程ファイル（YAML）を使うコマンド（書きかたは docs/journey-as-code.md）:

  tabisaki build <trip.yaml> [--output=markdown|text|json]   組む（output.file があればそこへ書く）
  tabisaki test <trip.yaml>                                  組んで、constraints を守っているか確かめる
  tabisaki diff <a.yaml|a.json> <b.yaml|b.json>              2つの旅程の違いを出す
  tabisaki narrate <trip.yaml> [--style=${STYLES.join("|")}]       旅の文にする

  見本: examples/trips/hakone.yaml
`;

function usage(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}

async function exists(f) {
  try { await access(f); return true; } catch { return false; }
}

/** 「plan-a」のように拡張子を省いても、plan-a.yaml を探します。 */
async function resolveFile(f) {
  if (await exists(f)) return f;
  for (const ext of [".yaml", ".yml", ".json"]) if (await exists(f + ext)) return f + ext;
  return f;
}

/**
 * @param {string} cmd build / test / diff / narrate
 * @param {string[]} files
 * @param {Record<string,string>} opts
 * @param {{stdout, stderr, core: () => Promise<object>, format: object}} io
 */
export async function runJourney(cmd, files, opts, { stdout, stderr, core, format }) {
  const want = cmd === "diff" ? 2 : 1;
  if (files.length !== want) {
    throw usage(cmd === "diff" ? "比べる2つのファイルを書いてください。例: tabisaki diff plan-a.yaml plan-b.yaml"
      : `旅程ファイルを1つ書いてください。例: tabisaki ${cmd} examples/trips/hakone.yaml`);
  }
  const resolved = await Promise.all(files.map(resolveFile));

  if (cmd === "diff") {
    const snaps = [];
    let c = null;
    for (const f of resolved) {
      if (/\.json$/i.test(f)) {
        let j;
        try { j = JSON.parse(await readFile(f, "utf8")); } catch (e) {
          throw new JourneyError(f, [{ path: "", message: e.code === "ENOENT" ? "ファイルがありません" : "JSON として読めません（tabisaki build --output=json で出したものを使ってください）" }]);
        }
        if (j?.version !== 1 || !Array.isArray(j.days)) throw new JourneyError(f, [{ path: "", message: "旅程の JSON（version: 1）ではありません" }]);
        snaps.push(j);
      } else {
        const journey = await loadJourney(f);
        c ??= await core();
        const built = await buildJourney(c, journey);
        snaps.push(JSON.parse(format.toJson(built.result)));
      }
    }
    const { same, lines } = diffJourneys(snaps[0], snaps[1], { labelA: files[0], labelB: files[1] });
    stdout.write(lines.join("\n") + "\n");
    return same ? 0 : 1;
  }

  const [file] = resolved;
  const journey = await loadJourney(file);
  if (cmd === "narrate" && opts.style && !STYLES.includes(opts.style)) throw usage(`--style は ${STYLES.join(" / ")} のどれかです`);
  const fmtName = opts.output ?? journey.def.output.format;
  const fmt = fmtName === "md" ? "markdown" : fmtName;
  if (cmd === "build" && !FORMATS.includes(fmt)) throw usage(`--output は ${FORMATS.join(" / ")} のどれかです`);

  const built = await buildJourney(await core(), journey);
  for (const n of built.notes) stderr.write(`tabisaki: ${n}\n`);

  if (cmd === "build") {
    const text = fmt === "json" ? format.toJson(built.result) : fmt === "text" ? format.toPlainText(built.result, { lang: opts.lang }) : format.toMarkdown(built.result, { lang: opts.lang });
    // --output を付けたときは端末へ（ファイルに書く設定より、その場の指定を優先します）
    if (journey.def.output.file && !opts.output) {
      const out = path.resolve(journey.dir, journey.def.output.file);
      await writeFile(out, text);
      stderr.write(`tabisaki: 書き出しました: ${path.relative(process.cwd(), out) || out}\n`);
    } else stdout.write(text);
    return 0;
  }

  if (cmd === "narrate") {
    stdout.write(narrate(built, opts.style ?? journey.def.output.narrate));
    return 0;
  }

  // test
  const checks = checkJourney(built);
  const failed = checks.filter((c) => !c.ok);
  stdout.write(`${files[0]}: ${journey.def.title}\n`);
  for (const c of checks) stdout.write(`  ${c.ok ? (c.skipped ? "-" : "✓") : "✗"} ${c.name}: ${c.detail}\n`);
  const checked = checks.filter((c) => !c.skipped).length;
  stdout.write(failed.length ? `\n${failed.length}件の条件を守れていません（${checked}件を確かめました）\n` : `\n${checked}件の条件をすべて守っています\n`);
  return failed.length ? 1 : 0;
}
