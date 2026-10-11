// 材質（Liquid Glass）の使いかたを、ガイドラインの側から見張る。
//
// いまの Human Interface Guidelines は、画面を2つの層に分けます。
//
//   操作と案内の層 … 浮いていて、後ろが透ける（Liquid Glass）
//   内容の層       … 透けない。標準の材質で面を分ける
//
// ガイドラインと WWDC25「Meet Liquid Glass」が名指しで禁じていること
//   ・内容の層に Liquid Glass を使わない（階層が分からなくなります）
//   ・ガラスの上にガラスを重ねない（何が操作なのか読めなくなります）
//   ・使いすぎない（内容に目を向けさせるための材質です）
//
// そして、設定に合わせた変わりかたを**3つとも**用意すること。
//   透明度を下げる … もっと霜がかった状態にする（やめるのではない）
//   コントラストを上げる … ほぼ白／黒にして、縁を1本引く
//   動きを減らす … 伸び縮みを止める

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const css = (f) => fs.readFileSync(path.join(ROOT, "css", f), "utf8");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const allCss = fs.readdirSync(path.join(ROOT, "css"))
  .filter((f) => f.endsWith(".css")).map(css).join("\n");

/**
 * ガラスを当ててよいもの。
 *
 * どれも「浮いていて、下に内容が流れていくもの」です。ここに
 * カードや旅程の行を足したくなったら、それは内容の層なので、
 * ガラスではなく標準の材質を使ってください。
 */
const FLOATING = ["settings-fab", "make", "back-to-form", "dock"];

test("ガラスは、浮いているものにしか当てていない", () => {
  const found = [...html.matchAll(/class="([^"]*hig-glass[^"]*)"/g)]
    .map((m) => m[1].split(/\s+/));
  // 2026-10 のチャット画面では、どこにも当てていません（入力欄は
  // Claude と同じく透けない面です）。当てるなら、浮いているものだけ。
  for (const classes of found) {
    assert.ok(classes.some((c) => FLOATING.includes(c)),
      `浮いていないものにガラスが当たっています: ${classes.join(" ")}`);
  }
});

test("ガラスの上にガラスを重ねていない", () => {
  // 入れ子になっていないことを、ざっくり見ます（index.html の中で
  // hig-glass を持つ要素が、別の hig-glass の中に無いこと）。
  const parts = html.split(/hig-glass/);
  // 1つ目の hig-glass より後ろで、閉じる前にもう1つ出てこないこと
  for (let i = 1; i < parts.length; i += 1) {
    const chunk = parts[i];
    const close = chunk.indexOf("</div>");
    const next = chunk.indexOf("hig-glass");
    if (close >= 0 && next >= 0) {
      assert.ok(next > close, "ガラスの中にガラスがあります");
    }
  }
});

test("使いすぎていない", () => {
  // ガイドライン: 「いちばん大事な操作だけに限る」。
  const n = [...html.matchAll(/hig-glass\b/g)].length;
  assert.ok(n <= 6, `ガラスが ${n} か所あります（絞ってください）`);
});

