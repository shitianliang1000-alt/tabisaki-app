// 利用者が選ぶ設定（データの取り方・AI）。アプリ（Capacitor）と CUI で同じ中身を使います。
//
// 何を選べるか
// ------------
// 1. データの取り方（dataSource）
//      "api"    … 公式の API・オープンデータ・収録データだけを使う。**既定**
//      "scrape" … 上に加えて、スポットの公式サイトなどの公開ページを端末から直接読む。
//                 **非推奨・自己責任**。有効にするときは注意書きに同意してもらい、
//                 同意した版（SCRAPE_CONSENT_VERSION）と日時を残します。注意書きを
//                 書き換えたら版を上げます。古い版の同意は無かったものとして "api" に戻します。
//
// 2. AI（ai）
//      source "own"    … 持ち主が学習した Gemma 4（既定）。アプリは中継（PROXY_URL）経由、
//                        CUI は手元の Ollama などで動かします。
//      source "studio" … Google AI Studio の Gemma 4（中継に置いた鍵で呼ぶ。予備）
//      model           … 自前のモデルの名前（Ollama の名前・vLLM の served-model-name）
//      base            … 元にした Gemma 4 の大きさ（表示と記録用。呼び出しには使いません）
//
// 自前のモデルについての読み
// --------------------------
// 持ち主は「Gemma 4 E26B だか、MoE のため」と書いていました。Gemma 4 に「E26B」という
// 版はありません（E2B・E4B は端末向けの小さい版の名前です）。26B で MoE なのは
// **Gemma 4 26B A4B**（全体 26B・1語あたり動くのは約 4B）なので、そう読みました。
// 違っていたら base と model を設定で差し替えるだけで済むようにしてあります。
//
// 鍵はここに置きません。アプリから AI Studio や自前のモデルの入口へは、必ず中継を通します。

export const APP_SETTINGS_KEY = "tabisaki.app-settings";

/** 注意書きを書き換えたら上げます（古い同意は効かなくなります）。 */
export const SCRAPE_CONSENT_VERSION = 1;

export const DATA_SOURCES = Object.freeze([
  Object.freeze({
    id: "api",
    label: "公式の API・オープンデータ（おすすめ）",
    note: "乗り換え・天気・地図は公式の API、スポットは収録データ（出典つき）だけを使います。",
    deprecated: false,
  }),
  Object.freeze({
    id: "scrape",
    label: "スクレイピング（非推奨・自己責任）",
    note: "上に加えて、スポットの公式サイトなどの公開ページを端末から直接読みます。",
    deprecated: true,
  }),
]);

export const DEFAULT_DATA_SOURCE = "api";

/**
 * スクレイピングを有効にする前に見せる注意書き。アプリの確認画面と CUI の確認で同じ文を使います。
 * 文を変えたら SCRAPE_CONSENT_VERSION を上げてください。
 */
export const SCRAPE_CONSENT_TEXT = [
  "スクレイピングは非推奨です。有効にする前に、次を読んでください。",
  "",
  "・読みに行くのはあなたの端末です。旅さきの中継（サーバー）は通しません。",
  "・相手のサイトの利用規約・robots.txt・著作権を守る責任は、あなたにあります。旅さきは robots.txt で断られたページは読まず、同じサイトへは間を空けて読みますが、それで規約を守れていることにはなりません。",
  "・読んだ内容（営業時間・電話など）は確かめていません。古い・まちがっている場合があります。旅程の中では「公式サイトから読んだ（未確認）」と分けて出します。",
  "・読んだ内容を、ほかの人へ配ったり、商用で使ったりしないでください。",
  "・相手のサイトの作りが変わると、黙って読めなくなります。",
  "",
  "ふだんは「公式の API・オープンデータ」のままにしてください。",
].join("\n");

export const AI_SOURCES = Object.freeze([
  Object.freeze({ id: "own", label: "自前の Gemma 4（学習済み・既定）" }),
  Object.freeze({ id: "studio", label: "Google AI Studio の Gemma 4（予備）" }),
]);

/** 自前のモデルの既定。training/pipeline.sh の NAME と同じ名前です。 */
export const DEFAULT_OWN_MODEL = Object.freeze({
  model: "tabisaki-gemma",
  base: "gemma-4-26b-a4b",
  baseLabel: "Gemma 4 26B A4B（MoE。全体 26B・動くのは約 4B）",
});

