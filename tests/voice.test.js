// 声で書く（js/voice.js）の試験。ブラウザの音声認識は偽物に替えて確かめます。

import assert from "node:assert/strict";
import test from "node:test";

import { VOICE_CONSENT_KEY, insertHeard, setupVoiceInput, speechCtor } from "../js/voice.js";

test("聞き取った文を、カーソルの位置に入れる", () => {
  assert.deepEqual(insertHeard("", "温泉に行きたい"), { value: "温泉に行きたい", caret: 7 });
  assert.equal(insertHeard("箱根で", "温泉に入りたい").value, "箱根で、温泉に入りたい");
  assert.equal(insertHeard("箱根で。", "温泉").value, "箱根で。温泉");
  assert.deepEqual(insertHeard("AB", "x", 1, 1), { value: "A、xB", caret: 3 });
  assert.equal(insertHeard("そのまま", "  ").value, "そのまま");
});

test("音声認識の無いブラウザでは、マイクを出さない", () => {
  assert.equal(speechCtor({}), null);
  const button = fakeEl();
  assert.equal(setupVoiceInput({ button, field: fakeField(), hint() {}, win: {} }), false);
  assert.equal(button.hidden, true);
});

function fakeEl() {
  const attrs = {};
  const handlers = {};
  return {
    hidden: true, title: "",
    classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); } },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return attrs[k]; },
    addEventListener(t, f) { handlers[t] = f; },
    click() { return handlers.click?.(); },
  };
}

function fakeField(value = "") {
  const events = [];
  return {
    value, selectionStart: value.length, selectionEnd: value.length, events,
    focus() {}, setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    dispatchEvent(e) { events.push(e.type); },
  };
}

/** 偽の音声認識。最後に作られたものを Fake.last に置きます。 */
function makeFake() {
  class Fake {
    constructor() { Fake.last = this; this.started = false; }
    start() { this.started = true; }
    stop() { this.onend?.(); }
    say(text) {
      const r = [{ transcript: text }];
      r.isFinal = true;
      this.onresult?.({ resultIndex: 0, results: [r] });
      this.onend?.();
    }
  }
  return Fake;
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
}

test("同意のあとは、押すとすぐ聞き始め、欄に入れるだけで送らない", () => {
  const Fake = makeFake();
  const storage = memoryStorage();
  storage.setItem(VOICE_CONSENT_KEY, "1");
  const button = fakeEl();
  const field = fakeField("箱根で");
  const hints = [];
  assert.equal(setupVoiceInput({ button, field, hint: (t) => hints.push(t), win: { SpeechRecognition: Fake }, storage }), true);
  assert.equal(button.hidden, false);
  button.click();
  assert.equal(Fake.last.started, true);
  assert.equal(Fake.last.lang, "ja-JP");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  Fake.last.say("温泉に入りたい");
  assert.equal(field.value, "箱根で、温泉に入りたい");
  assert.deepEqual(field.events, ["input", "change"]);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.match(hints.at(-1), /読んで直してから送って/);
});

test("サーバーで文字にするブラウザでは、はじめに案内し、もう一度押してから聞く", async () => {
  const Fake = makeFake();
  const storage = memoryStorage();
  const button = fakeEl();
  const hints = [];
  setupVoiceInput({ button, field: fakeField(), hint: (t) => hints.push(t), win: { webkitSpeechRecognition: Fake }, storage });
  button.click();
  assert.equal(Fake.last, undefined, "1回目は聞かない");
  assert.match(hints.at(-1), /ブラウザの会社のサーバー/);
  button.click();
  assert.equal(Fake.last.started, true);
  assert.equal(storage.getItem(VOICE_CONSENT_KEY), "1");

  // 次に開いたときは、案内を繰り返しません。
  const again = fakeEl();
  const Fake2 = makeFake();
  setupVoiceInput({ button: again, field: fakeField(), hint() {}, win: { SpeechRecognition: Fake2 }, storage });
  again.click();
  assert.equal(Fake2.last.started, true);
});

test("マイクが許可されていないときは、理由を出す", () => {
  const Fake = makeFake();
  const storage = memoryStorage();
  storage.setItem(VOICE_CONSENT_KEY, "1");
  const button = fakeEl();
  const hints = [];
  setupVoiceInput({ button, field: fakeField(), hint: (t) => hints.push(t), win: { SpeechRecognition: Fake }, storage });
  button.click();
  Fake.last.onerror({ error: "not-allowed" });
  Fake.last.onend();
  assert.match(hints.at(-1), /マイクが許可されていません/);
});
