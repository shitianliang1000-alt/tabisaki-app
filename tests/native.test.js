// 携帯アプリ（mobile/）の中で開いているときの違い（js/native.js）。
import assert from "node:assert/strict";
import test from "node:test";

import { isNativeApp, shareBase } from "../js/native.js";

const appLoc = { origin: "https://app.tabisaki", pathname: "/index.html" };
const webLoc = { origin: "https://example.workers.dev", pathname: "/app" };

test("Capacitor が無ければ、アプリではない", () => {
  assert.equal(isNativeApp(undefined), false);
  assert.equal(isNativeApp({ isNativePlatform: () => false }), false);
  assert.equal(isNativeApp({ isNativePlatform: () => true }), true);
  assert.equal(isNativeApp({ isNativePlatform: () => { throw new Error("x"); } }), false);
});

test("Web 版では、いま開いている画面のリンクを渡す", () => {
  assert.equal(shareBase(webLoc, false, "https://x.workers.dev"), "https://example.workers.dev/app");
});

test("アプリでは、端末の中の出どころではなく、公開している /app を渡す", () => {
  const url = shareBase(appLoc, true, "https://x.workers.dev/");
  assert.equal(url, "https://x.workers.dev/app");
  assert.doesNotMatch(url, /app\.tabisaki/);
});

test("公開先が分からないときは、今までどおり", () => {
  assert.equal(shareBase(appLoc, true, ""), "https://app.tabisaki/index.html");
});