/** 名前として受け付ける形。Ollama の「名前:タグ」、HF の「組織/名前」も通します。 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

export function isModelName(s) {
  return MODEL_NAME.test(String(s ?? ""));
}

export function defaultAppSettings() {
  return {
    dataSource: DEFAULT_DATA_SOURCE,
    scrapeConsent: null,
    ai: { source: "own", model: DEFAULT_OWN_MODEL.model, base: DEFAULT_OWN_MODEL.base },
  };
}

function validConsent(c) {
  return Boolean(c && typeof c === "object" && c.version === SCRAPE_CONSENT_VERSION
    && typeof c.at === "string" && !Number.isNaN(Date.parse(c.at)));
}

/**
 * 入力を整えます。受け付けられない値は既定に戻し、理由を errors に入れます。
 * スクレイピングは、今の版の同意が無ければ "api" に戻します（黙って有効にはしません）。
 *
 * @returns {{value: ReturnType<typeof defaultAppSettings>, errors: string[]}}
 */
export function normalizeAppSettings(input = {}) {
  const value = defaultAppSettings();
  const errors = [];
  const doc = input && typeof input === "object" ? input : {};

  if (doc.dataSource !== undefined) {
    if (DATA_SOURCES.some((d) => d.id === doc.dataSource)) value.dataSource = doc.dataSource;
    else errors.push(`データの取り方は ${DATA_SOURCES.map((d) => d.id).join(" / ")} のどれかです`);
  }
  if (validConsent(doc.scrapeConsent)) {
    value.scrapeConsent = { version: doc.scrapeConsent.version, at: doc.scrapeConsent.at };
  }
  if (value.dataSource === "scrape" && !value.scrapeConsent) {
    value.dataSource = DEFAULT_DATA_SOURCE;
    errors.push("スクレイピングは注意書きに同意してから有効にしてください（公式の API に戻しました）");
  }

  const ai = doc.ai && typeof doc.ai === "object" ? doc.ai : {};
  if (ai.source !== undefined) {
    if (AI_SOURCES.some((s) => s.id === ai.source)) value.ai.source = ai.source;
    else errors.push(`AI は ${AI_SOURCES.map((s) => s.id).join(" / ")} のどれかです`);
  }
  for (const f of ["model", "base"]) {
    if (ai[f] === undefined || ai[f] === "") continue;
    const s = String(ai[f]).trim();
    if (isModelName(s)) value.ai[f] = s;
    else errors.push(`AI の${f === "model" ? "モデル名" : "元の大きさ"}に使えない文字があります（英数字と . _ : / - だけ、80文字まで）`);
  }
  return { value, errors };
}

/** スクレイピングを有効にする同意（いまの版）。 */
export function scrapeConsentNow(now = new Date()) {
  return { version: SCRAPE_CONSENT_VERSION, at: new Date(now).toISOString() };
}

/** 端末から公開ページを読んでよいか。 */
export function canScrape(settings) {
  return settings?.dataSource === "scrape" && validConsent(settings?.scrapeConsent);
}

// ---------------------------------------------------------------------------
// アプリ（localStorage）での読み書き。CUI はファイル（packages/core/app-settings-file.mjs）。

function store(storage) {
  try { return storage ?? globalThis.localStorage ?? null; } catch { return null; }
}

export function loadAppSettings(storage) {
  try {
    const raw = store(storage)?.getItem(APP_SETTINGS_KEY);
    if (!raw) return defaultAppSettings();
    return normalizeAppSettings(JSON.parse(raw)).value;
  } catch {
    return defaultAppSettings();
  }
}

/** @returns {{ok: boolean, errors: string[], value: object}} */
export function saveAppSettings(input, storage) {
  const { value, errors } = normalizeAppSettings(input);
  if (errors.length) return { ok: false, errors, value };
  try {
    const s = store(storage);
    if (!s) return { ok: false, errors: ["この環境では設定を保存できません"], value };
    s.setItem(APP_SETTINGS_KEY, JSON.stringify(value));
    return { ok: true, errors: [], value };
  } catch (e) {
    return { ok: false, errors: [`保存できませんでした（${e?.message ?? e}）`], value };
  }
}

/**
 * 中継へ AI を頼むときに本文へ添える項目。鍵は入りません。
 * 中継（server/own-model.js の pickSource）がこれを見て、投げ先を決めます。
 */
export function aiRelayFields(settings) {
  const ai = settings?.ai ?? defaultAppSettings().ai;
  return ai.source === "studio"
    ? { aiSource: "studio" }
    : { aiSource: "own", ownModel: isModelName(ai.model) ? ai.model : DEFAULT_OWN_MODEL.model };
}
