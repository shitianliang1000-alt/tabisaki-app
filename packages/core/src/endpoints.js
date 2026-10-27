// どこへ投げるかを、1か所で決める。
//
// いまの作りでは、APIキーがページを開いた人から見えます。ブラウザから
// 直接 Google を呼ぶ以上、避けられません。開発中や個人利用ならそれで
// 構いませんが、公開するなら第三者に使われて課金だけが増えます。
//
// 直しかたは、自分のバックエンドを1枚挟むことです。
//
//     ブラウザ（キーを持たない）
//        ↓
//     自分のサーバー（キーはここだけ）
//        ↓
//     Gemini / Routes API / Yahoo!路線情報
//
// `packages/core/src/config.js` の PROXY_URL にその入口を書くと、このモジュールが
// 行き先を切り替えます。**キーはヘッダーに載せません**（サーバーが
// 付けるので、ブラウザが持つ必要がありません）。
//
// 参照実装は `server/` にあります（Cloudflare Worker と Node）。

const GEMINI_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const ROUTES_URL =
  "https://routes.googleapis.com/directions/v2:computeRoutes";

/**
 * 応答を待つ上限（ミリ秒）。
 *
 * ブラウザの fetch は、相手が黙ったままだと**何分でも**待ちます。
 * 旅行者が使うのは移動中の回線で、つながったまま何も返ってこない、
 * という壊れかたをします。旅程1本で AI を数回、乗換を数十回聞くので、
 * 1回ごとに数分待つと、画面は「組み立てています…」のまま止まって
 * 見えます。
 *
 * 中継の側は上流を30秒で見切ります（server/worker.js）。ここはその外側、
 * **中継そのものが応えないとき**の歯止めです。AI の生成は、検索を伴うと
 * 30秒近くかかることがあるので、それより十分に長くしてあります。
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * AI の生成を待つ上限。中継は生成を2分まで待つので（server/worker.js の
 * AI_TIMEOUT_MS）、その返事（504 を含む）が届くよう、少し長くします。
 */
export const AI_REQUEST_TIMEOUT_MS = 135_000;

/**
 * 呼び出し側の中止（signal）と、時間切れを1つの signal にまとめます。
 *
 * AbortSignal.any は新しいブラウザにしか無いので、自前で束ねます。
 * 時間切れは TimeoutError として届き、通信の失敗と同じ扱いになります
 * （呼ぶ側は「届かなかった」として目安に落ちるか、やり直します）。
 *
 * @param {AbortSignal|null|undefined} signal 呼び出し側の中止
 * @param {number} [ms]
 * @returns {AbortSignal|undefined}
 */
export function requestSignal(signal, ms = REQUEST_TIMEOUT_MS) {
  if (!(Number.isFinite(ms) && ms > 0) || typeof AbortController !== "function") {
    return signal ?? undefined;
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) {
      ctrl.abort(signal.reason);
      return ctrl.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    // 旅程1本で同じ signal を何十回も使うので、聞き終えたら外します。
    signal?.removeEventListener("abort", onAbort);
    const reason = typeof DOMException === "function"
      ? new DOMException(`応答がありませんでした（${Math.round(ms / 1000)}秒）`,
                         "TimeoutError")
      : new Error("timeout");
    ctrl.abort(reason);
  }, ms);
  // Node では、残ったタイマーがプロセスの終了を止めます。
  timer.unref?.();
  ctrl.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

/** プロキシ経由かどうか。 */
export function usingProxy(cfg = {}) {
  return Boolean(String(cfg.proxyUrl ?? "").trim());
}

function proxyBase(cfg) {
  const raw = String(cfg.proxyUrl ?? "").trim();
  if (!raw) return "";
  if (!/^https:\/\//i.test(raw)) {
    throw new Error("PROXY_URL は https で指定してください"
      + "（http では通信の中身が読まれます）");
  }
  return raw.replace(/\/+$/, "");
}

/**
 * 投げ先のURL。
 *
 * @param {"gemini:generate"|"gemini:embed"|"gemini:models"|"routes"|"yahoo:transit"|"local:generate"} what
 * @param {{model?:string}} [args]
 * @param {{proxyUrl?:string, localBaseUrl?:string}} [cfg]
 */
export function endpointFor(what, args = {}, cfg = {}) {
  const base = proxyBase(cfg);
  if (base) {
    return `${base}/${{ "gemini:generate": "gemini/generate",
                        "gemini:embed": "gemini/embed",
                        "gemini:models": "gemini/models",
                        "local:generate": "local/generate",
                        "cf:generate": "cf/generate",
                        "routes": "routes",
                        "status": "status",
                        "yahoo:transit": "yahoo/transit",
                        "web:search": "web/search" }[what] ?? what}`;
  }
  if (what === "local:generate") {
    const raw = String(cfg.localBaseUrl ?? "").trim().replace(/\/+$/, "");
    if (!raw) throw new Error("LOCAL_BASE_URL が未設定です（packages/core/src/config.js）");
    return `${raw}/v1/chat/completions`;
  }
  if (what === "gemini:generate") {
    return `${GEMINI_ROOT}/models/`
      + `${encodeURIComponent(args.model ?? "")}:generateContent`;
  }
  if (what === "gemini:embed") {
    return `${GEMINI_ROOT}/models/`
      + `${encodeURIComponent(args.model ?? "")}:embedContent`;
  }
  // 中継を使わない（キーをブラウザに置く）ときの、モデル一覧。
  if (what === "gemini:models") return `${GEMINI_ROOT}/models?pageSize=200`;
  return ROUTES_URL;
}

