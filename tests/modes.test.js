// 何に乗るのかを、指定どおりに調べているか。
//
// これまで「おもな移動手段」は、所要時間の計算のしかたを変えるだけの
// 設定でした。時刻表への問い合わせには**一度も渡っていません**。
// 中継（server/worker.js）は「全部の乗り物・いちばん早い順」で
// 決め打ちだったので、
//
//   「電車で」と書いても、空路の経路が返る
//   「フェリーで」と書いても、速い陸の経路が返る（船は候補にあるのに）
//   「青春18きっぷで」と書いても、新幹線で組まれる
//
// のどれも起きます。旗（どの乗り物を使ってよいか）と、優先して採る
// 種類の2つを渡して、指定に合うものを選んでもらいます。
//
// 旗が効くことは実測で確かめました（東京→那覇を al=1 で引くと
// 4時間46分の空路、al=0 で引くと33時間39分の陸と船）。

import assert from "node:assert/strict";
import test from "node:test";

import {
  BOARDING_LEAD_MIN, KIND_NOTE, classifyLine, kindsOf, matchesPreference,
  preferredKinds, yahooFlags,
} from "../packages/core/src/modes.js";
import { routeKinds } from "../server/worker.js";

test("指定した乗り物だけ、旗が変わる", () => {
  // おまかせは全部。減らす理由がありません。
  assert.deepEqual(yahooFlags("any"),
    { al: 1, shin: 1, ex: 1, hb: 1, lb: 1, sr: 1 });
  // 「電車・バス」に空路を返すのは、指定を無視したのと同じです。
  assert.equal(yahooFlags("transit").al, 0);
  assert.equal(yahooFlags("transit").lb, 1);
  // 普通列車のみ（青春18きっぷ）。乗れない便で組んだ旅程は使えません。
  assert.equal(yahooFlags("local").shin, 0);
  assert.equal(yahooFlags("local").ex, 0);
  assert.equal(yahooFlags("local").lb, 1, "路線バスまで切る必要はありません");
  // 空路と船は、**陸を切りません**。空港・港までの移動が要ります。
  assert.equal(yahooFlags("air").al, 1);
  assert.equal(yahooFlags("air").lb, 1, "空港までのバスが要ります");
  assert.equal(yahooFlags("ferry").sr, 1);
  assert.equal(yahooFlags("ferry").lb, 1, "港までのバスが要ります");
});

test("速さより指定が先になるのは、空路と船のときだけ", () => {
  // 旗を立てるだけでは足りません。Yahoo!は「早く着く順」で並べるので、
  // 船を使ってよいことにしても、陸のほうが早ければ陸が返ります。
  assert.deepEqual(preferredKinds("ferry"), ["ferry"]);
  assert.deepEqual(preferredKinds("air"), ["air"]);
  assert.deepEqual(preferredKinds("air+car"), ["air"]);
  // 電車・普通列車・おまかせは、速い順のままでよいです（旗で足ります）。
  assert.deepEqual(preferredKinds("transit"), []);
  assert.deepEqual(preferredKinds("local"), []);
  assert.deepEqual(preferredKinds("any"), []);
});

/** 実際に Yahoo! から返ってくる書きかた（全角の英字を含みます）。 */
const LINES = [
  ["ＡＮＡ４６７便", "air"],
  ["日本航空905便", "air"],
  ["ソラシドエア１２便", "air"],
  ["スカイマーク", "air"],
  ["佐渡汽船カーフェリー", "ferry"],
  ["東海汽船", "ferry"],
  ["ジェットフォイル", "ferry"],
  ["東海道新幹線のぞみ", "shinkansen"],
  ["一畑バス・大社線(南原経由)", "bus"],
  ["高速バス・広島〜松江線", "coach"],
  ["空港連絡バス", "coach"],
  ["一畑電車北松江線", "rail"],
  ["ＪＲ山陰本線", "rail"],
];

test("路線名から、乗り物の種類が分かる", () => {
  for (const [line, kind] of LINES) {
    assert.equal(classifyLine(line).kind, kind, `${line} を読み違えています`);
  }
  // 見分けたら、呼び名も付きます（「電車」と書かれた飛行機は困ります）。
  assert.equal(classifyLine("ＡＮＡ４６７便").label, "飛行機");
  assert.equal(classifyLine("佐渡汽船カーフェリー").label, "フェリー・船");
});

test("中継と画面で、空路と船の見分けかたがそろっている", () => {
  // 中継は Cloudflare Worker として単体で動くので js/ を読み込めず、
  // 同じ見分けかたが2か所にあります。**ずれたらここで落ちます。**
  // ずれると、中継が「船の経路だ」と思って採ったものを画面が
  // 「電車」と表示する、といったことが起きます。
  for (const [line, kind] of LINES) {
    const mine = classifyLine(line).kind;
    const theirs = routeKinds({ legs: [{ line }] });
    if (kind === "air" || kind === "ferry") {
      assert.deepEqual(theirs, [kind], `中継が ${line} を見落としています`);
      assert.equal(mine, kind);
    } else {
      assert.deepEqual(theirs, [],
        `中継が ${line} を空路か船と読み違えています`);
    }
  }
});

test("経路に含まれる乗り物を、区間から数える", () => {
  const legs = [
    { line: "ＪＲ山手線" }, { line: "徒歩" }, { line: "ＡＮＡ４６７便" },
    { line: "空港連絡バス" },
  ];
  // 徒歩は乗り物として数えません（どの経路にもあります）。
  assert.deepEqual(kindsOf(legs), ["rail", "air", "coach"]);
});

test("指定に合っているかを、経路そのもので判定する", () => {
  const byFerry = [{ line: "佐渡汽船カーフェリー" }];
  const byRail = [{ line: "ＪＲ上越新幹線" }];
  assert.equal(matchesPreference(byFerry, "ferry"), true);
  assert.equal(matchesPreference(byRail, "ferry"), false,
    "船を指定したのに、陸だけの経路が「合っている」ことになっています");
  // 指定が無ければ、どれでも合っています。
  assert.equal(matchesPreference(byRail, "any"), true);
  assert.equal(matchesPreference(byRail, "transit"), true);
});

test("空港と港では、乗る前に要る時間を書く", () => {
  // **所要時間には足しません。**Yahoo!の答えには、空港・港での
  // 乗り換え時間がすでに入っています。足すと二重になります。
  // ここは「その時間で足りているか」を確かめ、旅程に添えるための
  // 目安です。
  assert.ok(BOARDING_LEAD_MIN.air >= 30);
  assert.ok(BOARDING_LEAD_MIN.ferry >= 30);
  // 断り書きは、現地で旅程が壊れないために要ることだけを書きます。
  assert.match(KIND_NOTE.air, /搭乗手続き/);
  assert.match(KIND_NOTE.ferry, /欠航/);
  assert.match(KIND_NOTE.bus, /本数/);
});
