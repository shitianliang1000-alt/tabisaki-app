// 希望文に出てくる地名を拾う。
//
// 画面にこう入力されていました。
//
//     横浜の人が少ない静かな場所で自然を感じたい
//       → 江東区（東京都）
//
// 収録には 横浜みなとみらい・横浜市・横浜町 の3つがあるのに、**1つも
// 見つかっていません**。収録の名前は「横浜市」で、書かれたのは「横浜」
// だからです。地名は他の検索語と性質が違います。無視して別の場所を
// 出すのは、近いものを返しているのではなく、別の質問に答えているのと
// 同じです。

import assert from "node:assert/strict";
import test from "node:test";

import { detectAreas, variantsOf } from "../packages/core/src/areas.js";

const KB = {
  regions: [
    { id: "yokohama", name: "横浜みなとみらい", prefecture: "神奈川県" },
    { id: "n0458", name: "横浜市", prefecture: "神奈川県" },
    { id: "n0632", name: "横浜町", prefecture: "青森県" },
    { id: "shibuya", name: "渋谷区", prefecture: "東京都" },
    { id: "minato", name: "港区", prefecture: "東京都" },
    { id: "koto", name: "江東区", prefecture: "東京都" },
    { id: "hakone", name: "箱根", prefecture: "神奈川県" },
  ],
};

test("「市」「区」を落とした呼びかたでも見つける", () => {
  assert.ok(variantsOf("横浜市").includes("横浜"));
  assert.ok(variantsOf("渋谷区").includes("渋谷"));
  // 町・村は落としません。青森県の「横浜町」を、神奈川の「横浜」と
  // 書いた人に返さないためです。
  assert.ok(!variantsOf("横浜町").includes("横浜"));
  // 2文字未満になるものは返しません。「港区」→「港」は、空港にも
  // 港町にも当たってしまいます。
  assert.ok(!variantsOf("港区").includes("港"));
});

test("「横浜」と書いたら、神奈川の横浜が出る", () => {
  const areas = detectAreas("横浜の人が少ない静かな場所で自然を感じたい", KB);
  assert.equal(areas.length, 1, `拾いすぎ／拾えていません: ${areas.map((a) => a.term)}`);
  assert.equal(areas[0].term, "横浜");
  assert.deepEqual(areas[0].prefectures, ["神奈川県"],
    "青森県の横浜町を巻き込んでいます");
});

test("同じ地名に当たるエリアは、まとめる", () => {
  // ここは2つ目以降を捨てていました。収録が細かくなるほど、書いた地名
  // から遠ざかるという妙なことになります。
  const areas = detectAreas("横浜へ行きたい", KB);
  const ids = areas[0].regionIds;
  assert.ok(ids.includes("n0458"), "横浜市が入っていません");
  assert.ok(ids.includes("yokohama"),
    "横浜みなとみらい（77スポット）が外れています");
  assert.ok(!ids.includes("n0632"), "青森県の横浜町が入っています");
});

test("完全な名前で書かれたときも、これまでどおり", () => {
  assert.equal(detectAreas("箱根でゆっくり", KB)[0]?.term, "箱根");
  assert.equal(detectAreas("江東区を歩く", KB)[0]?.term, "江東区");
  assert.deepEqual(detectAreas("温泉でゆっくり", KB), []);
});
