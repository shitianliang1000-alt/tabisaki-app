// 旅さき — スポットのくわしいことに出す「公式サイトから読む（未確認）」（携帯アプリだけ）。
//
// 設定でスクレイピング（非推奨・自己責任）を有効にし、注意書きに同意しているときだけ出します。
// 押したときに初めて読みに行きます（勝手に読みません）。読んだことは収録のデータとは混ぜず、
// 「公式サイトから読んだ（未確認）」として、その場に出すだけです。

import { canScrape, loadAppSettings } from "../packages/core/src/app-settings.js";
import { nativeHttpFetch } from "./native.js";

let scraper = null;

/** @returns {HTMLElement | null} */
export function scrapeButton(place, { el, settings = loadAppSettings(), fetchImpl = nativeHttpFetch() } = {}) {
  if (!place || !fetchImpl || !canScrape(settings)) return null;
  const raw = String(place.url ?? place.osmInfo?.website ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  const out = el("p", { class: "scrape-read" });
  const btn = el("button", { type: "button", class: "linkish" }, "公式サイトから営業時間を読む（未確認）");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "読んでいます…";
    try {
      const mod = await import("../packages/core/src/scrape.js");
      scraper ??= mod.createScraper({ fetchImpl });
      const r = await scraper.read(raw);
      const f = r.ok ? r.facts : null;
      const bits = f ? [f.hours.length ? `営業時間 ${f.hours.join("、")}` : "", f.phone ? `電話 ${f.phone}` : ""].filter(Boolean) : [];
      out.replaceChildren(
        el("span", {}, bits.length ? bits.join("・") : r.ok ? "ページに営業時間は書かれていませんでした。" : `読めませんでした（${r.reason}）`),
        el("small", {}, "公式サイトから読んだもので、確かめていません（スクレイピング・自己責任の設定）。"));
    } catch (e) {
      out.replaceChildren(el("span", {}, `読めませんでした（${e?.message ?? e}）`));
    }
  });
  out.append(btn);
  return out;
}
