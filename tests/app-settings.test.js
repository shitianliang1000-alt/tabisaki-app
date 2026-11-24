// 利用者が選ぶ設定（データの取り方・AI）。アプリと CUI で同じ決まりです。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  APP_SETTINGS_KEY, DEFAULT_OWN_MODEL, SCRAPE_CONSENT_VERSION, aiRelayFields, canScrape, defaultAppSettings,
  loadAppSettings, normalizeAppSettings, saveAppSettings, scrapeConsentNow,
} from "../packages/core/src/app-settings.js";
import { readAppSettings, writeAppSettings } from "../packages/core/app-settings-file.mjs";
import { pickLocalModel } from "../packages/core/local.mjs";

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};

test("既定は公式の API と自前の Gemma 4（26B A4B）", () => {
  const d = defaultAppSettings();
  assert.equal(d.dataSource, "api");
  assert.equal(d.scrapeConsent, null);
  assert.deepEqual(d.ai, { source: "own", model: "tabisaki-gemma", base: "gemma-4-26b-a4b" });
  assert.match(DEFAULT_OWN_MODEL.baseLabel, /MoE/);
});

test("スクレイピングは同意が無ければ有効にならず、公式の API に戻る", () => {
  const r = normalizeAppSettings({ dataSource: "scrape" });
  assert.equal(r.value.dataSource, "api");
  assert.match(r.errors.join(), /同意/);
  assert.equal(canScrape(r.value), false);
  const ok = normalizeAppSettings({ dataSource: "scrape", scrapeConsent: scrapeConsentNow(new Date("2026-11-24T00:00:00Z")) });
  assert.deepEqual(ok.errors, []);
  assert.equal(canScrape(ok.value), true);
});

test("古い版の同意は効かない（注意書きを変えたら読み直してもらう）", () => {
  const old = { version: SCRAPE_CONSENT_VERSION - 1, at: "2026-01-01T00:00:00Z" };
  const r = normalizeAppSettings({ dataSource: "scrape", scrapeConsent: old });
  assert.equal(r.value.dataSource, "api");
  assert.equal(r.value.scrapeConsent, null);
});

test("モデル名は差し替えられ、使えない文字は断る", () => {
  assert.equal(normalizeAppSettings({ ai: { model: "tabisaki-gemma4:26b-a4b" } }).value.ai.model, "tabisaki-gemma4:26b-a4b");
  assert.equal(normalizeAppSettings({ ai: { model: "org/tabisaki-gemma" } }).value.ai.model, "org/tabisaki-gemma");
  for (const bad of ["a b", "-x", "名前", "x".repeat(81)]) {
    const r = normalizeAppSettings({ ai: { model: bad } });
    assert.equal(r.value.ai.model, "tabisaki-gemma", bad);
    assert.ok(r.errors.length, bad);
  }
  assert.ok(normalizeAppSettings({ ai: { source: "openai" } }).errors.length);
  assert.ok(normalizeAppSettings({ dataSource: "ftp" }).errors.length);
});

test("アプリ: localStorage に保存し、壊れていれば既定に戻る", () => {
  const s = memStore();
  assert.deepEqual(loadAppSettings(s), defaultAppSettings());
  const r = saveAppSettings({ dataSource: "api", ai: { source: "studio" } }, s);
  assert.equal(r.ok, true);
  assert.equal(loadAppSettings(s).ai.source, "studio");
  assert.equal(saveAppSettings({ dataSource: "scrape" }, s).ok, false, "同意なしは保存しない");
  s.setItem(APP_SETTINGS_KEY, "{壊れた");
  assert.deepEqual(loadAppSettings(s), defaultAppSettings());
});

test("中継へ添える項目に鍵は入らない", () => {
  assert.deepEqual(aiRelayFields(defaultAppSettings()), { aiSource: "own", ownModel: "tabisaki-gemma" });
  assert.deepEqual(aiRelayFields({ ai: { source: "studio", model: "x" } }), { aiSource: "studio" });
});

