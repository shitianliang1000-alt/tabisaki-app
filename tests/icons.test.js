// 記号が、そろっているか。
//
// 画面の記号はぜんぶ絵文字と既成の文字でした（🚃 📍 ⚙ ✦ ⤢ ◎ ✓）。
// 端末ごとに別の絵で、多色で、同じ 17px でも大きさと重心がそろいません。
// 単線SVG（js/icons.js）に置き換えました。
//
// ここで確かめたいのは3つです。
//
//   ① **呼ばれる名前が、ぜんぶ実在すること。** 名前を間違えても
//      icon() は黙って点（dot）を返します。画面は壊れませんが、旅程の
//      行の先頭が全部同じ点になります。気づけるのは試験だけです。
//   ② **線の太さと枠がそろっていること。** そろっていないと、並べた
//      ときに太さの違いだけが目に付きます（絵文字をやめた理由そのもの）。
//   ③ **読み上げに出ないこと。** 字は必ず横に書いてあります。記号まで
//      読むと「電車 電車へ移動」になります。

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STROKE_WIDTH, TEXT_MARK, hasIcon, iconNames, iconPath,
} from "../js/icons.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * document の代わり。
 *
 * icon() は DOM を作るので、node:test では素の Node に無いものが要ります。
 * createElementNS が返すものだけを、必要なぶん真似ます。
 */
function fakeDocument() {
  const make = (ns, tag) => ({
    ns, tag, attrs: new Map(), children: [], textContent: "",
    setAttribute(k, v) { this.attrs.set(k, String(v)); },
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; },
    append(...kids) { this.children.push(...kids); },
  });
  return { createElementNS: (ns, tag) => make(ns, tag) };
}

/** icon() を、偽の document の下で呼びます。 */
async function withDom(fn) {
  const had = Object.hasOwn(globalThis, "document");
  const before = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    const { icon } = await import("../js/icons.js");
    return fn(icon);
  } finally {
    if (had) globalThis.document = before;
    else delete globalThis.document;
  }
}

test("どの記号も、24×24 の枠に同じ太さの線で描いてある", async () => {
  await withDom((icon) => {
    for (const name of iconNames()) {
      const svg = icon(name);
      assert.equal(svg.getAttribute("viewBox"), "0 0 24 24",
        `${name} の枠が違います`);
      assert.equal(svg.getAttribute("stroke-width"), STROKE_WIDTH,
        `${name} の線の太さが違います`);
      assert.equal(svg.getAttribute("fill"), "none", `${name} が塗られています`);
      assert.equal(svg.getAttribute("stroke"), "currentColor",
        `${name} が字の色についてきません`);
      assert.equal(svg.getAttribute("stroke-linecap"), "round");
      assert.equal(svg.getAttribute("stroke-linejoin"), "round");
    }
  });
});

test("線は、枠からはみ出さない", () => {
  // はみ出すと、端が切れた記号になります。数字だけを拾って見ます
  // （-1 のような負の座標と、25 以上が無いこと）。
  for (const name of iconNames()) {
    const d = iconPath(name);
    for (const m of d.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const v = Number(m[0]);
      // 相対座標（l, v, h, c …）は差分なので、-24〜24 に収まっていれば
      // 枠の中で動いています。
      assert.ok(v >= -24 && v <= 24,
        `${name} に枠の外の数（${v}）があります`);
    }
  }
});

test("ふつうは読み上げません。名前を渡したときだけ読みます", async () => {
  await withDom((icon) => {
    const plain = icon("transit");
    assert.equal(plain.getAttribute("aria-hidden"), "true");
    assert.equal(plain.getAttribute("focusable"), "false");
    assert.equal(plain.getAttribute("role"), null);

    const named = icon("transit", { title: "電車" });
    assert.equal(named.getAttribute("aria-hidden"), null);
    assert.equal(named.getAttribute("role"), "img");
    assert.equal(named.children[0].tag, "title");
    assert.equal(named.children[0].textContent, "電車");
  });
});

test("どの記号かが、画面から読める（試験と不具合調べのため）", async () => {
  await withDom((icon) => {
    assert.equal(icon("transit").getAttribute("data-icon"), "transit");
    // 別名でも、行き着いた先の名前が入ります。
    assert.equal(icon("coach").getAttribute("data-icon"), "bus");
  });
});

test("知らない名前でも壊れず、点になる", async () => {
  await withDom((icon) => {
    const svg = icon("そんな記号はありません");
    assert.equal(svg.getAttribute("data-icon"), "そんな記号はありません");
    assert.equal(svg.children.at(-1).getAttribute("d"), iconPath("dot"));
  });
  assert.equal(hasIcon("そんな記号はありません"), false);
  assert.equal(hasIcon("coach"), true);
});

