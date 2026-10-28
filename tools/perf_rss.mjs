// tools/perf_bench.mjs が、測る相手の node に先に読ませるファイル（--import）。
// 終わるときに、その process の最大メモリ（KB）を標準エラーに書きます。
process.on("exit", () => {
  process.stderr.write(`\nPERF_RSS_KB=${process.resourceUsage().maxRSS}\n`);
});
