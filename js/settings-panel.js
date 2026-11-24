// 旅さき — 設定の画面（データの取り方・AI）。中身の決まりは packages/core/src/app-settings.js。
//
// スクレイピングは非推奨・自己責任です。選んだだけでは有効にせず、注意書きを読んで
// 「読んだうえで、自己責任で使います」に印を付けたときだけ有効にします。
// 公開ページを読むのは携帯アプリ（と CUI）だけです。ブラウザでは相手のサイトに
// 断られる（CORS）うえ、サイト版はやめるので、ここでは選べないようにします。

import {
  SCRAPE_CONSENT_TEXT, defaultAppSettings, isModelName, loadAppSettings, saveAppSettings, scrapeConsentNow,
} from "../packages/core/src/app-settings.js";
import { isNativeApp } from "./native.js";

/**
 * @param {{dialog: HTMLDialogElement, consent: HTMLDialogElement, native?: boolean,
 *          storage?: Storage, onSaved?: (value: object) => void}} opts
 */
export function setupSettingsPanel({ dialog, consent, native = isNativeApp(), storage, onSaved = () => {} }) {
  const form = dialog.querySelector("#settings-form");
  const err = dialog.querySelector("#settings-error");
  const note = dialog.querySelector("#settings-scrape-note");
  const scrapeRadio = form.querySelector('input[name="dataSource"][value="scrape"]');
  const model = form.querySelector("#settings-ai-model");
  const base = form.querySelector("#settings-ai-base");
  let current = loadAppSettings(storage);
  let pendingConsent = null;

  consent.querySelector("#scrape-consent-text").textContent = SCRAPE_CONSENT_TEXT;
  const check = consent.querySelector("#scrape-consent-check");
  const yes = consent.querySelector("#scrape-consent-yes");
  check.addEventListener("change", () => { yes.disabled = !check.checked; });

  function showError(list) {
    err.hidden = !list.length;
    err.textContent = list.join("\n");
  }

  function fill(v) {
    form.querySelector(`input[name="dataSource"][value="${v.dataSource}"]`).checked = true;
    form.querySelector(`input[name="aiSource"][value="${v.ai.source}"]`).checked = true;
    model.value = v.ai.model;
    base.value = v.ai.base;
    model.placeholder = defaultAppSettings().ai.model;
    base.placeholder = defaultAppSettings().ai.base;
    if (!native) {
      scrapeRadio.disabled = true;
      note.hidden = false;
      note.textContent = "スクレイピングは携帯アプリと CUI（tabisaki settings）だけで使えます。";
    } else if (v.dataSource === "scrape" && v.scrapeConsent) {
      note.hidden = false;
      note.textContent = `注意書きに同意: ${new Date(v.scrapeConsent.at).toLocaleString("ja-JP")}`;
    } else {
      note.hidden = true;
    }
    showError([]);
  }

  /** 注意書きを出し、同意したら true。 */
  function askConsent() {
    check.checked = false;
    yes.disabled = true;
    return new Promise((resolve) => {
      const done = (ok) => { consent.close(); resolve(ok); };
      consent.querySelector("#scrape-consent-no").onclick = () => done(false);
      yes.onclick = () => done(check.checked);
      consent.oncancel = () => resolve(false);
      consent.showModal();
    });
  }

  scrapeRadio.addEventListener("change", async () => {
    if (!scrapeRadio.checked || current.dataSource === "scrape") return;
    const ok = await askConsent();
    if (ok) {
      pendingConsent = scrapeConsentNow();
    } else {
      pendingConsent = null;
      form.querySelector('input[name="dataSource"][value="api"]').checked = true;
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const dataSource = String(data.get("dataSource") ?? "api");
    const errors = [];
    for (const [label, input] of [["モデル名", model], ["元にした Gemma 4", base]]) {
      if (input.value.trim() && !isModelName(input.value.trim())) errors.push(`${label}に使えない文字があります（英数字と . _ : / - だけ）`);
    }
    if (errors.length) return showError(errors);
    const next = {
      dataSource,
      scrapeConsent: dataSource === "scrape" ? (pendingConsent ?? current.scrapeConsent) : null,
      ai: { source: String(data.get("aiSource") ?? "own"), model: model.value.trim(), base: base.value.trim() },
    };
    const r = saveAppSettings(next, storage);
    if (!r.ok) return showError(r.errors);
    current = r.value;
    pendingConsent = null;
    onSaved(current);
    dialog.close();
  });
  dialog.querySelector("#settings-close").addEventListener("click", () => dialog.close());

  return {
    open() {
      current = loadAppSettings(storage);
      pendingConsent = null;
      fill(current);
      dialog.showModal();
    },
  };
}
