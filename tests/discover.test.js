// 「収録に無い土地は、AIに調べさせる」のテスト。
//
// ここで守りたいのは、調べられること自体ではなく、
// **調べた結果をそのまま信じないこと** です。
// モデルは「愛媛県」と言いながら関東の座標を返すことがあります。
// 名前と座標が食い違っていたら、旅程に入れる前に落とします。

import assert from "node:assert/strict";
import test from "node:test";

import { discoverArea, validateDiscovered } from "../packages/core/src/discover.js";
import { loadKnowledgeBase, mergeIntoKb } from "../packages/core/src/kb.js";
import { profileOf } from "../packages/core/src/feasibility.js";

/** 鳥取（収録に無い県）を調べたときの、まっとうな応答。 */
const TOTTORI = {
  areas: [{
    id: "tottori-sakyu", name: "鳥取砂丘", prefecture: "鳥取県",
    lat: 35.5390, lng: 134.2260,
    station: "鳥取駅", stationLat: 35.4900, stationLng: 134.2310,
    tagline: "日本海に面した砂の丘",
    description: "南北2km、東西16kmに広がる砂丘。",
    spots: [
      { name: "鳥取砂丘", category: "海岸", lat: 35.5390, lng: 134.2260,
        dwell: 90, open: 0, close: 24, fee: 0, fame: "major",
        description: "馬の背と呼ばれる大きな砂の丘。" },
      { name: "砂の美術館", category: "美術館", lat: 35.5352, lng: 134.2266,
        dwell: 60, open: 9, close: 18, fee: 800, fame: "known",
        description: "砂で彫刻を作る、世界唯一の美術館。" },
      { name: "白兎神社", category: "神社", lat: 35.4933, lng: 134.0994,
        dwell: 30, open: 0, close: 24, fee: 0, fame: "hidden",
        description: "因幡の白兎の神話が伝わる社。" },
    ],
  }],
};

const stub = (doc) => async () => JSON.stringify(doc);

test("収録に無い県でも、調べて候補データになる", async () => {
  const r = await discoverArea("鳥取県", { call: stub(TOTTORI), useCache: false });
  assert.equal(r.ok, true);
  assert.equal(r.regions.length, 1);
  assert.equal(r.spots.length, 3);
  assert.equal(r.regions[0].prefecture, "鳥取県");
  assert.ok(r.spots.every((s) => s.source === "ai" && s.verified === false));
});

test("調べたデータは、営業時間が入っていても「要確認」として扱う", async () => {
  const r = await discoverArea("鳥取県", { call: stub(TOTTORI), useCache: false });
  const museum = r.spots.find((s) => s.name === "砂の美術館");
  const prof = profileOf(museum);
  assert.equal(prof.open, 9);
  assert.equal(prof.close, 18);
  assert.equal(prof.estimated, true, "未確認のデータが確定値として扱われています");
});

test("県名と座標が食い違っていたら採用しない", () => {
  const r = validateDiscovered({
    areas: [{
      id: "wrong", name: "でたらめ", prefecture: "愛媛県",
      lat: 35.6812, lng: 139.7671,          // 東京駅の座標
      spots: [{ name: "何か", category: "城", lat: 35.68, lng: 139.76,
                dwell: 60, open: 9, close: 17, fee: 0 }],
    }],
  }, { term: "愛媛" });
  assert.equal(r.regions.length, 0);
  assert.match(r.rejected[0].reason, /愛媛県から\d+km/);
});

test("指定した地方の外にある県は採用しない", () => {
  const r = validateDiscovered({
    areas: [{
      id: "kamakura", name: "鎌倉", prefecture: "神奈川県",
      lat: 35.3190, lng: 139.5500,
      spots: [{ name: "鶴岡八幡宮", category: "神社", lat: 35.326, lng: 139.556,
                dwell: 45, open: 6, close: 20, fee: 0 }],
    }],
  }, { term: "四国",
       allowedPrefectures: ["徳島県", "香川県", "愛媛県", "高知県"] });
  assert.equal(r.regions.length, 0);
  assert.match(r.rejected[0].reason, /範囲外/);
});

test("「東京都」と名乗ってパリの座標を返したら弾く", () => {
  const r = validateDiscovered({
    areas: [{
      id: "paris", name: "パリ", prefecture: "東京都",
      lat: 48.8566, lng: 2.3522,
      spots: [{ name: "エッフェル塔", category: "展望台", lat: 48.85, lng: 2.29,
                dwell: 90, open: 9, close: 23, fee: 3000 }],
    }],
  }, { term: "東京" });
  assert.equal(r.regions.length, 0);
  assert.match(r.rejected[0].reason, /東京都から\d+km/);
});

test("座標として成立しないものは、名前が何であれ弾く", () => {
  const r = validateDiscovered({
    areas: [{
      id: "nowhere", name: "どこか", prefecture: "東京都",
      lat: 200, lng: 999,
      spots: [{ name: "何か", category: "城", lat: 200, lng: 999,
                dwell: 60, open: 9, close: 17, fee: 0 }],
    }],
  }, { term: "東京" });
  assert.equal(r.regions.length, 0);
  assert.match(r.rejected[0].reason, /地球の範囲外/);
});

