// プラグイン第1版（packages/core/plugins.mjs、docs/plugins.md）の試験。
// 脅威モデルの「試験で確かめること」と1つずつ対応しています。

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyConstraints, applyTemplate, findTemplate, loadPlugins, pluginDir, scanPlugins,
  trustPlugin, untrustPlugin, validateManifest,
} from "../packages/core/plugins.mjs";

const SAMPLE = new URL("../examples/plugins/jp.tabisaki.sample/", import.meta.url);
const sample = () => JSON.parse(readFileSync(new URL("tabisaki-plugin.json", SAMPLE), "utf8"));

function tmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tabisaki-plugins-"));
  cpSync(SAMPLE, path.join(dir, "jp.tabisaki.sample"), { recursive: true });
  return dir;
}

test("見本のプラグインは宣言として正しい", () => {
  assert.deepEqual(validateManifest(sample()).errors, []);
});

test("宣言: 知らない項目・コードを指す項目・版のちがいを断る", () => {
  const bad = (patch) => validateManifest({ ...sample(), ...patch }).errors.join(" / ");
  assert.match(bad({ main: "index.js" }), /知らない項目: main/);
  assert.match(bad({ permissions: ["network"] }), /知らない項目: permissions/);
  assert.match(bad({ api: 2 }), /api は 1/);
  assert.match(bad({ id: "../evil" }), /id は/);
  assert.match(bad({ homepage: "http://x.example" }), /https/);
  assert.match(bad({ contributes: { hooks: [] } }), /知らない項目: hooks/);
  assert.match(bad({ contributes: {} }), /どちらかが要ります/);
  const t = sample();
  t.contributes.templates[0].script = "alert(1)";
  t.contributes.templates[0].days = 99;
  const e = validateManifest(t).errors.join(" / ");
  assert.match(e, /知らない項目: script/);
  assert.match(e, /days は1〜14/);
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
});

test("置いただけでは使わない。trust で控えると使い、untrust で外れる", async () => {
  const dir = tmpDir();
  assert.equal((await scanPlugins(dir))[0].status, "untrusted");
  assert.deepEqual(await loadPlugins(dir), []);
  await trustPlugin(dir, "jp.tabisaki.sample");
  assert.equal((await loadPlugins(dir)).length, 1);
  assert.equal(await untrustPlugin(dir, "jp.tabisaki.sample"), true);
  assert.deepEqual(await loadPlugins(dir), []);
  assert.equal(await untrustPlugin(dir, "jp.tabisaki.sample"), false);
});

test("控えたあとに中身が変わったら、控え直すまで止まる", async () => {
  const dir = tmpDir();
  await trustPlugin(dir, "jp.tabisaki.sample");
  const file = path.join(dir, "jp.tabisaki.sample", "tabisaki-plugin.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  m.contributes.constraints[0].exclude_categories = ["寺院", "神社"];
  writeFileSync(file, JSON.stringify(m));
  assert.equal((await scanPlugins(dir))[0].status, "changed");
  assert.deepEqual(await loadPlugins(dir), []);
});

test("置き場所の外を指すリンク・大きすぎるファイル・名前ちがいは読まない", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tabisaki-plugins-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "outside-"));
  cpSync(SAMPLE, path.join(outside, "jp.tabisaki.sample"), { recursive: true });
  symlinkSync(path.join(outside, "jp.tabisaki.sample"), path.join(dir, "jp.tabisaki.sample"));
  assert.deepEqual(await scanPlugins(dir), []);

  mkdirSync(path.join(dir, "big"));
  writeFileSync(path.join(dir, "big", "tabisaki-plugin.json"), " ".repeat(70 * 1024));
  mkdirSync(path.join(dir, "other.name"));
  writeFileSync(path.join(dir, "other.name", "tabisaki-plugin.json"), JSON.stringify(sample()));
  mkdirSync(path.join(dir, "link.file"));
  symlinkSync("/etc/hostname", path.join(dir, "link.file", "tabisaki-plugin.json"));
  const all = await scanPlugins(dir);
  const by = Object.fromEntries(all.map((x) => [x.id, x]));
  assert.match(by.big.errors.join(), /64KB/);
  assert.match(by["other.name"].errors.join(), /フォルダの名前/);
  assert.match(by["link.file"].errors.join(), /ふつうのファイル/);
  assert.ok(all.every((x) => x.status === "invalid"));
  await assert.rejects(trustPlugin(dir, "big"), /まちがい/);
});

test("ひな形: 言葉が合えば頼みに重ね、利用者が書いた値が勝つ", () => {
  const plugins = [{ id: "jp.tabisaki.sample", manifest: sample() }];
  const found = findTemplate("湯治がしたい", plugins);
  assert.equal(found.template.name, "静かな温泉旅");
  assert.equal(findTemplate("京都の寺", plugins), null);
  const r = applyTemplate({ wish: "湯治がしたい", days: 3 }, found);
  assert.equal(r.days, 3);
  assert.equal(r.transport, "transit");
  assert.match(r.wish, /温泉/);
});

test("除外: カテゴリと id で外し、引き出しも作り直す。もとの kb は変えない", () => {
  const spots = [
    { id: "a", regionId: "r", category: "遊園地" },
    { id: "b", regionId: "r", category: "温泉" },
    { id: "c", regionId: "r", category: "寺院" },
  ];
  const kb = { spots, spotsById: new Map(), spotsByRegion: new Map() };
  const m = sample();
  m.contributes.constraints.push({ name: "c を外す", exclude_spot_ids: ["c"] });
  const out = applyConstraints(kb, [{ id: "x", manifest: m }]);
  assert.deepEqual(out.spots.map((s) => s.id), ["b"]);
  assert.deepEqual([...out.spotsById.keys()], ["b"]);
  assert.equal(out.spotsByRegion.get("r").length, 1);
  assert.equal(kb.spots.length, 3);
  assert.equal(applyConstraints(kb, []), kb);
});

test("置き場所は TABISAKI_PLUGIN_DIR、無ければ ~/.config/tabisaki/plugins", () => {
  assert.equal(pluginDir({ TABISAKI_PLUGIN_DIR: "/x" }), "/x");
  assert.equal(pluginDir({ XDG_CONFIG_HOME: "/c" }), path.join("/c", "tabisaki", "plugins"));
});

test("core: 控えたプラグインで旅程を組むと、ひな形と除外が効く", async () => {
  const realFetch = globalThis.fetch;
  const { createCore } = await import("../packages/core/index.mjs");
  const plugins = [{ id: "jp.tabisaki.sample", manifest: sample() }];
  try {
    const core = await createCore({ plugins });
    assert.ok(core.kb.spots.every((s) => s.category !== "遊園地" && s.category !== "商店街"));
    const r = await core.plan({ wish: "湯治", date: "2026-11-07" });
    assert.deepEqual(r.template, { plugin: "jp.tabisaki.sample", name: "静かな温泉旅" });
    assert.equal(r.request.days, 2);
  } finally { globalThis.fetch = realFetch; }
});
