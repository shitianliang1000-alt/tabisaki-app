// 旅の「かたち」を表すモデル。
//
// v2 では出発地に戻ることが暗黙の前提でした。実際の旅行は
//
//   日帰り     東京 → 鎌倉 → 江の島 → 東京      （出発地に戻る）
//   宿泊       東京 → 松本 → 上高地 → 松本の宿   （目的地で終わる）
//   片道       東京 → 名古屋 → 京都 → 大阪       （別の場所で終わる）
//
// と形が違うので、終点を独立させます。ここが分かれていないと、
// スケジューラは「帰りの便」を必ず入れてしまい、片道旅行が作れません。

import { normalizePurposes } from "./purpose.js";

/** @typedef {{name:string, lat:number, lng:number}} Place */

/**
 * 時刻の入力欄（"09:30"）と、内部で使う数（9.5）の変換。
 *
 * 1日の枠は端から時刻で扱います。長さ（9時間）だけでは「いつ動くのか」
 * が決まらず、同じ9時間でも7時発と10時発では開いている施設が変わります。
 */

/** "09:30" → 9.5。読めなければ null。 */
export function parseHourField(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h + min / 60;
}

/** 9.5 → "09:30"。 */
export function formatHourField(hour) {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export const END_MODES = /** @type {const} */ ({
  RETURN_TO_ORIGIN: "return-to-origin",   // 出発地に戻る
  END_AT_DESTINATION: "end-at-destination", // 最終目的地で終了
  RETURN_TO_OTHER: "return-to-other",     // 別の場所へ帰る
});

export const END_MODE_LABEL = {
  [END_MODES.RETURN_TO_ORIGIN]: "出発地に戻る",
  [END_MODES.END_AT_DESTINATION]: "最終目的地で終了",
  [END_MODES.RETURN_TO_OTHER]: "別の場所へ帰る",
};

/**
 * @param {object} init
 * @returns {object} 正規化された旅程条件
 */
export function makeTrip(init = {}) {
  return {
    origin: init.origin ?? null,
    /** 行き先を明示したい場合。null なら AI と検索で決める。 */
    destination: init.destination ?? null,
    endMode: init.endMode ?? END_MODES.RETURN_TO_ORIGIN,
    /** endMode が RETURN_TO_OTHER のときの帰着地 */
    returnTo: init.returnTo ?? null,
    departAt: init.departAt ?? null,
    /** 終点に着いていなければならない時刻 */
    arriveBy: init.arriveBy ?? null,
    /** [{ place, checkInBy }] 宿泊地。日数ぶん。 */
    lodging: init.lodging ?? [],
    /**
     * 絶対条件（hard constraints）。破ったら旅程として成立しないもの。
     *
     * 希望条件（下の note / interests / pace）と混ぜると、モデルが
     * 「静かな場所」と「18時までに帰る」を同じ重みで扱ってしまいます。
     * 前者は妥協できますが、後者は妥協できません。
     */
    must: {
      /** 必ず立ち寄るスポットID。検証で削られません。 */
      spotIds: init.must?.spotIds ?? [],
      /** 使わないスポットID。 */
      avoidSpotIds: init.must?.avoidSpotIds ?? [],
      /**
       * そのうち、「外す」として押されたぶん（avoidSpotIds の部分集合）。
       *
       * 外すだけだと、空いた枠を別の場所が埋めます。組み直しとしては
       * 正しいのですが、押した人には「消したのに数が減らない」と映り、
       * 「別の候補」を押したときと見分けがつきません。
       * 外す＝1か所ぶん減らす、差し替え＝件数はそのまま、と分けます。
       *
       * ここは「どれを外したか」の記録です。実際に何か所までにするかは
       * spotCap が持ちます。
       */
      removedSpotIds: init.must?.removedSpotIds ?? [],
      /**
       * 立ち寄りの数の上限。null なら日数と時間帯から決めます。
       *
       * 「外す」を押したときだけ、そのときの件数から1を引いた値が
       * 入ります。減らす数ではなく上限の絶対値にしているのは、
       * pipeline.js が計算するのは「入れてよい数」であって「実際に
       * 入る数」ではないからです。収録の少ない土地では、11まで入れて
       * よくても10しか入りません。そこから1を引いても10のままです。
       */
      spotCap: Number.isFinite(init.must?.spotCap) ? init.must.spotCap : null,
      /** 食事の時間を必ず確保するか。 */
      meals: init.must?.meals ?? true,
      /**
       * 回る順を、こちらで決めたぶん。
       *
       * 並びは道順と混雑から決めています（crowd.js）。それでも
       * 「先に海へ行きたい」は好みの問題なので、押された順を勝たせます。
       * ここに無いスポットは、これまでどおり自動の並びのままです。
       *
       * **時刻は組み直します。** 並べ替えだけして時刻をそのままにすると、
       * 開館前に着く旅程や、閉館後に着く旅程ができます。
       */
      orderedSpotIds: init.must?.orderedSpotIds ?? [],
      /**
       * 滞在時間を、こちらで決めたぶん（スポットID → 分）。
       *
       * 既定は分類ごとの目安です（美術館70分、神社35分）。ただ、
       * 目安が合わないことはあります。「ここは2時間いたい」も
       * 「ここは20分でいい」も、旅程の中身そのものです。
       */
      dwellById: init.must?.dwellById ?? {},
    },
    note: init.note ?? "",
    interests: init.interests ?? [],
    /**
     * 費用の上限（円・ひとり）。null なら決めない。
     *
     * 上限を超えた旅程を黙って出しません。**削りもしません。**
     * 何を削るか（入場料の高い場所か、宿か、特急か）は好みの問題で、
     * こちらが勝手に決めると「行きたかった場所が消えた」になります。
     * 超えていることと、内訳のいちばん大きいところを伝えます。
     */
    budgetYen: init.budgetYen ?? null,
    /**
     * 予算の扱い。"guide"（目安）か "strict"（できるだけ収める）。
     *
     * 「2万円まで」を選んだ人は、2万円以内の旅程が出ると思います。
     * それでも黙って削るのは違うので、どちらの意味で言ったのかを
     * 聞きます。strict のときは、入場料の高い場所から外して組み直します。
     */
    budgetMode: init.budgetMode === "strict" ? "strict" : "guide",
    /**
     * 何で移動するか。"any" | "transit" | "car" | "walk"。
     *
     * 「車が使えるか」は、地方では旅程が成立するかどうかを分けます。
     * バスが1日3本の土地では、車があれば回れる場所が、なければ
     * 回れません。距離だけから推し量れないので、聞きます。
     */
    /*
     * "transit+car" は、行きは電車で、現地だけ車という旅です。
     *
     * 遠出でいちばん多い形なのに、これまでは選べませんでした。
     * 「車」を選ぶと出発地から目的地まで運転する旅程になり、
     * 「電車・バス」を選ぶとバスが1日3本の土地を歩かされます。
     * 新幹線で行って駅でレンタカーを借りる旅は、そのどちらでもありません。
     */
    /*
     * 空路と船が、どこにも無かった。
     *
     * 選べるのは 電車・バス／車／徒歩／電車＋現地の車 の4つだけで、
     * **飛行機とフェリーは指定できません**でした。すると
     *
     *   ・東京から那覇へ行く旅程が、33時間39分（新幹線＋船）で組まれる
     *     （飛行機なら4時間46分です）
     *   ・佐渡・小豆島・屋久島のように船でしか行けない土地を、
     *     「近くに駅・バス停が見当たりません」で片づけてしまう
     *
     * ことになります。時刻を引く手はもとからありました（Yahoo!路線
     * 情報は空路も船も返します）。指定する口が無かっただけです。
     *
     * local は「普通列車のみ」（青春18きっぷ）です。新幹線と特急を
     * 切ります。使えない切符で組んだ旅程は、そのまま使えません。
     */
    transport: ["any", "transit", "car", "walk", "transit+car",
                "air", "air+car", "ferry", "local"]
      .includes(init.transport) ? init.transport : "any",
    hiddenBias: init.hiddenBias ?? 0.5,
    /**
     * 移動そのものを楽しみたいか。
     *
     * 青春18きっぷや乗り鉄の旅では、乗っている時間が旅の中心です。
     * 移動を短くするほど良い、という組みかたはこの人たちには逆で、
     * 近場の1か所にまとまった旅程は「どこにも行っていない」になります。
     * true のときは、遠いエリアや長い移動を減点しません（pipeline.js）。
     */
    enjoyTravel: init.enjoyTravel === true,
    /**
     * 1日のうち、観光にあてる時間帯。帰着時刻とは別のことです。
     *
     * 以前は「1日に動ける時間」を長さ（9時間）だけで聞いていました。
     * ただ、長さだけでは **いつ動くのか** が決まりません。同じ9時間でも
     * 7時発と10時発では、開いている施設も、その日に回れる場所も変わります。
     * 実際、旅程を組む側（verify.js）は端から時刻で考えていて、長さは
     * 件数の計算にしか使われず、時間帯は 9:00〜18:30 に固定されていました。
     * 聞き方を時刻に合わせ、そのまま旅程の枠として使います。
     */
    dayStartHour: Number.isFinite(init.dayStartHour) ? init.dayStartHour : 9,
    dayEndHour: Number.isFinite(init.dayEndHour) ? init.dayEndHour : 18.5,
    pace: init.pace ?? "balanced",
    /**
     * ペースを利用者が選んだかどうか。
     *
     * 選んでいれば、希望文からの推測で上書きしません。
     * 「もっとゆっくり」を押したのに何も変わらない、を防ぐためです。
     */
    paceChosen: init.pace !== undefined,
    /**
     * 混雑を避けて組むか。既定で有効です。
     * 順番を変えるだけで、行ける場所が減るわけではありません。
     */
    avoidCrowds: init.avoidCrowds ?? true,
    /** 人数。費用の概算に効きます。 */
    people: init.people ?? 1,
    /**
     * 宿の取りかた。"auto" | "base"（1か所に連泊）| "tour"（泊まるたび移動）。
     *
     * 同じ3泊4日でも、この2つは別の旅です。連泊は荷物を置いておけて
     * 毎晩同じ部屋に戻れますが、遠くへは行けません。周遊は広く回れますが、
     * 毎朝荷物をまとめることになります。**好みの問題なので聞きます**
     * （stays.js が割り振りに使います）。
     */
    stayStyle: ["auto", "base", "tour"].includes(init.stayStyle)
      ? init.stayStyle : "auto",
    /**
     * 食べたいものの向き。"any" | "seafood" | "noodle" | "meat" | "rice" | "sweets"。
     *
     * 店は持っていないので、決まるのは**その土地の何を食べるか**までです
     * （meals.js）。海鮮が苦手な人に海鮮丼を出しても、旅程として
     * 役に立ちません。既定はおまかせ＝その土地の名物から選びます。
     */
    foodGenre: ["any", "seafood", "noodle", "meat", "rice", "sweets"]
      .includes(init.foodGenre) ? init.foodGenre : "any",
    /**
     * 食べられないもの。
     *
     * 海鮮・麺・肉までは選べるのに、**ベジタリアン・アレルギー・
     * ハラール・子ども向けがどこにも入りませんでした。** 食べられない
     * ものがある人にとっては、名物より先に決まる条件です。
     * 「出雲そば」と書かれても、小麦を避けている人には使えません。
     *
     * 変えられるのは地図へ渡す言葉と、名物の選びかたまでです
     * （店は持っていないので、対応店かどうかは確かめられません）。
     */
    /**
     * 同行者。**足**の話です（食事の条件は diet が持ちます）。
     *
     * 旅程は「ふつうに歩ける大人ひとり」を前提に組まれていました。
     * 同じ「城」でも、ベビーカーでは石段を上がれず、車椅子では天守に
     * 入れないことがあります。それでも旅程には同じ「松江城 80分」と
     * 書かれ、当日に現地で分かります。
     *
     * 収録に「バリアフリーかどうか」はありません。持っているのは
     * 分類だけです。だから**外しはせず**、選ぶときに後ろへ回して、
     * 「何がつらいか」と「公式で確かめて」を書きます（packages/core/src/access.js）。
     */
    /**
     * 旅の目的。"date" | "active" | "relax" | "kids" | "learn"。
     *
     * 興味（温泉・歴史…）は「何が見たいか」、目的は「どう過ごしたいか」
     * です。同じ箱根でも、デートとアクティブでは回る場所が違います。
     * 選ぶときの重みだけで、外しはしません（packages/core/src/purpose.js）。
     */
    purposes: normalizePurposes(init.purposes),
    companions: (Array.isArray(init.companions) ? init.companions : [])
      .filter((c, i, a) => ["stroller", "wheelchair", "senior"].includes(c)
        && a.indexOf(c) === i),
    // 正しい値だけを通します（ここは meals.js の DIETS と同じ並びです。
    // import すると trip.js → meals.js → … の輪ができるので、
    // 並びだけを写しています。ずれたら tests/meals.test.js が落ちます）。
    diet: (Array.isArray(init.diet) ? init.diet : []).filter((d, i, a) =>
      ["vegetarian", "vegan", "halal", "gluten", "seafood-free", "kids"]
        .includes(d) && a.indexOf(d) === i),
  };
}

/**
 * 旅の終点。ここに `arriveBy` までに着いている必要があります。
 * @returns {Place|null}
 */
export function endPlace(trip) {
  switch (trip.endMode) {
    case END_MODES.END_AT_DESTINATION:
      return trip.destination ?? null;
    case END_MODES.RETURN_TO_OTHER:
      return trip.returnTo ?? null;
    case END_MODES.RETURN_TO_ORIGIN:
    default:
      return trip.origin ?? null;
  }
}

/** 終点が出発地と同じか（＝帰りの移動が必要か）。 */
export function returnsToStart(trip) {
  const end = endPlace(trip);
  if (!end || !trip.origin) return false;
  return samePlace(end, trip.origin);
}

export function samePlace(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;
}

/** 何泊か。0 は日帰り。 */
export function nightsOf(trip) {
  if (!trip.departAt || !trip.arriveBy) return 0;
  const a = startOfDay(trip.departAt);
  const b = startOfDay(trip.arriveBy);
  return Math.max(0, Math.round((b - a) / 86400000));
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function totalMinutes(trip) {
  if (!trip.departAt || !trip.arriveBy) return 0;
  return Math.floor((trip.arriveBy - trip.departAt) / 60000);
}

/**
 * 入力の不備を、直し方まで含めて日本語で返します。
 * 空配列なら旅程を組める状態です。
 */
export function validateTrip(trip) {
  const errors = [];
  if (!trip.origin) errors.push("出発地を指定してください。");
  if (!trip.departAt) errors.push("出発日時を指定してください。");
  if (!trip.arriveBy) errors.push("到着（帰着）日時を指定してください。");

  if (trip.departAt && trip.arriveBy && trip.arriveBy <= trip.departAt) {
    errors.push("到着日時は出発日時より後にしてください。");
  }
  if (trip.departAt && trip.arriveBy && totalMinutes(trip) < 150) {
    errors.push("旅程を組むには最低でも2時間半ほど必要です。");
  }
  if (trip.endMode === END_MODES.END_AT_DESTINATION && !trip.destination) {
    errors.push("「最終目的地で終了」を選んだ場合は、最終目的地を指定してください。");
  }
  if (trip.endMode === END_MODES.RETURN_TO_OTHER && !trip.returnTo) {
    errors.push("「別の場所へ帰る」を選んだ場合は、帰着地を指定してください。");
  }

  const both = (trip.must?.spotIds ?? [])
    .filter((id) => (trip.must?.avoidSpotIds ?? []).includes(id));
  if (both.length) {
    errors.push("同じ場所が「必ず行く」と「行かない」の両方に入っています。");
  }

  const nights = nightsOf(trip);
  if (nights > 0 && trip.lodging.length > 0 && trip.lodging.length < nights) {
    errors.push(`${nights}泊の旅程ですが、宿泊地が${trip.lodging.length}件しか`
      + "指定されていません。");
  }
  for (const [i, l] of trip.lodging.entries()) {
    if (!l?.place) errors.push(`${i + 1}泊目の宿泊地が未設定です。`);
    if (l?.checkInBy && trip.departAt && l.checkInBy <= trip.departAt) {
      errors.push(`${i + 1}泊目のチェックイン期限が出発日時より前になっています。`);
    }
  }
  return errors;
}

/**
 * その日の終点と、そこに着いているべき時刻。
 * 最終日は旅の終点、それ以外は宿。
 * @returns {{place: Place|null, by: Date|null, isFinal: boolean}}
 */
export function dayEnd(trip, dayIndex) {
  const nights = nightsOf(trip);
  if (dayIndex >= nights) {
    return { place: endPlace(trip), by: trip.arriveBy, isFinal: true };
  }
  const l = trip.lodging[dayIndex];
  if (!l?.place) return { place: null, by: null, isFinal: false };
  return { place: l.place, by: l.checkInBy ?? null, isFinal: false };
}
