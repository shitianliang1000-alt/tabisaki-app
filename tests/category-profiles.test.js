// 分類ごとの既定値（滞在時間・開いている時刻・料金）の受け持ち範囲を見ます。
//
// この試験がある理由は、**落ちても画面に出ないから**です。表に無い分類は
// DEFAULT_PROFILE に落ちますが、落ちた場所も「45分・9:00〜17:00・300円」
// として、ほかと同じ顔で旅程に並びます。見て気づけません。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { profileOf } from "../packages/core/src/feasibility.js";

/** 収録に実際に出てくる分類を、ぜんぶ集めます。 */
function categoriesInKb() {
  const cats = new Map();
  for (const f of readdirSync("kb")) {
    if (!/^spots.*\.json$/.test(f)) continue;
    for (const s of JSON.parse(readFileSync(`kb/${f}`, "utf8")).spots) {
      if (s.category) cats.set(s.category, (cats.get(s.category) ?? 0) + 1);
    }
  }
  return cats;
}

const DEFAULT = { dwell: 45, open: 9, close: 17, fee: 300 };

test("収録の分類が、ぜんぶ既定値の表に載っている", () => {
  const cats = categoriesInKb();
  assert.ok(cats.size > 20, "収録が読めていません");
  const fell = [];
  for (const [cat, n] of cats) {
    const p = profileOf({ category: cat });
    const same = p.dwell === DEFAULT.dwell && p.open === DEFAULT.open
      && p.close === DEFAULT.close && p.fee === DEFAULT.fee;
    // 観光名所は既定値と同じ値を持っています（偶然の一致です）。
    if (same && cat !== "観光名所") fell.push(`${cat}（${n}件）`);
  }
  assert.deepEqual(fell, [],
    `既定値に落ちている分類があります: ${fell.join(" / ")}`);
});

test("門も料金所も無いものに、料金と閉館時刻を作らない", () => {
  // 峠に入場料はありません。海岸に閉館時刻はありません。
  // 300円を足せば予算がずれ、17時に閉めれば夕暮れの海岸が外れます。
  for (const cat of ["峠", "岬", "海水浴場", "町並み", "高原", "漁港",
                     "自然", "海岸", "湖", "川", "滝", "山", "史跡"]) {
    const p = profileOf({ category: cat });
    assert.equal(p.fee, 0, `${cat} に料金が付いています（${p.fee}円）`);
    assert.equal(p.open, 0, `${cat} に開く時刻が付いています`);
    assert.equal(p.close, 24, `${cat} に閉まる時刻が付いています`);
  }
});

test("島に行くのは、半日仕事として数える", () => {
  // 45分では渡って戻るだけで終わります。収録の島は667件あります。
  const p = profileOf({ category: "島" });
  assert.ok(p.dwell >= 120, `島の滞在が ${p.dwell}分 しかありません`);
});

test("スポットが持っている実データのほうを、既定値より先に使う", () => {
  // 既定値はあくまで代役です。本当の時刻を持っているなら、そちらです。
  const p = profileOf({ category: "海水浴場", open: 8.5, close: 17, fee: 500 });
  assert.equal(p.open, 8.5);
  assert.equal(p.close, 17);
  assert.equal(p.fee, 500);
});
