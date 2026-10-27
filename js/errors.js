// 技術的なエラーを、旅行者の言葉に翻訳する。
//
// 「Routes API: HTTP 403 API key restriction」は、開発者には有益ですが、
// 旅行者には何のことか分かりません。旅行者が知りたいのは一点だけです。
//
//   「それで、旅程は作れるのか」
//
// なので二層に分けます。
//
//   表 … 何が起きて、旅程はどうなるのか
//   裏 … 元のエラーそのまま（「技術的な詳細」を開いた人だけ見る）
//
// もうひとつ。キーが未設定なだけのときに「エラー」「失敗」と書かない
// ようにしています。設定していないのは選択であって、失敗ではありません。

/** 種類ごとの言いかた。原因（4xx など）で少し出し分けます。 */
const KINDS = {
  routes: {
    title: "正確な交通情報を取得できませんでした",
    body: "いまは通常時の所要時間から計算しています。"
      + "旅程そのものは作成できますが、"
      + "電車の乗換や待ち時間は実際と異なる場合があります。",
    blocking: false,
    next: "そのまま旅程を作れます。出発前に、乗換案内で時刻をご確認ください。",
  },
  ai: {
    title: "AIによる選定を行えませんでした",
    body: "収録済みのデータから、語句検索で行き先を選んでいます。"
      + "旅程は作成できますが、収録に無い土地は提案できません。",
    blocking: false,
    next: "そのまま旅程を作れます。収録されている全国1,383エリアから選びます。",
  },
  weather: {
    title: "天気を取得できませんでした",
    body: "旅程はそのまま作成できます。"
      + "雨や日没を見た組み直しの提案だけが出ません。",
    blocking: false,
    next: "そのまま旅程を作れます。当日の天気は、別途ご確認ください。",
  },
  photo: {
    title: "写真を取得できませんでした",
    body: "旅程はそのまま作成できます。写真の代わりに、"
      + "場所ごとの色の絵を出しています。",
    blocking: false,
    next: "そのまま旅程を作れます。",
  },
  quota: {
    title: "APIの使用をここで止めています",
    body: "使用量の確認で「やめる」を選ばれたため、"
      + "ここから先は経路検索とAIを呼んでいません。"
      + "移動時間は距離からの推定、行き先は語句検索で選んでいます。"
      + "続けるときは、設定から「数え直す」を押してください。",
    blocking: false,
    next: "このまま作るか、設定から「数え直す」を押して再開できます。",
  },
  kb: {
    title: "データを読み込めませんでした",
    body: "知識ベース（kb フォルダ）を読み込めないため、"
      + "旅程を作れません。サーバ経由で開いているか、"
      + "kb/ が同じ場所にあるかをご確認ください。",
    blocking: true,
    next: "web/ フォルダで `python3 -m http.server 8000` を実行し、"
      + "http://localhost:8000 から開き直してください。",
  },
  // 旅程を組む途中で、通信そのものが切れたとき。
  //
  // 旅先のデータは県ごとに分けてあり、要るぶんだけ取りにいきます
  // （packages/core/src/kb.js）。一度開いた土地は端末に残りますが、まだ開いていない
  // 土地は圏外では読めません。そのとき画面に出ていたのは、ブラウザの
  // 原文「Failed to fetch」だけでした。
  offline: {
    title: "圏外のため、この土地のデータを読み込めませんでした",
    body: "旅先のデータは、一度開いた土地のぶんだけ端末に残ります。"
      + "まだ開いていない土地は、圏外では旅程を組めません。"
      + "保存した旅程は、このまま開けます。",
    blocking: true,
    next: "つながったら、もう一度「旅程をつくる」を押してください。",
  },
  network: {
    title: "通信が途中で切れました",
    body: "旅先のデータを取りにいく途中で、通信が切れました。"
      + "入力した条件はそのまま残っています。",
    blocking: true,
    next: "もう一度「旅程をつくる」を押してください。",
  },
};

