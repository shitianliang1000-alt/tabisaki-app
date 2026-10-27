// 車の旅は、電車の旅とほしいものが違う。
//
// これまで「おもな移動手段」で車を選んでも、変わるのは**所要時間の
// 計算だけ**でした。行き先の選びかたは電車のときと同じです。
// けれど、車で来ている人がほしいものは違います。
//
//   電車の旅   駅から歩いて行ける、駅前にまとまっている
//   車の旅     走って気持ちのいい道、峠、岬、湖畔、海沿い、道の駅
//
// 駅から遠いことは、車では欠点になりません。**むしろ、そこにしか
// 無いものがあります。** 逆に、電車なら便利な商店街や古い町並みは、
// 車だと駐める場所を探すところから始まります。
//
// ここは「車のときに何を好むか」を1か所に集めた表です。点の付けかたを
// 散らすと、候補を集める側と選ぶ側と説明する側で食い違います。

/**
 * 分類ごとの、車で行く楽しさ（0〜1。0.5 がふつう）。
 *
 * 高いほうは「その道を走ること自体が目的になる」場所です。峠・岬・
 * 展望台・湖・海岸。低いほうは「車だと駐めるのが難しい」場所です。
 * 行ってはいけない、という意味ではありません。並びのなかで少し
 * 後ろにする、という重みです。
 */
const APPEAL = {
  峠: 1, 岬: 0.95, 展望台: 0.92, 灯台: 0.88,
  湖: 0.85, 海岸: 0.85, 高原: 0.85, 渓谷: 0.82,
  滝: 0.8, 道の駅: 0.8, 牧場: 0.75, 名勝: 0.72,
  島: 0.7, ダム: 0.68, 山: 0.66, 自然: 0.66, 天然記念物: 0.62,
  海水浴場: 0.6, スキー場: 0.6, 温泉: 0.6,
  公園: 0.55, 城: 0.55, 庭園: 0.5, 史跡: 0.5,
  神社: 0.5, 寺院: 0.5, 教会: 0.5,
  遊園地: 0.5, 動物園: 0.5, 水族館: 0.5, 観光名所: 0.5,
  博物館: 0.45, 美術館: 0.45, 建築: 0.45,
  // ここから下は、車だと駐める場所を探すところから始まります。
  商業施設: 0.4, グルメ: 0.4, 町並み: 0.35, 市場: 0.3, 商店街: 0.25,
};

/** 高いほうの分類に添える一言。なぜ車で嬉しいのかを書きます。 */
const NOTE = {
  峠: "峠道そのものが目的になる場所です",
  岬: "海沿いの道の行き止まりにあります",
  展望台: "車で上がれる見晴らしです",
  灯台: "岬の道の先にあります",
  湖: "湖畔の道を回れます",
  海岸: "海沿いの道から寄れます",
  高原: "高原の道を抜けて行きます",
  渓谷: "谷沿いの道を走ります",
  滝: "駐車場から歩いてすぐのことが多い場所です",
  道の駅: "休憩と地のものの買い物にちょうどよい場所です",
  牧場: "広い駐車場があり、寄りやすい場所です",
  島: "橋やフェリーで渡ります",
  ダム: "ダム沿いの道の途中にあります",
};

/** 駐めにくいほうに添える一言。断らずに、事情だけ伝えます。 */
const PARKING_NOTE = "車だと駐める場所を探すことになりがちです";

/** ふつうの重み。表に無い分類は、これで扱います。 */
const NEUTRAL = 0.5;

/** この旅は車か（バイクを含みます）。 */
export function isTouring(trip) {
  // 現地だけ車の旅（電車＋レンタカー）も、運転するのは同じです。
  // 道の景色も、休憩の要りかたも、駐車場の話も変わりません。
  return trip?.transport === "car" || trip?.transport === "transit+car";
}

/**
 * その場所の、車で行く楽しさ。
 *
 * @param {{category?:string}} spot
 * @returns {number} 0〜1
 */
export function drivingAppeal(spot) {
  const v = APPEAL[spot?.category];
  return Number.isFinite(v) ? v : NEUTRAL;
}

