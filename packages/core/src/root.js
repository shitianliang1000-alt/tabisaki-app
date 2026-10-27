// アプリの一番上（index.html や kb/ がある場所）の URL。
//
// 旅程を組む部分は packages/core/src/ にあります。ここから見ると、一番上は
// 3段上（../../../）です。ところが公開するときは、画面の js/app.js と
// いっしょに js/chunk-*.js へまとめます（tools/optimize_site.mjs）。まとめた
// あとは、ファイルの場所が js/ になるので、一番上は1段上（../）です。
// import.meta.url は、まとめても書き換わりません。だから、自分がいま
// どこにいるかを見て決めます。
//
// Node.js（packages/core/index.mjs）では、リポジトリの根の file: URL になります。

const here = new URL(import.meta.url);
const unbundled = /\/packages\/core\/src\/[^/]*$/.test(here.pathname);

/** アプリの一番上。末尾は「/」です。 */
export const APP_ROOT = new URL(unbundled ? "../../../" : "../", here);

/** 一番上からの相対の場所を、URL の文字にします（"kb/ropeways.json" など）。 */
export const appUrl = (rel) => new URL(rel, APP_ROOT).toString();