test("CUI: 設定ファイルの読み書き（TABISAKI_HOME）", async () => {
  const env = { TABISAKI_HOME: mkdtempSync(path.join(tmpdir(), "tabisaki-settings-")) };
  assert.equal(readAppSettings(env).from, "default");
  const { file } = await writeAppSettings({ ai: { source: "own", model: "my-gemma" } }, env);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).ai.model, "my-gemma");
  assert.equal(readAppSettings(env).value.ai.model, "my-gemma");
  await assert.rejects(writeAppSettings({ dataSource: "scrape" }, env), (e) => e.code === "invalid_input");
  writeFileSync(file, "{");
  const broken = readAppSettings(env);
  assert.equal(broken.from, "default");
  assert.match(broken.errors[0], /読めません/);
});

const BIN = path.resolve("packages/cli/bin/tabisaki-plan.mjs");
const cli = (args, env, input) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", input, env: { ...process.env, ...env } });

test("CUI: tabisaki settings でデータの取り方と AI を変える（スクレイピングは同意が要る）", () => {
  const env = { TABISAKI_HOME: mkdtempSync(path.join(tmpdir(), "tabisaki-settings-")) };
  let r = cli(["settings"], env);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /データの取り方: api/);
  assert.match(r.stdout, /まだ無いので既定/);
  r = cli(["settings", "data-source", "scrape"], env, "y\n");
  assert.equal(r.status, 2, "端末でなければ --yes が要る");
  assert.match(r.stderr, /非推奨/);
  r = cli(["settings", "data-source", "scrape", "--yes"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /robots\.txt/);
  assert.match(r.stdout, /自己責任/);
  assert.match(r.stdout, /注意書きに同意/);
  r = cli(["settings", "ai", "own", "--model=tabisaki-gemma4-26b"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /モデル名: tabisaki-gemma4-26b/);
  r = cli(["settings", "data-source", "api"], env);
  const doc = JSON.parse(readFileSync(path.join(env.TABISAKI_HOME, "settings.json"), "utf8"));
  assert.equal(doc.dataSource, "api");
  assert.equal(doc.scrapeConsent, null, "戻したら同意も消す");
  assert.equal(doc.ai.model, "tabisaki-gemma4-26b");
  assert.equal(cli(["settings", "ai", "chatgpt"], env).status, 2);
  assert.equal(cli(["settings", "ai", "own", "--model=a b"], env).status, 2);
  r = cli(["settings", "reset"], env);
  assert.match(r.stdout, /モデル名: tabisaki-gemma・/);
});

function fakeTags(models) {
  return async (url) => {
    if (String(url).endsWith("/api/tags")) {
      return { ok: true, status: 200, json: async () => ({ models: models.map((name) => ({ name })) }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("--local のモデル: 自前のモデルがあればそれ、無ければ配布の Gemma 4 に落として知らせる", async () => {
  const base = "http://127.0.0.1:1";
  let r = await pickLocalModel({ baseUrl: base, preferred: "tabisaki-gemma", fetchImpl: fakeTags(["tabisaki-gemma:latest", "gemma4:e2b"]) });
  assert.equal(r.model, "tabisaki-gemma");
  assert.equal(r.note, "");
  r = await pickLocalModel({ baseUrl: base, preferred: "tabisaki-gemma", fetchImpl: fakeTags(["gemma4:e2b"]) });
  assert.equal(r.model, "gemma4:e2b");
  assert.match(r.note, /tabisaki-gemma/);
  await assert.rejects(pickLocalModel({ baseUrl: base, preferred: "tabisaki-gemma", fetchImpl: fakeTags([]) }),
    (e) => e.code === "model_missing");
  await assert.rejects(pickLocalModel({ baseUrl: base, explicit: "gemma4:e4b", preferred: "tabisaki-gemma", fetchImpl: fakeTags(["gemma4:e2b", "tabisaki-gemma"]) }),
    (e) => e.code === "model_missing", "名指ししたものは落とさない");
});
