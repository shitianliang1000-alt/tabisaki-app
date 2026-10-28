// 声で希望を書く（入力欄の横のマイク）。
//
// ブラウザの音声認識（Web Speech API）を使います。旅さきのサーバーには
// 声も文字も送りません。ただし Chrome・Safari の多くは、**ブラウザの会社の
// 音声認識サーバー（Google・Apple など）に声を送って文字にします。**
//
// なので、はじめの1回だけ、そう書いた案内を出してから聞き始めます
// （もう一度押すと始まります）。
//
// 端末の中だけで文字にする指定（Chrome の processLocally と
// SpeechRecognition.available）は、まだ使いません。2026-10 の Chromium では
// available() を呼ぶと画面ごと落ちる場合がありました（試験用の headless）。
// 落ちないと確かめられたら足します（docs/calendar-and-voice.md の段階 3）。聞き取った文は**入力欄に入れるだけ**で、
// 送りません。読んで直してから、人が送ります。聞き違いのまま旅程を組むと、
// 気づかないまま違う旅になるからです（docs/calendar-and-voice.md）。

export const VOICE_CONSENT_KEY = "tabisaki.voice.cloudOk";
const LANG = "ja-JP";

/** 音声認識のコンストラクタ。無いブラウザ（Firefox など）では null。 */
export function speechCtor(win = globalThis) {
  return win?.SpeechRecognition ?? win?.webkitSpeechRecognition ?? null;
}

/**
 * 聞き取った文を、欄のカーソルの位置に入れます。
 * 前後の文とつながるように、要るときだけ区切りを足します。
 * @returns {{value: string, caret: number}}
 */
export function insertHeard(current, heard, start = current.length, end = start) {
  const text = String(heard ?? "").trim();
  if (!text) return { value: current, caret: end };
  const before = current.slice(0, start);
  const after = current.slice(end);
  // 日本語どうしは詰めて、句点の無い文のあとには「、」を挟みます。
  const sep = !before || /[\s、。！？!?,.\n]$/.test(before) ? "" : "、";
  const value = before + sep + text + after;
  return { value, caret: (before + sep + text).length };
}

const MESSAGES = {
  "not-allowed": "マイクが許可されていません。ブラウザの設定で、このサイトのマイクを許可してください。",
  "service-not-allowed": "このブラウザでは、声での入力が使えません。",
  "no-speech": "聞き取れませんでした。もう一度押して、話してみてください。",
  "audio-capture": "マイクが見つかりません。",
  network: "音声認識につながりませんでした。電波のよいところで試すか、文字で書いてください。",
  "language-not-supported": "このブラウザは日本語の聞き取りに対応していません。",
};

/**
 * マイクのボタンを動くようにします。使えないブラウザでは、ボタンは隠したままです。
 *
 * @param {object} o
 * @param {HTMLButtonElement} o.button
 * @param {HTMLTextAreaElement} o.field
 * @param {(text: string|null) => void} o.hint 案内を出す（null で消す）
 * @param {Window} [o.win]
 * @param {Storage} [o.storage]
 * @returns {boolean} 使えるかどうか
 */
export function setupVoiceInput({ button, field, hint, win = globalThis, storage = win?.localStorage }) {
  const Ctor = speechCtor(win);
  if (!Ctor || !button || !field) return false;
  button.hidden = false;

  let rec = null;
  let warned = false;

  const consented = () => {
    try { return storage?.getItem(VOICE_CONSENT_KEY) === "1"; } catch { return false; }
  };
  const consent = () => {
    try { storage?.setItem(VOICE_CONSENT_KEY, "1"); } catch { /* 保存できなくても、この回は使えます */ }
  };
  const setListening = (on) => {
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.setAttribute("aria-label", on ? "聞き取りを止める" : "声で書く");
    button.title = on ? "聞き取りを止める" : "声で書く";
    button.classList.toggle("is-listening", on);
  };
  setListening(false);

  const start = () => {
    rec = new Ctor();
    rec.lang = LANG;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const from = field.selectionStart ?? field.value.length;
    const to = field.selectionEnd ?? from;
    let finalText = "";
    let failed = false;

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      hint(interim ? `聞き取り中: ${interim}` : (finalText ? `聞き取り中: ${finalText}` : "どうぞ、話してください"));
    };
    rec.onerror = (e) => {
      failed = true;
      if (e.error === "aborted") return;
      hint(MESSAGES[e.error] ?? "聞き取りがうまくいきませんでした。文字で書いてください。");
    };
    rec.onend = () => {
      rec = null;
      setListening(false);
      if (finalText.trim()) {
        const { value, caret } = insertHeard(field.value, finalText, from, to);
        field.value = value;
        field.focus();
        field.setSelectionRange?.(caret, caret);
        // 欄の高さ・移動のしかたの表示・保存を、手で書いたときと同じに動かします。
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        hint("聞き取った文を欄に入れました。読んで直してから送ってください。");
      } else if (!failed) {
        hint(MESSAGES["no-speech"]);
      }
    };
    try {
      rec.start();
      setListening(true);
      hint("どうぞ、話してください");
    } catch {
      rec = null;
      setListening(false);
      hint("聞き取りを始められませんでした。少し待ってから押してください。");
    }
  };

  button.addEventListener("click", () => {
    if (rec) { rec.stop(); return; }
    if (!consented()) {
      if (!warned) {
        warned = true;
        hint("声は、このブラウザの音声認識（Google・Apple など、ブラウザの会社のサーバー）に送られて文字になります。"
          + "旅さきには届きません。よければ、もう一度マイクを押してください。");
        return;
      }
      consent();
    }
    start();
  });
  return true;
}