test("呼ばれている名前が、ぜんぶ実在する", () => {
  // 名前を持っているモジュール（art / fit / confidence / variants）から
  // 文字列を拾って、icons.js に形があるかを見ます。**間違えても
  // 画面は壊れない**（黙って点になる）ので、ここで見つけるしかありません。
  const found = [];

  // art.js は分類ごとの表です。表の中の値だけを見ます。
  const art = read("../js/art.js");
  const block = art.slice(art.indexOf("const ICON = {"),
                          art.indexOf("};", art.indexOf("const ICON = {")));
  for (const m of block.matchAll(/: "([a-z-]+)"/g)) found.push(["art.js", m[1]]);

  for (const file of ["../js/fit.js", "../js/confidence.js",
                      "../js/variants.js"]) {
    for (const m of read(file).matchAll(/icon: "([a-z-]+)"/g)) {
      found.push([file, m[1]]);
    }
  }

  for (const [file, name] of found) {
    assert.ok(hasIcon(name), `${file} が知らない記号「${name}」を呼んでいます`);
  }
  // 拾えていること自体も見ます（正規表現が空振りしたら、この試験は
  // 何も確かめないまま通ります）。
  assert.ok(found.length > 45, `拾えた名前が ${found.length} 件しかありません`);
});

test("ui.js が呼ぶ名前も、ぜんぶ実在する", () => {
  const text = read("../js/ui.js");
  const names = new Set();
  for (const m of text.matchAll(/\bicon\("([^"]+)"/g)) names.add(m[1]);
  assert.ok(names.size >= 12, `呼び出しが ${names.size} 種類しかありません`);
  for (const n of names) {
    assert.ok(hasIcon(n), `ui.js が知らない記号「${n}」を呼んでいます`);
  }
});

test("index.html に直に書いた形が、icons.js とずれていない", () => {
  // 画面が出るより先に見える記号（旅の一覧の操作・入力欄の札と送る・
  // 現在地・地図を広げる・戻る）は、JS を待たせたくないので HTML に直に書いてあります。
  // **2か所に同じ形がある**ので、ずれていないかをここで見ます。
  const html = read("../index.html");
  const paths = [...html.matchAll(/<svg class="ic[^"]*"[^>]*><path d="([^"]+)"/g)]
    .map((m) => m[1]);
  // 2026-10: こだわりを「＋」の中の4つの欄にしたので、その項目と
  // 「戻る」「閉じる」が増えました（旅の例は外しました）。
  // 2026-10-22: こだわりを「＋」の一覧に平らに並べ（入れ子をやめ）、
  // 「こだわり」の項目と、その一覧の「閉じる」、4つの「戻る」が無くなり、
  // 「条件をリセット」の項目が増えました（4つの項目の記号は、列にあったときと同じ）。
  // 2026-10-23: 右上の設定（歯車）を消しました。
  assert.equal(paths.length, 25, `直書きの記号が ${paths.length} 個です`);
  const known = new Set(iconNames().map((n) => iconPath(n)));
  for (const d of paths) {
    assert.ok(known.has(d), `icons.js に無い形が index.html にあります: ${d}`);
  }
  // 線の太さも、JS が作るものと同じであること。
  for (const m of html.matchAll(/<svg class="ic[^"]*"([^>]*)>/g)) {
    assert.match(m[1], new RegExp(`stroke-width="${STROKE_WIDTH}"`));
    assert.match(m[1], /aria-hidden="true"/);
  }
});

test("画面に絵文字を残していない", () => {
  // 注釈（// で始まる行）には、何を置き換えたかを書いてあるので
  // 絵文字が出てきます。動く側だけを見ます。
  // ★☆（U+2605/2606）は残します。**絵文字ではなく活字**で、どの端末でも
  // 単色の同じ形で出ます。5段階の点をそのまま5つ並べる、という読ませかたは
  // 記号1つに置き換えられません（icons.js は1つの形しか返しません）。
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{2604}\u{2607}-\u{27BF}]/u;
  for (const file of ["../js/ui.js", "../js/share.js", "../js/art.js",
                      "../js/fit.js", "../js/variants.js",
                      "../js/confidence.js", "../index.html"]) {
    read(file).split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
          || t.startsWith("<!--")) return;
      assert.ok(!emoji.test(line),
        `${file}:${i + 1} に絵文字が残っています: ${t.slice(0, 60)}`);
    });
  }
});

test("文字で渡すところは、絵文字ではなく言葉", () => {
  // .ics の説明や、コピーして LINE に貼る文。相手の端末に無い絵文字は
  // 豆腐（□）になります。「□ 出雲大社」では何の行か分かりません。
  for (const [kind, mark] of Object.entries(TEXT_MARK)) {
    assert.match(mark, /^\[.+\]$/, `${kind} の当て字が妙です: ${mark}`);
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(mark));
  }
  // 旅程に出る種類は、ぜんぶ持っていること。
  for (const kind of ["transit", "spot", "meal", "lodging", "free",
                      "luggage", "arrive"]) {
    assert.ok(TEXT_MARK[kind], `${kind} の当て字がありません`);
  }
});

test("記号が、字の大きさについてくる", () => {
  // px で固定すると、Dynamic Type で字だけが大きくなり、記号は
  // 取り残されます。CSS で 1em にしてあること。
  const css = read("../css/hig.css");
  const m = css.match(/\.ic \{[^}]+\}/);
  assert.ok(m, ".ic の決まりがありません");
  assert.match(m[0], /width:\s*1em/);
  assert.match(m[0], /height:\s*1em/);
  assert.ok(!/width:\s*\d+px/.test(m[0]), "px で固定されています");
});

test("service worker が、記号を先に入れておく", () => {
  // 旅の当日に圏外でアプリを開いたとき、これが無いと行の先頭に
  // 何も出ない旅程になります。
  assert.match(read("../sw.js"), /"\.\/js\/icons\.js"/);
});
