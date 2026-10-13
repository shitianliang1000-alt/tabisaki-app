// APIの使用量に、利用者の許可という上限をかける。
//
// 経路検索もAIも、呼べば課金されます。旅程を何度も作り直しているうちに、
// 気づいたら請求が膨らんでいた——という事故を、アプリ側で止めます。
//
//   50件ごとに「続けますか」と聞き、断られたらそこで止める。
//
// 止めても旅程は作れます（距離からの推定と語句検索に落ちます）。
// 精度は下がりますが、黙って課金し続けるよりはるかにましです。

import { AI_REQUEST_TIMEOUT_MS, requestSignal } from "./endpoints.js";

const DEFAULT_EVERY = 50;
const KEY = "tabisaki.apiQuota";

export class ApiQuota {
  /**
   * @param {object} opts
   * @param {number} [opts.every]   何件ごとに許可を求めるか
   * @param {Function} opts.ask     許可を求める関数。true で続行
   * @param {object} [opts.storage] localStorage 互換（省略時はブラウザのもの）
   * @param {Function} [opts.onChange] 数や状態が変わったときに呼ばれます
   */
  constructor({ every = DEFAULT_EVERY, ask, storage, onChange } = {}) {
    this.every = Math.max(1, every);
    this.ask = ask ?? (async () => true);
    this.storage = storage ?? globalThis.localStorage ?? null;
    this.onChange = onChange ?? null;
    this.used = 0;
    this.byKind = {};
    this.blocked = false;
    /** 同時に何本も走っても、聞くのは1回にするための待ち合わせ。 */
    this.pending = null;
    this.load();
  }

  load() {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return;
      const doc = JSON.parse(raw);
      this.used = doc.used ?? 0;
      this.byKind = doc.byKind ?? {};
    } catch { /* 壊れていたら数え直しから */ }
  }

  save() {
    try {
      this.storage?.setItem(KEY,
        JSON.stringify({ used: this.used, byKind: this.byKind }));
    } catch { /* 保存できなくても動作に影響はありません */ }
    this.notify();
  }

  /**
   * 状態が変わったことを画面に伝えます。
   *
   * 「断られた」が確定するのは ask の返事が届いたあとです。画面側で
   * 返事の直後に描くと、まだ blocked が立っておらず「あと50件」と
   * 出てしまいます。知らせる側をここに一本化します。
   */
  notify() {
    try { this.onChange?.(this); } catch { /* 表示の失敗は伝播させません */ }
  }

  /**
   * 1件ぶんの許可を取ります。
   *
   * @param {string} kind "routes" / "gemini" など
   * @returns {Promise<boolean>} false なら呼んではいけません
   */
  async take(kind = "api") {
    if (this.blocked) return false;

    // 区切りに達していたら、続けてよいかを尋ねます。
    // 尋ねている最中に来た呼び出しは、同じ返事を待ちます。
    if (this.used > 0 && this.used % this.every === 0) {
      if (!this.pending) {
        this.pending = this.ask({
          used: this.used,
          byKind: { ...this.byKind },
          next: this.every,
        }).then((ok) => {
          if (!ok) { this.blocked = true; this.notify(); }
          // 次の区切りまで進めるよう、1件ぶん先に進めておきます
          if (ok) this.used += 1;
          this.pending = null;
          return ok;
        });
      }
      const ok = await this.pending;
      if (!ok) return false;
      this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
      this.save();
      return true;
    }

    this.used += 1;
    this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
    this.save();
    return true;
  }

  reset() {
    this.used = 0;
    this.byKind = {};
    this.blocked = false;
    this.pending = null;
    this.save();
  }

  /** 次に許可を求めるまで、あと何件か。 */
  get remaining() {
    if (this.blocked) return 0;
    return this.every - (this.used % this.every);
  }
}

/** アプリ全体で1つ。app.js が ask を差し替えます。 */
export const quota = new ApiQuota({});

/**
 * 許可の求め方を差し替えます。app.js が起動時に一度だけ呼びます。
 * @param {{every?:number, ask?:Function}} opts
 */
export function configureQuota({ every, ask, onChange } = {}) {
  if (Number.isFinite(every)) quota.every = Math.max(1, every);
  if (ask) quota.ask = ask;
  if (onChange) quota.onChange = onChange;
  return quota;
}

/** 断られたことを表すエラー。通信の失敗と区別できるようにします。 */
export class QuotaBlockedError extends Error {
  constructor(kind) {
    super("APIの使用量の確認で「やめる」を選ばれたため、"
      + "ここから先は呼び出しを行いません。"
      + "（旅程は推定と語句検索で作成します）");
    this.name = "QuotaBlockedError";
    this.kind = kind;
    /** HTTPの失敗ではないので 0。再試行の対象にしないための目印です。 */
    this.status = 0;
  }
}

/**
 * 数えてから通信します。断られたら通信そのものを行いません。
 *
 * 数えるだけの実装にすると、確認画面を出しながら課金が続きます。
 * 止める判断と、通信の入口を同じ場所に置くのはそのためです。
 *
 * 待つ時間にも上限を置きます。相手が黙ったままだと fetch は何分でも
 * 待つので、ここを通る呼び出しはすべて時間切れで切れるようにします
 * （endpoints.js の requestSignal）。
 *
 * @param {string} kind "routes" / "gemini"
 * @param {string} url
 * @param {object} [init] fetch にそのまま渡します
 * @param {{quota?:ApiQuota, fetchImpl?:Function, timeoutMs?:number}} [deps]
 *        試験用の差し替え口
 */
export async function meteredFetch(kind, url, init = {}, deps = {}) {
  const gate = deps.quota ?? quota;
  const send = deps.fetchImpl ?? globalThis.fetch;
  if (!(await gate.take(kind))) throw new QuotaBlockedError(kind);
  // AI の生成は長くかかるので、待つ上限も長くします。
  const signal = requestSignal(init.signal,
    deps.timeoutMs ?? (kind === "gemini" ? AI_REQUEST_TIMEOUT_MS : undefined));
  return send(url, signal ? { ...init, signal } : init);
}

/** 使用状況を、そのまま画面に出せる一文にします。 */
export function describeUsage(gate = quota) {
  const label = { routes: "経路", gemini: "AI", embed: "AI（検索用）" };
  const parts = Object.entries(gate.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${label[k] ?? k} ${n}件`);
  const head = `これまでに ${gate.used}件 のAPIを使いました`;
  const tail = parts.length ? `（内訳: ${parts.join("・")}）` : "";
  return gate.blocked ? `${head}${tail}。以降は呼び出しを止めています。`
    : `${head}${tail}。あと ${gate.remaining}件 で確認します。`;
}