test("営業時間が逆転しているスポットは落とす", () => {
  const bad = structuredClone(TOTTORI);
  bad.areas[0].spots[1].open = 20;
  bad.areas[0].spots[1].close = 9;
  const r = validateDiscovered(bad, { term: "鳥取県" });
  assert.equal(r.spots.length, 2);
  assert.ok(r.rejected.some((x) => /営業時間が不正/.test(x.reason)));
});

test("エリアから遠すぎるスポットは落とす", () => {
  const bad = structuredClone(TOTTORI);
  bad.areas[0].spots[2].lat = 34.6873;    // 大阪城
  bad.areas[0].spots[2].lng = 135.5259;
  const r = validateDiscovered(bad, { term: "鳥取県" });
  assert.equal(r.spots.length, 2);
  assert.ok(r.rejected.some((x) => /km離れています/.test(x.reason)));
});

test("有効なスポットが2件未満のエリアは採用しない", () => {
  const bad = structuredClone(TOTTORI);
  bad.areas[0].spots = bad.areas[0].spots.slice(0, 1);
  const r = validateDiscovered(bad, { term: "鳥取県" });
  assert.equal(r.regions.length, 0);
});

test("すでに収録している場所は重複させない", async () => {
  const kb = await loadKnowledgeBase();
  const dup = structuredClone(TOTTORI);
  dup.areas[0].spots.push({
    name: "松山城", category: "城", lat: 35.535, lng: 134.226,
    dwell: 100, open: 9, close: 16.5, fee: 520, fame: "major", description: "",
  });
  const r = validateDiscovered(dup, {
    term: "鳥取県", knownNames: new Set(kb.spots.map((s) => s.name)),
  });
  assert.ok(!r.spots.some((s) => s.name === "松山城"));
  assert.ok(r.rejected.some((x) => x.reason === "すでに収録済み"));
});

test("調べた結果は知識ベースに足せて、検索から引ける", async () => {
  const kb = await loadKnowledgeBase();
  const before = kb.spots.length;
  const r = await discoverArea("鳥取県", { call: stub(TOTTORI), useCache: false, kb });
  const added = mergeIntoKb(kb, r);
  assert.equal(added, 3);
  assert.equal(kb.spots.length, before + 3);
  assert.ok(kb.spotsByRegion.get("tottori-sakyu").length === 3);
  assert.equal(kb.regionsById.get("tottori-sakyu").name, "鳥取砂丘");
});