/**
 * 車で行くときの一言。説明に添えます。
 *
 * 表に無い分類には**何も書きません**。「車で行きやすい場所です」と
 * どこにでも書ける文を足しても、読む人の判断は変わりません。
 *
 * @returns {string} 書くことが無ければ空
 */
export function drivingNote(spot) {
  const a = drivingAppeal(spot);
  if (a <= 0.4) return PARKING_NOTE;
  return NOTE[spot?.category] ?? "";
}

/** 1区間の運転がこれを超えたら、休憩をすすめます（分）。 */
export const LONG_DRIVE_MIN = 120;

/**
 * 長い運転に添える一言。短ければ空を返します。
 *
 * 高速道路の休憩の目安は2時間ごとです。旅程に「4時間の移動」と1行で
 * 書いておいて、休むことに触れないのは不親切です。
 */
export function longDriveNote(minutes) {
  if (!Number.isFinite(minutes) || minutes < LONG_DRIVE_MIN) return "";
  const hours = Math.floor(minutes / 60);
  return `${hours}時間を超える運転です。2時間ごとを目安に休憩をはさんでください`;
}

/** 1回の休憩に見ておく時間（分）。トイレ・給油・飲みもの。 */
export const REST_MIN = 15;

/**
 * その区間に入れる休憩の枠。
 *
 * 「2時間ごとに休憩を」と書いてはいましたが、**旅程はその時間を
 * 数えていません**。3時間の運転が「3時間」のまま並び、休憩を入れると
 * そのぶん全部が後ろへずれます。子ども連れなら、まず入れます。
 *
 * ここでは**枠だけ**を決めます。
 *
 *   ・どこで休むかは言いません（店名も道の駅名も作りません）
 *   ・何時ごろかと、何分見ておくかだけを出します
 *
 * **時刻は動かしません。** 動かすと、確かめ済みの旅程（帰りの時刻に
 * 間に合うか、施設が開いているか）をもう一度確かめ直すことになります。
 * 代わりに「入れても間に合うか」を余裕から答えます。
 *
 * @param {{start:Date|string, end:Date|string}} item 移動の行
 * @param {number|null} slackMin 帰りの余裕（分）。分からなければ null
 * @returns {{times:string[], minutes:number, fits:boolean|null,
 *            note:string}|null}
 */
export function restSlots(item, slackMin = null) {
  const start = new Date(item?.start);
  const end = new Date(item?.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const minutes = Math.round((end - start) / 60000);
  if (minutes < LONG_DRIVE_MIN) return null;

  // 2時間ごと。3時間なら1回、5時間なら2回です。
  const count = Math.max(1, Math.floor(minutes / 120));
  const times = [];
  for (let i = 1; i <= count; i += 1) {
    const at = new Date(start.getTime() + (minutes * i / (count + 1)) * 60000);
    times.push(`${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`);
  }
  const need = count * REST_MIN;
  const fits = Number.isFinite(slackMin) ? slackMin >= need : null;
  const note = fits === false
    ? `この${count}回ぶん（約${need}分）を入れると、帰りの余裕`
      + `（${Math.round(slackMin)}分）を超えます。`
      + "どこかを削るか、帰りを遅らせてください。"
    : `旅程の時刻には、この${need}分を入れていません。`
      + (fits === true
        ? `帰りの余裕（${Math.round(slackMin)}分）の中には収まります。` : "");
  return { times, minutes: need, fits, note };
}

/**
 * 日ごとの運転時間（分）。
 *
 * 車の旅で疲れるのは、歩く距離ではなく運転している時間です。
 *
 * @param {object} itin
 * @returns {number[]} 日ごとの分
 */
export function drivingMinutesByDay(itin) {
  return (itin?.days ?? []).map((day) => (day?.items ?? [])
    .filter((i) => i.kind === "transit" && i.walk !== true)
    .reduce((sum, i) => {
      const min = (new Date(i.end) - new Date(i.start)) / 60000;
      return sum + (Number.isFinite(min) && min > 0 ? min : 0);
    }, 0));
}
