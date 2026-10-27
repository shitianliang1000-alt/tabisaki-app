// ローマ字の地名と、乗り物の指定を読み取る。
//
// 画面にこう入力されていました。
//
//     I want to visit around Sendai
//
// 出てきたのは **旭川市・函館市（北海道）** です。仙台から700km離れて
// います。地名は収録の表記（「仙台市」）をそのまま探すので "Sendai" は
// 一致せず、地名の指定が無かったことになって点の高い順に返ります。
// 黙って別の場所を出すのが、いちばん困ります。

import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRomaji, placeFromRomaji, withJapanesePlaces }
  from "../packages/core/src/romaji.js";
import { readIntent } from "../packages/core/src/intent.js";

test("ローマ字の地名を、収録の表記に読み替える", () => {
  assert.equal(placeFromRomaji("Sendai"), "仙台市");
  assert.equal(placeFromRomaji("kyoto"), "京都府");
  assert.equal(placeFromRomaji("HOKKAIDO"), "北海道");
  assert.equal(placeFromRomaji("hakone"), "箱根");
  assert.equal(placeFromRomaji("banana"), null);
});

test("長音の書きかたが違っても、同じ場所として読む", () => {
  // Tokyo / Tôkyô / Toukyou / Tookyoo は、どれも同じつもりで書かれます。
  for (const w of ["Tokyo", "Tôkyô", "Toukyou", "Tookyoo", "TOKYO"]) {
    assert.equal(placeFromRomaji(w), "東京都", `${w} が読めていません`);
  }
  assert.equal(normalizeRomaji("Kyūshū"), normalizeRomaji("kyushu"));
});

test("元の文は捨てず、読み替えを足す", () => {
  assert.equal(withJapanesePlaces("I want to visit around Sendai"),
    "I want to visit around Sendai 仙台市");
  // 日本語で書いてあるなら、二重に足しません。
  assert.equal(withJapanesePlaces("仙台に行きたい"), "仙台に行きたい");
  // 地名が無ければ、そのままです。
  assert.equal(withJapanesePlaces("温泉でゆっくり"), "温泉でゆっくり");
});

// --- 乗り物の指定 -----------------------------------------------------------
//
// 「ツーリングをしたい」と書いても素通りしていました。文の中の語は
// スポット名との照合にしか使われないので、合うスポットが無ければ
// 無視されます。バイクで回りたい人に、電車の時刻表で組んだ旅程が
// 出ていました。

test("ツーリング・レンタカーは、道のりで見る", () => {
  assert.equal(readIntent("ツーリングをしたい").transport, "car");
  assert.equal(readIntent("レンタカーで九州を回る").transport, "car");
  assert.equal(readIntent("I want to go by car").transport, "car");
  assert.match(readIntent("ツーリングをしたい").notes[0], /バイク/);
});

test("歩き・自転車は、歩く速さで見る", () => {
  assert.equal(readIntent("歩いて京都を見たい").transport, "walk");
  assert.equal(readIntent("サイクリングしたい").transport, "walk");
});

test("電車の指定は、公共交通として見る", () => {
  assert.equal(readIntent("電車で回りたい").transport, "transit");
});

test("青春18きっぷは、新幹線と特急を切る指定として読む", () => {
  // ここは "transit" と同じ扱いでした。すると時刻表への問い合わせでは
  // 新幹線も有料特急も使われ、**その切符では乗れない便**で旅程が
  // 組まれます。「実際の便は時刻表でご確認ください」と添えても、
  // 確かめた先で乗れないと分かるだけです。
  assert.equal(readIntent("青春18きっぷで行く").transport, "local");
  assert.equal(readIntent("鈍行で行きたい").transport, "local");
  assert.match(readIntent("青春18きっぷで行く").notes.join(""), /普通列車と快速/);
});

test("飛行機・フェリーの指定を、そのまま読み取る", () => {
  // どちらも、これまでは**どこにも読み取られていませんでした**。
  // 「飛行機で沖縄へ」と書いても電車・バスの旅程になり、東京→那覇は
  // 33時間39分（新幹線＋船）で出ます。飛行機なら4時間46分です。
  assert.equal(readIntent("飛行機で沖縄に行きたい").transport, "air");
  assert.equal(readIntent("LCCで札幌へ").transport, "air");
  assert.equal(readIntent("フェリーで佐渡へ渡りたい").transport, "ferry");
  assert.equal(readIntent("船で小豆島へ").transport, "ferry");
  // 空路＋現地の車は、いちばん多い形です（車の指定より先に見ます）。
  assert.equal(readIntent("飛行機で行ってレンタカーを借りる").transport,
    "air+car");
  // 断り書きは、現地で旅程が壊れないために要ることだけを書きます。
  assert.match(readIntent("飛行機で沖縄に行きたい").notes.join(""),
    /搭乗手続き/);
  assert.match(readIntent("フェリーで佐渡へ渡りたい").notes.join(""), /欠航/);
});

test("夜行は、狙っている列車として読み取る", () => {
  // 夜行は毎日同じ時刻で走るので、旅程の区間として組めます
  // （packages/core/src/trains.js）。ここでは「どれを狙っているか」だけを拾います。
  assert.equal(readIntent("サンライズに乗って山陰へ").nightTrain, "any");
  assert.equal(readIntent("サンライズ出雲で出雲大社").nightTrain,
    "sunrise-izumo");
  assert.equal(readIntent("サンライズ瀬戸で四国へ").nightTrain, "sunrise-seto");
  // 列車で行くと書かれているので、電車・バスで回る旅として組みます。
  assert.equal(readIntent("サンライズに乗って山陰へ").transport, "transit");
});

test("組み込めない列車は、組み込めないと言う", () => {
  // 観光列車は運転日が限られ、指定席が要ります。時刻表からは
  // 「その日に走るか」が分かりません。分かるところまでを伝えます。
  const scenic = readIntent("観光列車に乗りたい");
  assert.ok(scenic.notes.some((n) => /運転日/.test(n)),
    "観光列車の注意が出ていません");
  assert.equal(scenic.nightTrain, null);
});

test("何も書かれていなければ、何も決めない", () => {
  const plain = readIntent("温泉でゆっくりしたい");
  assert.equal(plain.transport, null);
  assert.deepEqual(plain.notes, []);
});

// --- 区間だけ収録している列車 -----------------------------------------------

test("名前のある列車から、行き先を寄せる", () => {
  // 「サフィール踊り子に乗りたい」と書いた人は、伊豆へ行きたいはずです。
  // 列車の名前はどのエリア名とも一致しないので、これまでは地名の指定が
  // 無いことになり、点の高い順に返っていました。
  const saphir = readIntent("サフィールに乗りたい");
  assert.ok(saphir.toward.includes("下田市"),
    `行き先が寄っていません: ${saphir.toward.join(",")}`);
  assert.equal(saphir.transport, "transit");
  assert.ok(saphir.notes.some((n) => /サフィール踊り子/.test(n)));
});

test("乗ること自体が目的の列車では、行き先を寄せない", () => {
  // ななつ星は数日かけて九州を回るクルーズトレインです。抽選申し込みが
  // 要るので、「九州へ行く旅」に寄せてしまうと話が違います。
  const cruise = readIntent("ななつ星に乗りたい");
  assert.deepEqual(cruise.toward, []);
  assert.ok(cruise.notes.some((n) => /抽選/.test(n)),
    "申し込みの話が出ていません");
});

test("もう走っていない列車は、走っていないと言う", () => {
  const gone = readIntent("ムーンライトながらで行きたい");
  assert.ok(gone.notes.some((n) => /走っていません/.test(n)));
});
