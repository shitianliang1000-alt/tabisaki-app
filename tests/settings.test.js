// 画面から入れたキーの扱いのテスト。
//
// 公開サイト（GitHub Pages）では packages/core/src/config.js を書き換えられません。
// そこで、設定画面から入れたキーを端末の localStorage に残し、
// config.js より優先して使います。ここでは、その優先順位と、
// 受け付けない形（http のプロキシ、空白の混じったキー）を固定します。

import assert from "node:assert/strict";
import test from "node:test";

import { cspAllows, effectiveConfig, loadSettings, maskKey, normalizeSettings,
         saveSettings, SETTINGS_KEY } from "../packages/core/src/settings.js";

/** localStorage の最小の代役。 */
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get size() { return m.size; },
  };
}

test("何も保存していなければ、config.js の値がそのまま効く", () => {
  const s = memStorage();
  const c = effectiveConfig(s, { geminiKey: "", mapsKey: "AIzaCONF", proxyUrl: "" });
  assert.equal(c.mapsKey, "AIzaCONF");
  assert.equal(c.from.mapsKey, "config");
  assert.equal(c.geminiKey, "");
  assert.equal(c.from.geminiKey, "none");
});

test("画面から入れたキーは config.js より優先される", () => {
  const s = memStorage();
  const r = saveSettings({ mapsKey: " AIzaSAVED " }, s);
  assert.equal(r.ok, true, r.errors.join("/"));
  const c = effectiveConfig(s, { mapsKey: "AIzaCONF" });
  assert.equal(c.mapsKey, "AIzaSAVED", "前後の空白は落として保存する");
  assert.equal(c.from.mapsKey, "settings");
});

test("空にして保存すると、config.js の値に戻る（保存自体が消える）", () => {
  const s = memStorage();
  saveSettings({ mapsKey: "AIzaSAVED" }, s);
  saveSettings({ mapsKey: "" }, s);
  assert.equal(s.getItem(SETTINGS_KEY), null);
  const c = effectiveConfig(s, { mapsKey: "AIzaCONF" });
  assert.equal(c.mapsKey, "AIzaCONF");
});

test("http のプロキシは受け付けない（中身が平文で読まれる）", () => {
  const { errors } = normalizeSettings({ proxyUrl: "http://api.example.test" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /https/);
  const s = memStorage();
  const r = saveSettings({ proxyUrl: "http://api.example.test" }, s);
  assert.equal(r.ok, false);
  assert.equal(s.size, 0, "受け付けないものは保存しない");
});

test("プロキシの末尾のスラッシュは落とす", () => {
  const { value } = normalizeSettings({ proxyUrl: "https://api.example.test/tabisaki/" });
  assert.equal(value.proxyUrl, "https://api.example.test/tabisaki");
});

test("貼り付けで紛れた引用符は落とし、中の空白は撥ねる", () => {
  const ok = normalizeSettings({ mapsKey: '"AIzaQUOTED"' });
  assert.equal(ok.value.mapsKey, "AIzaQUOTED");
  assert.equal(ok.errors.length, 0);
  const ng = normalizeSettings({ geminiKey: "AIza BROKEN" });
  assert.equal(ng.errors.length, 1);
  assert.match(ng.errors[0], /空白/);
});

test("壊れた保存内容は、無かったことにする", () => {
  const s = memStorage();
  s.setItem(SETTINGS_KEY, "{not json");
  assert.deepEqual(loadSettings(s), { proxyUrl: "", geminiKey: "", mapsKey: "" });
});

test("伏せ字は末尾4文字だけ残す", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("abcd"), "••••");
  assert.match(maskKey("AIzaSyExampleKey1234"), /^•+1234$/);
});

test("CSP の connect-src に無い入口は、繋がらないと分かる", () => {
  const doc = {
    querySelector: () => ({
      getAttribute: () => "default-src 'self'; connect-src 'self' "
        + "https://routes.googleapis.com https://*.workers.dev; img-src *",
    }),
  };
  assert.equal(cspAllows("https://routes.googleapis.com", doc), true);
  assert.equal(cspAllows("https://tabisaki-api.example.workers.dev/x", doc), true);
  assert.equal(cspAllows("https://api.example.test", doc), false);
  assert.equal(cspAllows("", doc), true, "空なら問題にしない");
});
