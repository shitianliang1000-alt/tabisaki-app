// 切符のこと — 「乗れる」と「乗車券だけで乗れる」は違う。
//
// 旅程には「08:32発→11:47着・乗換1回・15,290円」と書いてあります。
// 金額は合っています（Yahoo!の答えには特急料金も入っています）。
// それでも当日、みどりの窓口の前で立ち止まります。
//
//   ・**新幹線は、乗車券のほかに特急券が要ります。** 1枚の切符では
//     ありません。自動改札に2枚まとめて入れます
//   ・**指定席か自由席か**を、買うときに決める必要があります。
//     繁忙期の指定席は、当日には売り切れています
//   ・同じ会社の路線に1日で何度も乗るなら、**1日乗車券のほうが
//     安いことがあります**
//
// ■ 言うこと・言わないこと
//
// 収録に切符の種類はありません。**持っていないものは作りません。**
//
//   言う   … 新幹線に乗る区間があること（路線名から分かります）
//   言う   … 同じ会社に1日で何回乗るか（数えれば分かります）
//   言わない … 「◯◯フリーきっぷが得です」。券の名前・値段・条件は
//              持っておらず、毎年変わります。**得かどうかは数えられ
//              ません**
//   言わない … 「指定席を取ってください」。空席は分かりません
//
// つまりここでするのは、**確かめるきっかけを置く**ことだけです。
// 「この日は一畑電車に4回乗ります。1日乗車券があるか、公式サイトで
// 確かめてください」なら、嘘になりません。

import { classifyLine } from "./modes.js";

/**
 * 路線名の頭に出てくる、鉄道会社。
 *
 * **当てにいくのは、名前がそのまま入っているものだけ**です。
 * 「ＪＲ東海道本線」からは ＪＲ が読めますが、「大社線」だけでは
 * どこの会社か分かりません。分からなければ、何も言いません。
 *
 * 全国の会社を網羅していません（網羅したふりもしません）。
 * ここに無い会社の路線は、数から外れます。
 */
const OPERATORS = [
  // 全角・半角の両方で来ます。呼ぶ側で半角に直してから当てます。
  { re: /^JR|JR(東日本|西日本|東海|北海道|九州|四国)/, name: "JR" },
  { re: /東京メトロ|営団/, name: "東京メトロ" },
  { re: /都営/, name: "都営地下鉄" },
  { re: /小田急/, name: "小田急" },
  { re: /京王/, name: "京王" },
  { re: /東急/, name: "東急" },
  { re: /京急|京浜急行/, name: "京急" },
  { re: /京成/, name: "京成" },
  { re: /東武/, name: "東武" },
  { re: /西武/, name: "西武" },
  { re: /相鉄|相模鉄道/, name: "相鉄" },
  { re: /名鉄|名古屋鉄道/, name: "名鉄" },
  { re: /近鉄|近畿日本鉄道/, name: "近鉄" },
  { re: /南海/, name: "南海" },
  { re: /阪急/, name: "阪急" },
  { re: /阪神/, name: "阪神" },
  { re: /京阪/, name: "京阪" },
  { re: /西鉄|西日本鉄道/, name: "西鉄" },
  { re: /一畑/, name: "一畑電車" },
  { re: /江ノ島電鉄|江ノ電/, name: "江ノ電" },
  { re: /箱根登山/, name: "箱根登山鉄道" },
  { re: /富士急/, name: "富士急行" },
  { re: /しなの鉄道/, name: "しなの鉄道" },
  { re: /叡山電鉄|叡電/, name: "叡山電鉄" },
  { re: /嵐電|京福/, name: "嵐電" },
  { re: /神戸電鉄/, name: "神戸電鉄" },
  { re: /北大阪急行/, name: "北大阪急行" },
  { re: /ゆりかもめ/, name: "ゆりかもめ" },
  { re: /りんかい線/, name: "りんかい線" },
  { re: /つくばエクスプレス/, name: "つくばエクスプレス" },
  { re: /新京成/, name: "新京成" },
  { re: /北陸鉄道/, name: "北陸鉄道" },
  { re: /長野電鉄/, name: "長野電鉄" },
  { re: /上田電鉄/, name: "上田電鉄" },
  { re: /伊豆急/, name: "伊豆急行" },
  { re: /伊豆箱根/, name: "伊豆箱根鉄道" },
  { re: /静岡鉄道/, name: "静岡鉄道" },
  { re: /遠州鉄道/, name: "遠州鉄道" },
  { re: /豊橋鉄道/, name: "豊橋鉄道" },
  { re: /三岐鉄道/, name: "三岐鉄道" },
  { re: /和歌山電鐵|和歌山電鉄/, name: "和歌山電鐵" },
  { re: /水島臨海/, name: "水島臨海鉄道" },
  { re: /広島電鉄|広電/, name: "広島電鉄" },
  { re: /伊予鉄/, name: "伊予鉄道" },
  { re: /とさでん/, name: "とさでん交通" },
  { re: /筑豊電気|筑豊電鉄/, name: "筑豊電気鉄道" },
  { re: /島原鉄道/, name: "島原鉄道" },
  { re: /熊本電鉄|熊本電気鉄道/, name: "熊本電気鉄道" },
  { re: /南阿蘇鉄道/, name: "南阿蘇鉄道" },
  { re: /くま川鉄道/, name: "くま川鉄道" },
  { re: /肥薩おれんじ/, name: "肥薩おれんじ鉄道" },
  { re: /ゆいレール|沖縄都市モノレール/, name: "ゆいレール" },
];