test("設定に合わせた変わりかたが3つそろっている", () => {
  assert.match(allCss, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(allCss, /@media \(prefers-contrast: more\)/);
  assert.match(allCss, /@media \(prefers-reduced-motion: reduce\)/);
});

test("透明度を下げる設定では、ガラスをやめずに霜を濃くする", () => {
  // やめてしまうと、操作の層と内容の層の区別まで失われます。
  const hig = css("hig.css");
  const at = hig.indexOf("@media (prefers-reduced-transparency: reduce)");
  assert.ok(at > 0, "透明度を下げる設定への対応がありません");
  const block = hig.slice(at, at + 500);
  assert.match(block, /backdrop-filter: saturate\(120%\) blur\(30px\)/,
    "にじみを外しています（霜を濃くするのが正しい）");
});

test("コントラストを上げる設定では、縁を1本引く", () => {
  const hig = css("hig.css");
  const at = hig.indexOf("@media (prefers-contrast: more)");
  const block = hig.slice(at, at + 500);
  assert.match(block, /box-shadow: inset 0 0 0 1px var\(--hig-label\)/,
    "はっきりした縁が引かれていません");
});

test("色は、自分で決めたものにも明暗＋高コントラストの変種がある", () => {
  // ガイドライン（Color）: 自作の色にも、明るい配色・暗い配色と、
  // それぞれのコントラストを上げた変種を用意すること。
  const tokens = css("hig-tokens.css");
  assert.match(tokens, /@media \(prefers-color-scheme: dark\)/);
  assert.match(tokens, /@media \(prefers-contrast: more\)/);
  assert.match(tokens,
    /@media \(prefers-contrast: more\) and \(prefers-color-scheme: dark\)/);
});

test("反転する色の上に、白を直書きしていない", () => {
  // --tabi-indigo / --tabi-teal / --hig-blue-deep は、暗い配色で
  // **明るい色へ反転**します（暗い地の上で読ませるため）。その上に
  // color: #fff を直書きすると、明るい配色では読めるのに、暗い配色
  // では白が薄水色に溶けます。実測で 1.69〜2.21（必要なのは 4.5）。
  //
  // 「旅程をつくる」のボタンも、選んだチップも、まぜかたの帯も、
  // そうなっていました。axe は見つけてくれません（絵・押せない
  // ボタン・畳んだ中身は、色のきまりの対象外だからです）。
  //
  // 主色の上の字は --hig-on-accent を使います。明暗で中身が
  // 入れ替わるので、主色が反転すれば字も一緒に反転します。
  const FLIPPING = /var\(--(tabi-indigo|tabi-teal|hig-blue-deep)\)/;
  const bad = [];
  for (const f of fs.readdirSync(path.join(ROOT, "css"))) {
    if (!f.endsWith(".css")) continue;
    const text = css(f);
    // 宣言の塊（{ … }）ごとに見ます。
    for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
      const block = m[1];
      if (!/background:[^;]*/.test(block)) continue;
      const bg = block.match(/background(-color)?:[^;]*/)?.[0] ?? "";
      if (!FLIPPING.test(bg)) continue;
      if (/color:\s*(#fff\b|#ffffff\b|white\b)/i.test(block)) {
        bad.push(`${f}: ${block.trim().replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(bad, [],
    `明暗で反転する色の上に白を直書きしています（--hig-on-accent を使ってください）:\n${bad.join("\n")}`);
});

test("主色の上の字は、明暗それぞれに用意されている", () => {
  const tokens = css("hig-tokens.css");
  const dark = tokens.slice(tokens.indexOf("@media (prefers-color-scheme: dark)"));
  assert.match(tokens, /--hig-on-accent:\s*#FFFFFF/i,
    "明るい配色の --hig-on-accent がありません");
  assert.match(dark, /--hig-on-accent:\s*#[0-9A-F]{6}/i,
    "暗い配色の --hig-on-accent がありません");
  const darkValue = dark.match(/--hig-on-accent:\s*(#[0-9A-F]{6})/i)[1];
  assert.notEqual(darkValue.toUpperCase(), "#FFFFFF",
    "暗い配色でも白のままです（主色が明るいので読めません）");
});

test("縁のぼかしは、浮いているものがあるところだけ", () => {
  // WWDC25「Get to know the new design system」:
  // scroll edge effect は飾りではない。浮いている操作が無いところには
  // 置かない。
  const used = [...html.matchAll(/class="([^"]*hig-scroll-edge[^"]*)"/g)]
    .map((m) => m[1].split(/\s+/));
  for (const classes of used) {
    assert.ok(classes.includes("hig-glass"),
      `浮いていないものにぼかしが付いています: ${classes.join(" ")}`);
  }
});