/**
 * 中継に鍵が置かれているか。
 *
 * 「キーが無効です」と「中継に鍵が置かれていない」は別のことです。
 * 前者はキーを作り直す話、後者は `wrangler secret put` の話で、直す
 * 場所が違います。上流に投げる前に、どちらなのかを確かめます。
 * 中継を使っていない（キーをブラウザに置く）ときは null を返します。
 */
export async function proxyStatus(cfg = {}, signal) {
  if (!usingProxy(cfg)) return null;
  const res = await fetch(endpointFor("status", {}, cfg), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * キーのヘッダー。
 *
 * プロキシ経由なら **空を返します**。キーを持たないのがこの仕組みの
 * 目的なので、うっかり載せないよう、ここで一括して止めます。
 */
export function keyHeaders(which, cfg = {}) {
  if (usingProxy(cfg)) return {};
  if (which === "gemini") {
    return cfg.geminiKey ? { "x-goog-api-key": cfg.geminiKey } : {};
  }
  return cfg.mapsKey ? { "X-Goog-Api-Key": cfg.mapsKey } : {};
}

/**
 * 中継にキーが無いときの案内。
 *
 * 「npx wrangler secret put …」とだけ書いていました。npx が使えない人には
 * 手の打ちようがありません。しかもダッシュボードには**同じ名前の欄が
 * いくつもあり**、置き場所を間違えると、入れたのに「設定されていません」
 * と出ます。実際に2度たどりました。
 *
 *   Bindings タブ                    ← ここです（動いている Worker が読む）
 *   Settings → Builds → Variables    ← ビルド中だけの値。env には入りません
 *   Settings → Runtime               ← 置き場所・互換性日付など。変数はここに
 *                                      無いことがあります（画面の版によります）
 *
 * どこに入れるのかを、そのまま書きます。
 */
export function missingSecretHelp(name, what) {
  return `中継に${what}（${name}）が設定されていません。`
    + "\n\nCloudflare のダッシュボードから入れられます。"
    + "\n  Workers & Pages → tabisaki-github-io → 上の「Bindings」タブ"
    + "\n  → Add（追加）→ Secret"
    + `\n  名前は ${name}、値は発行したキー`
    + "\n\n※ Settings → Builds の「Variables and secrets」ではありません。"
    + "そちらはビルド中だけの値で、動いている Worker からは見えません。"
    + `\n※ コマンドで入れる場合: npx wrangler secret put ${name}`;
}

/**
 * 中継が断ったときの返事を、そのまま画面に出せる形にします。
 *
 * 入口ごとにばらばらの番号が返っていました（Googleは500、Geminiは502、
 * Yahoo!は429、Workers AIは503）。受け取る側は、どれがやり直せば通る
 * ものなのかを番号から推し量るしかなく、結局どれも「接続できません
 * でした」で片付けていました。
 *
 * いまは中継が同じ形で返します。
 *
 *   { ok:false, error:{ code, service, retryable, message, retryAfter } }
 *
 * @param {object|string} payload 中継の返事（本文）
 * @param {number} [status]
 * @returns {{code:string, service:string, retryable:boolean, message:string,
 *            retryAfter:number}}
 */
export function readProxyError(payload, status = 0) {
  let body = payload;
  if (typeof payload === "string") {
    try { body = JSON.parse(payload); } catch { body = null; }
  }
  const e = body?.error ?? {};
  const code = String(e.code ?? "")
    || (status === 429 ? "RATE_LIMITED"
      : status === 403 ? "FORBIDDEN"
      : status >= 500 ? "UPSTREAM_ERROR" : "BAD_REQUEST");
  const retryable = typeof e.retryable === "boolean"
    ? e.retryable : (status === 429 || status >= 500);
  return {
    code,
    service: String(e.service ?? "proxy"),
    retryable,
    retryAfter: Number(e.retryAfter) || 0,
    message: String(e.message ?? "") || messageFor(code),
  };
}

/**
 * 見せる言葉。
 *
 * 「500 Internal Server Error」と出しても、読んだ人にできることは
 * ありません。**次に何をすればいいか**だけを書きます。
 */
function messageFor(code) {
  switch (code) {
    case "RATE_LIMITED":
    case "UPSTREAM_LIMIT":
      return "いま利用が集中しています。時間をおいてから、もう一度お試しください。";
    case "NOT_CONFIGURED":
      return "中継にキーが設定されていません。";
    case "FORBIDDEN":
      return "このページからは呼べない設定になっています。";
    case "UPSTREAM_TIMEOUT":
      return "応答がありませんでした。時間をおいてから、もう一度お試しください。";
    case "UPSTREAM_ERROR":
      return "一時的に利用できません。時間をおいてから、もう一度お試しください。";
    default:
      return "うまくいきませんでした。";
  }
}
