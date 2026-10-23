// 収録の名前に残った、出どころの書きかた（tools/spotname.mjs）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { cleanAll, cleanSpot, cleanSpotName, sameNamedTwins } from "../tools/spotname.mjs";

test("Wikipedia の曖昧さ回避のかっこを落とす", () => {
  assert.equal(cleanSpotName("りんご並木 (飯田市)"), "りんご並木");
  assert.equal(cleanSpotName("加茂神社 (長野市鬼無里)"), "加茂神社");
  assert.equal(cleanSpotName("厳島神社 (横浜市中区)"), "厳島神社");
  assert.equal(cleanSpotName("丸山 (新得町・上士幌町)"), "丸山");
});

test("かっこを落とすと2字以下になる記事名は、市町村を前に付ける", () => {
  assert.equal(cleanSpotName("本町 (室蘭市)"), "室蘭市本町");
  assert.equal(cleanSpotName("荻町 (白川村)"), "白川村荻町");
  // 県や旧国は付けません（「栃木県三岳」とは呼びません）。
  assert.equal(cleanSpotName("三岳 (栃木県)"), "三岳");
});

test("名前の終わりと同じことを言うかっこを落とす", () => {
  assert.equal(cleanSpotName("市営江之浦海水浴場（海水浴場）"), "市営江之浦海水浴場");
  assert.equal(cleanSpotName("古牧温泉(温泉)"), "古牧温泉");
});

test("かっこが行き先を言っているものは残す", () => {
  for (const name of ["信州新町(美術館)", "三内丸山遺跡(縄文時遊館)", "白山温泉(永井旅館)",
    "奥尻町歴史民俗資料館（休館中）", "広島県立もみのき森林公園（スキー場）", "大谷温泉(洋野町)"]) {
    assert.equal(cleanSpotName(name), name);
  }
});

test("前に付いた市町村の名前を落とす", () => {
  assert.equal(cleanSpotName("小田原市 江之浦海水浴場"), "江之浦海水浴場");
  assert.equal(cleanSpotName("茅ヶ崎市 鈴木園"), "鈴木園");
  assert.equal(cleanSpotName("西条市 光明寺"), "光明寺");
});

test("市町村を落とすと何か分からなくなるものは、空白を詰める", () => {
  assert.equal(cleanSpotName("渋川市 総合公園"), "渋川市総合公園");
  assert.equal(cleanSpotName("駒ヶ根市 スポーツ施設"), "駒ヶ根市スポーツ施設");
});

test("市町村ではない「村」「市」、自然歩道の区間は直さない", () => {
  for (const name of ["いこいの村 はりま", "七街道風土市 からむし街道", "太秦映画村 エヴァンゲリオン京都基地",
    "金屋町 千本格子の家並み", "吉野町 入野 ~ 吉野町 平尾(津風呂湖畔を巡る道)【近畿自然歩道】",
    "室生区 大野~室生区 室生【東海自然歩道】"]) {
    assert.equal(cleanSpotName(name), name);
  }
});

test("直したら元の名前を listedAs に、記事名を wikipedia に残す", () => {
  const s = { name: "りんご並木 (飯田市)", src: "wikidata" };
  assert.equal(cleanSpot(s), true);
  assert.deepEqual(s, { name: "りんご並木", src: "wikidata",
                        listedAs: "りんご並木 (飯田市)", wikipedia: "りんご並木 (飯田市)" });
  // Wikipedia から来ていないものの名前は、記事名にしません。
  const t = { name: "小田原市 江之浦海水浴場", src: "tourlist-geocoded" };
  cleanSpot(t);
  assert.equal(t.wikipedia, undefined);
  assert.equal(t.listedAs, "小田原市 江之浦海水浴場");
  // 直すところが無ければ触りません。
  const u = { name: "鶴岡八幡宮" };
  assert.equal(cleanSpot(u), false);
  assert.deepEqual(u, { name: "鶴岡八幡宮" });
});

test("直すと近くの別の場所と同じ名前になるものは、直さない", () => {
  const a = { name: "氷川神社 (港区元麻布)", regionId: "r", lat: 35.65, lng: 139.73 };
  const b = { name: "氷川神社 (港区六本木)", regionId: "r", lat: 35.66, lng: 139.73 };
  const c = { name: "りんご並木 (飯田市)", regionId: "r", lat: 35.5, lng: 137.8 };
  // 離れた別の県の同じ名前は、ぶつかりません。
  const d = { name: "白山神社 (仙台市)", regionId: "x", lat: 38.2, lng: 140.8 };
  const e = { name: "白山神社", regionId: "y", lat: 36.5, lng: 136.6 };
  const plan = cleanAll([a, b, c, d, e]);
  assert.deepEqual([...plan.values()], ["りんご並木", "白山神社"]);
  // 括弧つきの名前と、近くで同じ場所と読めるもの。
  const f = { name: "猿倉温泉 (秋田県)", regionId: "s", lat: 39.1, lng: 140.2 };
  const g = { name: "猿倉温泉(鳥海荘)", regionId: "t", lat: 39.101, lng: 140.2 };
  assert.equal(cleanAll([f, g]).size, 0);
});

test("かっこの書きかたが違うだけの同じ場所の2件は、説明のあるほうを残す", () => {
  const a = { name: "厳島神社 (横浜市中区羽衣町)", lat: 35.44317, lng: 139.63369 };
  const b = { name: "厳島神社 (横浜市中区)", lat: 35.44317, lng: 139.63369, description: "神社。" };
  // 名前は同じでも、離れていれば別の神社です。
  const c = { name: "伊賀留我神社 (四日市市羽津)", lat: 35.0, lng: 136.6 };
  const d = { name: "伊賀留我神社 (四日市市茂福)", lat: 35.002, lng: 136.6 };
  assert.deepEqual([...sameNamedTwins([a, b, c, d])], [a]);
});

test("収録に、直し残しの名前が無い", () => {
  const dir = new URL("../kb/", import.meta.url);
  const all = [];
  for (const f of readdirSync(dir).filter((x) => /^spots-.*\.json$/.test(x))) {
    all.push(...JSON.parse(readFileSync(new URL(f, dir), "utf8")).spots);
  }
  assert.deepEqual([...sameNamedTwins(all)].map((s) => s.name), []);
  const left = [...cleanAll(all).keys()].map((s) => s.name);
  assert.deepEqual(left.slice(0, 10), [], "node tools/clean_names.mjs --write で直してください");
});