test("壊れた応答でも例外にせず、理由を返す", async () => {
  const r = await discoverArea("鳥取県", {
    call: async () => "すみません、分かりません。", useCache: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /調べられませんでした/);
});

test("AIに聞けないときは、例外にせず理由を返す", async () => {
  // 以前は「AIキーが無いとき」を見ていました。キーは画面から消えて
  // 中継側に移ったので、いまここで起きるのは通信そのものの失敗です。
  // 実際に外へ出しにいくと、テストが回線の状態で落ちます。
  const r = await discoverArea("鳥取県", {
    useCache: false,
    call: async () => { throw new Error("403 このサイトからは呼べません"); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /調べられませんでした/);
});


// --- 海外 -------------------------------------------------------------------

const PARIS = {
  areas: [{
    id: "paris-center", name: "パリ中心部", country: "フランス",
    lat: 48.8566, lng: 2.3522,
    station: "シャトレ＝レ・アル駅", stationLat: 48.8620, stationLng: 2.3470,
    tagline: "セーヌ川と大通りの街",
    description: "美術館と教会が徒歩圏に集まる、旧市街の中心。",
    spots: [
      { name: "ルーヴル美術館", category: "美術館", lat: 48.8606, lng: 2.3376,
        dwell: 180, open: 9, close: 18, fee: 3000, fame: "major",
        description: "世界最大級の美術館。" },
      { name: "ノートルダム大聖堂", category: "教会", lat: 48.8530, lng: 2.3499,
        dwell: 60, open: 8, close: 18.75, fee: 0, fame: "major",
        description: "シテ島に建つゴシックの大聖堂。" },
      { name: "サント・シャペル", category: "教会", lat: 48.8554, lng: 2.3450,
        dwell: 50, open: 9, close: 17, fee: 1900, fame: "known",
        description: "壁一面のステンドグラス。" },
    ],
  }],
};

test("国外の土地は取り込まない（このアプリは国内の旅だけを扱います）", () => {
  // 調べた先が日本でなければ、収録せずに理由を残します。
  // 黙って混ぜると、行けない旅程ができあがります。
  const r = validateDiscovered(PARIS, { term: "パリ", country: "フランス" });
  assert.equal(r.regions.length, 0);
  assert.match(r.rejected[0].reason, /国外/);
});

// --- 最終入場・定休日まで調べる ---------------------------------------------
// 「営業中」と「入場できる」は別なので、閉館時刻だけ調べても足りません。

const HOURS_DOC = {
  areas: [{
    id: "himeji", name: "姫路", prefecture: "兵庫県",
    lat: 34.8394, lng: 134.6939,
    station: "姫路駅", stationLat: 34.8264, stationLng: 134.6905,
    tagline: "白鷺城の城下町", description: "国宝・姫路城の城下町。",
    spots: [
      { name: "姫路城", category: "城", lat: 34.8394, lng: 134.6939,
        dwell: 100, open: 9, close: 17, lastEntry: 16, fee: 1000, fame: "major",
        closedDates: ["12-29..12-30"],
        description: "国宝・世界遺産の城。" },
      { name: "姫路市立美術館", category: "美術館",
        lat: 34.8404, lng: 134.6975,
        dwell: 60, open: 10, close: 17, fee: 500, fame: "known",
        closedDays: [1],
        description: "赤煉瓦の旧陸軍倉庫を使った美術館。" },
      { name: "書写山ロープウェイ", category: "ロープウェイ",
        lat: 34.8683, lng: 134.6339,
        dwell: 40, open: 8.5, close: 17, fee: 1200, fame: "known",
        closedSeasons: [["01-10", "01-20"]],
        description: "書写山圓教寺へ上がるロープウェイ。" },
    ],
  }],
};

test("最終入場・定休日・休業期間まで取り込む", async () => {
  const r = await discoverArea("姫路", { call: stub(HOURS_DOC), useCache: false });
  const castle = r.spots.find((s) => s.name === "姫路城");
  assert.equal(castle.hours.lastEntry, 16);
  assert.deepEqual(castle.hours.closedDates, ["12-29..12-30"]);

  const museum = r.spots.find((s) => s.name === "姫路市立美術館");
  assert.deepEqual(museum.hours.closedDays, [1]);

  const ropeway = r.spots.find((s) => s.name === "書写山ロープウェイ");
  assert.deepEqual(ropeway.hours.closedSeasons, [["01-10", "01-20"]]);
});

test("ありえない最終入場・定休日は落とす（丸ごと捨てはしない）", async () => {
  const bad = structuredClone(HOURS_DOC);
  bad.areas[0].spots[0].lastEntry = 22;      // 閉館より後
  bad.areas[0].spots[1].closedDays = [9, -1, 1];  // 曜日でない数
  bad.areas[0].spots[2].closedSeasons = [["13-40", "99-99"]];  // 日付でない
  const r = await discoverArea("姫路", { call: stub(bad), useCache: false });
  const castle = r.spots.find((s) => s.name === "姫路城");
  assert.equal(castle.hours.lastEntry, 17, "閉館より後の最終入場を丸めていません");
  const museum = r.spots.find((s) => s.name === "姫路市立美術館");
  assert.deepEqual(museum.hours.closedDays, [1], "曜日でない値を残しています");
  const ropeway = r.spots.find((s) => s.name === "書写山ロープウェイ");
  assert.deepEqual(ropeway.hours.closedSeasons ?? [], []);
});

test("調べた営業時間は、最終入場が入っていても未確認のまま", async () => {
  const { hoursFor } = await import("../packages/core/src/hours.js");
  const r = await discoverArea("姫路", { call: stub(HOURS_DOC), useCache: false });
  const castle = r.spots.find((s) => s.name === "姫路城");
  const h = hoursFor(castle, new Date("2026-09-12T10:00"));
  assert.equal(h.estimated, true, "AIが調べた値を確定情報として扱っています");
  assert.match(h.note, /未確認|確認/);
});

test("調べたデータに、いつ取ったかを残す", () => {
  // 3か月前に調べた営業時間を、今日確認したものと同じ顔で出さないため。
  return discoverArea("姫路", { call: stub(HOURS_DOC), useCache: false })
    .then((r) => {
      for (const s of r.spots) {
        assert.ok(Number.isFinite(s.fetchedAt), `${s.name} に取得日がありません`);
        assert.ok(Math.abs(Date.now() - s.fetchedAt) < 60000);
      }
    });
});

test("予約が「必須」のときだけ立てる（無難な程度では立てない）", async () => {
  const doc = structuredClone(HOURS_DOC);
  doc.areas[0].spots[0].reservationRequired = true;
  doc.areas[0].spots[0].reservationUrl = "https://example.test/book";
  doc.areas[0].spots[1].reservationRequired = "たぶん";
  doc.areas[0].spots[2].reservationUrl = "http://insecure.test";
  const r = await discoverArea("姫路", { call: stub(doc), useCache: false });
  const castle = r.spots.find((s) => s.name === "姫路城");
  assert.equal(castle.reservationRequired, true);
  assert.equal(castle.reservationUrl, "https://example.test/book");
  assert.equal(r.spots.find((s) => s.name === "姫路市立美術館")
    .reservationRequired, false);
  assert.equal(r.spots.find((s) => s.name === "書写山ロープウェイ")
    .reservationUrl, "", "http のURLを通しています");
});