/** 全角の英数字を、半角に直します（Yahoo!は全角で返します）。 */
function ascii(s) {
  return String(s ?? "").replace(/[Ａ-Ｚａ-ｚ０-９]/g,
    (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * 路線名から、鉄道会社の名前。分からなければ null。
 *
 * **推し量りません。** 「大社線」だけでは、どこの会社か分かりません。
 */
export function operatorOf(line) {
  const s = ascii(line);
  if (!s) return null;
  // バス・船・飛行機は、ここで数えません（1日乗車券の話ではありません）。
  const kind = classifyLine(line).kind;
  if (["air", "ferry", "bus", "coach", "walk"].includes(kind)) return null;
  for (const { re, name } of OPERATORS) {
    if (re.test(s)) return name;
  }
  return null;
}

/**
 * その区間に、乗車券のほかの切符が要るか。
 *
 * **言い切れるのは新幹線だけ**です。私鉄の「特急」は、追加料金の要る
 * ものと要らないものが混ざっています（小田急ロマンスカーは要り、
 * 京急の特急は要りません）。どちらかは路線名からは決まりません。
 * 決められないことは決めず、そう書きます。
 *
 * @returns {{kind:string, text:string}|null}
 */
export function ticketNote(line) {
  const s = ascii(line);
  if (!s) return null;
  const kind = classifyLine(line).kind;
  if (kind === "shinkansen") {
    return {
      kind: "shinkansen",
      text: "新幹線は、乗車券のほかに特急券が要ります（2枚を重ねて"
        + "自動改札に入れます）。指定席か自由席かは買うときに決めます。"
        + "連休やお盆の指定席は、当日には残っていないことがあります。",
    };
  }
  // 「特急」と名前に入っているとき。**要るとは言いません。**
  //
  // 電車の区間だけを見ます。「高速バス・広島〜松江線」に特急券の話を
  // 出しても意味がありませんし、「◯◯号」はバスの便名にもあります。
  if (kind !== "rail") return null;
  if (/特急|ライナー|\d+号/.test(s) && !/快速/.test(s)) {
    return {
      kind: "express",
      text: "特急です。会社によっては、乗車券のほかに特急券や座席の"
        + "予約が要ります（要らない会社もあります）。乗る前に、"
        + "その鉄道会社のご案内をご確認ください。",
    };
  }
  return null;
}

/** 1日に同じ会社へ何回乗ったら、1日乗車券を確かめる価値があるか。 */
export const PASS_RIDES = 3;

/**
 * その日、同じ会社に何回乗るか。
 *
 * 数えるのは**乗った回数**で、区間の数ではありません（乗り換えなしで
 * 1本の電車に乗り通したら1回です）。
 *
 * @returns {Array<{operator:string, rides:number}>} 多い順
 */
export function ridesByOperator(day) {
  const count = new Map();
  for (const item of day?.items ?? []) {
    if (item.kind !== "transit") continue;
    const legs = Array.isArray(item.yahoo?.legs) ? item.yahoo.legs : [];
    for (const leg of legs) {
      const op = operatorOf(leg?.line);
      if (!op) continue;
      count.set(op, (count.get(op) ?? 0) + 1);
    }
  }
  return [...count.entries()]
    .map(([operator, rides]) => ({ operator, rides }))
    .sort((a, b) => b.rides - a.rides || a.operator.localeCompare(b.operator));
}

/**
 * その日の、1日乗車券についての一言。
 *
 * **「得です」とは言いません。** 券の名前も値段も持っていないので、
 * 得かどうかは数えられません。数えられるのは回数だけです。
 *
 * @returns {string} 書くことが無ければ空
 */
export function passNote(day) {
  const many = ridesByOperator(day).filter((r) => r.rides >= PASS_RIDES);
  if (!many.length) return "";
  const parts = many.map((r) => `${r.operator}に${r.rides}回`);
  return `この日は ${parts.join("・")} 乗ります。`
    + "1日乗車券やフリー乗車券があるかもしれません"
    + "（種類も値段もこちらでは分からないので、"
    + "その鉄道会社の公式サイトでお確かめください）。";
}

/**
 * 旅程に、切符の一言を足します。
 *
 * 時刻も経路も費用も変えません。**変えるのは説明だけ**です。
 *
 * @returns {{legs:number, days:number}} 書き足した数
 */
export function attachTickets(itin) {
  let legs = 0;
  let days = 0;
  for (const day of itin?.days ?? []) {
    for (const item of day?.items ?? []) {
      if (item.kind !== "transit") continue;
      const lines = Array.isArray(item.yahoo?.legs)
        ? item.yahoo.legs.map((l) => l?.line) : [];
      // 同じ断り書きを2つ出しません（乗換で新幹線を2本乗り継いでも、
      // 特急券の話は1回で足ります）。
      const seen = new Set();
      const notes = [];
      for (const line of lines) {
        const n = ticketNote(line);
        if (!n || seen.has(n.kind)) continue;
        seen.add(n.kind);
        notes.push(n);
      }
      if (!notes.length) continue;
      item.tickets = notes;
      legs += 1;
    }
    const pass = passNote(day);
    if (pass) { day.passNote = pass; days += 1; }
  }
  return { legs, days };
}