/**
 * ブラウザが通信に失敗したときの原文か。
 *
 * fetch の失敗は、ブラウザごとに言いかたが違います（Chrome は
 * 「Failed to fetch」、Firefox は「NetworkError when attempting to fetch
 * resource.」、Safari は「Load failed」）。どれも利用者には読めません。
 */
export function isNetworkFailure(raw) {
  const detail = String(raw?.message ?? raw ?? "");
  return /Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED|network error/i
    .test(detail);
}

const FALLBACK = {
  title: "うまくいきませんでした",
  body: "もう一度お試しください。何度も起きる場合は、"
    + "下の「技術的な詳細」の内容をお知らせください。",
  blocking: false,
  next: "もう一度「旅程をつくる」を押してみてください。",
};

/** 未設定は「失敗」ではないので、言いかたを変えます。 */
const NOT_SET = {
  routes: {
    title: "経路検索を使わない設定になっています",
    body: "移動時間は距離からの推定です。旅程は作成できますが、"
      + "実際のダイヤは反映されません。",
    next: "そのまま旅程を作れます。実際のダイヤが要るときは、"
      + "設定 →「開発者向け」から Routes API のキーを入れてください"
      + "（packages/core/src/config.js の MAPS_API_KEY でも構いません）。",
  },
  ai: {
    title: "AIを使わない設定になっています",
    body: "収録済みのデータから、語句検索で行き先を選んでいます。"
      + "旅程は作成できます。",
    next: "そのまま旅程を作れます。収録に無い土地も調べたいときは、"
      + "設定 →「開発者向け」から Gemini のキーを入れてください"
      + "（packages/core/src/config.js の GEMINI_API_KEY でも構いません）。",
  },
};

/**
 * 旅行者に見せる文と、開発者向けの原文を返します。
 *
 * @param {string} kind "routes" | "ai" | "weather" | "photo" | "quota" | "kb"
 *                      | "offline" | "network"
 * @param {string|Error} raw 元のエラー
 * `next` は「次に何をすればいいか」です。
 *
 * 何が起きたかだけを伝えても、読んだ人は止まります。多くの場合、
 * 答えは「そのまま旅程は作れます」です。それを書かないと、
 * 直さないと先へ進めないもののように見えます。
 *
 * @returns {{title:string, body:string, next:string, detail:string,
 *            blocking:boolean, hint:string}}
 */
export function userFacing(kind, raw) {
  const detail = String(raw?.message ?? raw ?? "").trim();
  const base = KINDS[kind] ?? FALLBACK;

  // キーが未設定なだけのときは、責める言い方をしません
  if (/未設定|no-key|not configured/i.test(detail) && NOT_SET[kind]) {
    return { ...base, ...NOT_SET[kind], detail, hint: hintFor(kind, detail) };
  }
  return { ...base, detail, hint: hintFor(kind, detail) };
}

/**
 * 開発者向けの手がかり。原因が分かる場合だけ添えます。
 * 分からないものに、それらしい原因を書かないこと。
 */
function hintFor(kind, detail) {
  if (kind === "routes") {
    if (/\b403\b/.test(detail)) {
      return "Cloud コンソールで ①Routes API の有効化 ②請求先の紐付け "
        + "③キーのAPI制限に Routes API を追加 ④HTTPリファラー制限に"
        + "現在のURLを追加、の順にご確認ください。";
    }
    if (/\b400\b/.test(detail)) {
      return "リクエストの形が受け付けられませんでした。"
        + "公共交通に経由地を付けていないか、フィールドマスクが"
        + "モードと合っているかをご確認ください。";
    }
    if (/\b429\b/.test(detail)) return "呼び出しの上限に達しています。";
  }
  if (kind === "ai") {
    if (/\b40[13]\b/.test(detail)) {
      return "キーが拒否されました。Google AI Studio でキーを作り直すか、"
        + "そのキーで Generative Language API が有効かをご確認ください。";
    }
    if (/\b404\b/.test(detail)) {
      return "指定のモデルが見つかりません。packages/core/src/config.js の MODEL を、"
        + "利用できるモデルIDに変えてください。";
    }
  }
  return "";
}
