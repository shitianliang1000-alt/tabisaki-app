// 旅程を組み立てる流れ本体。画面には触りません。
//
// もとは app.js の中にありましたが、DOM と混ざっていると
// 「四国・9泊10日」のような組み合わせをテストで固定できませんでした。
// 実際に壊れていたのはこの流れの側なので、画面から切り離してあります。
//
//   1. 希望を読む（AI）
//   2. 知識ベースを検索して候補を作る
//   3. AI が案を出す                      ← 1回目
//   4. 各スポットを実際の移動時間で検証する  ← Routes API + 営業時間
//   5. 問題があれば、理由を渡して直させる    ← 2回目
//   6. 時刻を割り付けて旅程にする
//   7. 希望に応えられたかを確かめて、応えられていなければそう伝える

import {
  aiStatus, embedQuery, hasApiKey, noteAiError, proposePlan, resetAiStatus,
  resolvedModel, understandRequest,
} from "./ai.js";
import { areaNote, areaScope, blockGroups, detectAreas, namedSpotAreas,
         originCity, phraseAreas,
  placeCandidates, unknownPlaceTerms }
  from "./areas.js";
import { isTouring } from "./touring.js";
import { journeyNote, pickJourney, stripJourney } from "./journeys.js";
import { readIntent } from "./intent.js";
import { readWish, stripNear, wishScope } from "./sunny.js";
import { nightTrainLeg } from "./trains.js";
import { TUNING } from "./config.js";
import { discoverArea, resolveDestination } from "./discover.js";
import { atHour, estimateMinutes, haversineKm } from "./feasibility.js";
import {
  ensureAllSpots, ensureNames, ensureRegions, mergeIntoKb, rankRegions,
  reachableRegions, searchSpots, searchSpotsByKeyword,
} from "./kb.js";
import { extractKeywords } from "./keywords.js";
import { analyzeCoverage, coverageMessage, seasonalNotes } from "./match.js";
import { balanceByTier, mixTargets } from "./mix.js";
import { tripReliability } from "./reliability.js";
import { buildItinerary } from "./planner.js";
import { MAX_POINTS, computeRoute, legDetailLookup, legLookupAll, pickMode }
  from "./routes.js";
import { SPOTS_PER_DAY, planStays, suggestRegionCount } from "./stays.js";
import { dayEnd, endPlace, nightsOf } from "./trip.js";
import { issuesToPrompt, trimKeepingPicks, trimToFit } from "./verify.js";
import { critique, relaxForItinerary, relaxForUnreachable } from "./relax.js";
import { itineraryCrowd, spreadCrowds } from "./crowd.js";
import { costBreakdown } from "./cost.js";
import { sunNotes, sunTimes } from "./sun.js";
import { forecastFor, summarizeDay } from "./weather.js";
import { normalsFor } from "./normals.js";
import { suggestReplan } from "./replan.js";
import { attachBackups } from "./backup.js";
import { attachMeals, dietNote } from "./meals.js";
import { attachScenic } from "./scenic.js";
import { coLocated } from "./dedupe.js";
import { attachShapes } from "./shapes.js";
import { attachAccess } from "./access.js";
import { attachLastTrain } from "./lasttrain.js";
import { attachTickets } from "./tickets.js";
import { searchYahooTransit } from "./yahoo-transit.js";
import { yahooFlags } from "./modes.js";
import { nearestStop } from "./stops.js";
import { eventNotesFor } from "./events.js";
import { attachLuggage, luggagePlanFor } from "./luggage.js";
import { storyFor } from "./story.js";
import { longestGap, pickBest, scoreItinerary } from "./score.js";

/** 旅のしかたの名前に含まれる語か（「国道1号線」の「国道」「号線」など）。 */
function isJourneyWord(w, journey) {
  const word = String(w ?? "");
  if (!word) return false;
  return journey.name.includes(word) || word.includes(journey.name)
    || /^(国道|号線|最長|片道|往復|切符|きっぷ|街道|五十三次|宿場|旧道)$/.test(word);
}

/**
 * 沿って訪れる地名から、絞り込みの範囲を作ります。
 * 地名ごとに内訳（groupById）を持たせ、街ごとに1つずつ選べるようにします。
 */
function alongRegions(along, kb) {
  const ids = new Set();
  const groupById = new Map();
  for (const place of along) {
    for (const a of detectAreas(place, kb)) {
      // 県名で当たったものは広すぎます（「静岡」→静岡県全体）。
      // その名前のエリアだけを使います。
      // 県全体に広げると、道から外れた土地まで入るので使いません。
      const named = a.regionIds.filter((id) =>
        String(kb.regionsById.get(id)?.name ?? "").includes(place));
      for (const id of named) {
        ids.add(id);
        if (!groupById.has(id)) groupById.set(id, place);
      }
    }
  }
  if (!ids.size) return null;
  return { regionIds: ids, groupById, spread: true };
}

/** 旅のしかたを言う語。移動を楽しみたい人の希望文では、検索に使いません。 */
const JOURNEY_WORDS = /^(移動|楽しみ|楽しむ|青春|18|きっぷ|切符|青春18きっぷ|鈍行|各駅|各駅停車|ローカル|ローカル線|車窓|乗り鉄|鉄旅|鉄道旅|列車旅|汽車旅|乗り継ぎ|乗りつぎ|遠く|日本一周|日本縦断|周遊)$/;

/**
 * @param {object} args
 * @param {object} args.trip  makeTrip の結果（検証済み）
 * @param {object} args.kb    loadKnowledgeBase の結果
 * @param {(step:number, note?:string)=>void} [args.onProgress]
 * @returns {Promise<object>} 表示用の旅程
 */
export async function planTrip({ trip, kb, onProgress = () => {},
                                 ...opts }) {
    const hours = (trip.arriveBy - trip.departAt) / 3600000;
  // 「やめる」（js/app.js の AbortController）。
  //
  // signal は下の通信にも渡しますが、それだけでは止まりません。AIや
  // 経路の呼び出しは、失敗すると**目安に落ちて先へ進む**作りです
  // （止まらないための工夫です）。中止もその「失敗」に見えるので、
  // 段の切れ目ごとに、やめると言われていないかを確かめます。
  const signal = opts.signal;
  const stop = () => signal?.throwIfAborted();

  onProgress(0);
  // 希望文から、乗り物の指定を読み取ります。
  //
  // 「ツーリングをしたい」「サンライズに乗って」のような書きかたは、
  // これまで素通りしていました。文の中の語はスポット名との照合にしか
  // 使われないので、合うスポットが無ければ無視されます。バイクで
  // 回りたい人に、電車の時刻表で組んだ旅程が出ていました。
  //
  // **文に書いてあれば、そちらが勝ちます**（2026-10 から）。チャットで
  // 「車で」と書いた人は、設定の欄が「電車・バス」のままでも車で
  // 組んでほしいはずです。設定を開かずに済むことを優先します。
  const intent = readIntent(trip.note);
  if (intent.transport) {
    trip = { ...trip, transport: intent.transport };
  }
  // 移動そのものを楽しみたいか（画面で選んだか、希望文に書いてあるか）。
  // 「青春18きっぷで」と書いた人に、移動の少ない近場の旅程を返さないためです。
  let enjoyTravel = trip.enjoyTravel === true || intent.enjoyTravel === true;
  // 前回の失敗を持ち越さないようにします（3案を作るときは
  // 読み取りを使い回すので、最初の1回だけ数え直します）。
  if (!opts.query) resetAiStatus();
  // 希望文の読み取りと検索用ベクトルは、3案を作るときに使い回します。
  // 案ごとに読み取り直すと、同じ文をモデルに3回投げることになります
  // （変わるのはペースと穴場の割合だけで、希望文は同じです）。
  const query = opts.query
    ?? await understandRequest(trip.note, trip.interests, hours,
      { signal, origin: trip.origin?.name });
  stop();
  // ペースは、利用者が選んでいればそちらを使います。
  // 希望文からの推測で上書きすると、「もっとゆっくり」を押したのに
  // 何も変わらない、ということが起きます（実際に起きていました）。
  if (!trip.paceChosen) trip.pace = query.pace;

  // 名前のある旅のしかた（「最長往復切符」「国道1号線の旅」）。
  // 行き先ではなく旅の形なので、乗り物・移動の楽しみかた・沿う道に
  // 読み替えます（js/journeys.js）。画面で選んだ乗り物は上書きしません。
  const journey = opts.ignoreAreas ? null : pickJourney(trip.note, query.journey);
  if (journey?.transport && trip.transport === "any") {
    trip = { ...trip, transport: journey.transport };
  }
  if (journey?.enjoyTravel) enjoyTravel = true;

  onProgress(1);
  const vector = opts.vector !== undefined ? opts.vector
    : (kb.hasVectors ? await embedQuery(query.searchText, { signal }) : null);
  stop();
  // 地名は絞り込み（scope）で使うので、スポットの検索語からは外します。
  // 「四国」を語として残すと、名前に四国を含む「四国中央市」の
  // 地元の祭りばかりが上位に来ます（実際にそうなりました）。
  // AIが具体的な地名に直した呼び名（辞書に無い「三都心」のような言い方）。
  // 辞書で当たったものがあれば、そちらを使います。
  // 「三都心」のように、書いた人の街で指す先が変わる呼び名のための文脈。
  const actx = { originCity: originCity(trip.origin) };
  const phraseHits = opts.ignoreAreas ? []
    : phraseAreas(query.phrases, kb).filter((a) =>
      !detectAreas(trip.note, kb, actx).some((d) => d.term === a.term));
  const areaWords = new Set([...detectAreas(trip.note, kb, actx), ...phraseHits]
    .flatMap((a) => [a.term, a.term.replace(/[都道府県]$/, "")]));
  // 「移動を楽しみたい」「青春18きっぷで」の語も、行き先を探す語では
  // ありません。残すと「移動」「青春」を名前や説明に含む数件だけが候補に
  // なり、近畿の3エリアに固まっていました（実際にそうなりました）。
  const searchWords = [...query.keywords, ...query.interests]
    .filter((w) => !areaWords.has(w))
    // 「さん都心」から取り出された「都心」は、呼び名の一部です。
    .filter((w) => w.length < 2 || ![...areaWords].some((t) => t.length > w.length && t.includes(w)))
    .filter((w) => !(enjoyTravel && JOURNEY_WORDS.test(w)))
    .filter((w) => !journey || !isJourneyWord(w, journey));

  // 必要なぶんの収録を、ここで読みます。
  //
  // 収録は 29,706件・4.8MB（gzip で約1MB）あります。これを起動時に
  // 全部読んでいました。ところが「島根の旅程」に使うのは島根のぶん
  // だけで、残り46県は読んで、照合して、捨てていました。
  //
  // 地名が書かれていれば、そのエリアのぶんだけで足ります
  // （行き先の絞り込みは、下の scope が**エリアの一覧**だけで決めます）。
  // 書かれていなければ、どの県が候補になるか分からないので全部です。
  // **分からないときに勘で絞る**と、行けたはずの旅先が黙って消えます。
  await loadNeededSpots(kb, trip, { ...opts, onProgress });
  stop();

  // 車の旅なら、走って気持ちのいい場所を前に出します（js/touring.js）。
  const touring = isTouring(trip);
  // 同行者がいるなら、石段と登り道を少し後ろへ（js/access.js）。
  // **外しません。** 並びを変えるだけです。
  const companions = trip.companions ?? [];
  let matches = vector
    ? searchSpots(kb, vector,
                  { limit: 160, hiddenBias: trip.hiddenBias, touring, companions })
    : searchSpotsByKeyword(kb, searchWords,
                           { limit: 160, hiddenBias: trip.hiddenBias, touring,
                             companions });

  // 一致が無いときにエラーで止めない。「その希望には応えられないが、
  // 行ける範囲でこういう案はある」と示したほうが役に立ちます。
  // 応えられなかったことは、あとで coverage が明示します。
  if (!matches.length) {
    matches = searchSpotsByKeyword(kb, trip.interests,
      { limit: 160, hiddenBias: trip.hiddenBias, touring });
  }
  if (!matches.length) {
    matches = kb.spots.map((spot) => ({ spot, score: 0 }));
  }

  // 地名は他の検索語と性質が違います。「四国」を無視して銚子を出すのは、
  // 近いものを返しているのではなく、別の質問に答えているのと同じです。
  // 「地名の指定を外す」を選ばれたときは、地名を見ません。
  // 名前のある列車は、行き先そのものです。
  //
  // 「サフィール踊り子に乗りたい」と書いた人は、伊豆へ行きたいはずです。
  // 列車の名前はどのエリア名とも一致しないので、これまでは地名の指定が
  // 無いことになり、点の高い順に返っていました。時刻は知らなくても、
  // **どこへ向かう列車かは分かります**。そこを行き先にします。
  // 旅のしかたの名前（「東海道五十三次」の「東海」）は地名として読みません。
  // 「東京に近いところ」の「東京」は行き先ではないので、地名として読みません。
  const wish = readWish(trip.note);
  const areaText = stripNear(journey ? stripJourney(trip.note, journey) : trip.note);
  // モデルが読み替えた俗称の行き先（「三都心」→ 東京・大阪・名古屋）も
  // 足します。辞書に無い言い回しは、これが無いと地名の指定が無いことに
  // なり、点の高い順に選ばれます。
  const towardText = [areaText, ...intent.toward,
    ...(query.places ?? []).filter((p) => !wish.nearPlace || !String(p).includes(wish.nearPlace))]
    .filter(Boolean).join(" ");
  let scope = opts.ignoreAreas
    ? { regionIds: null, matched: [], missing: [] }
    : areaScope([...detectAreas(towardText, kb, actx), ...phraseHits]);
  // 地名は当たらないが、収録にある場所の名前（「琵琶湖」）が書かれて
  // いるなら、そこから決めます。広い場所なら、まわりのエリアごと
  // （js/areas.js の namedSpotAreas）。
  if (!opts.ignoreAreas && !scope.regionIds) {
    const near = namedSpotAreas(towardText, kb);
    if (near.length) scope = { ...areaScope(near), missing: scope.missing };
  }

  // 収録に無い土地は、AIに調べさせてから候補に入れます。
  //
  // 収録を手で増やす方向だと、書いた土地しか通りません。しかも日本の
  // 都道府県を前提に検証していたので、「パリに行きたい」は収録が無いうえに
  // 調べることもできず、「見つかりません」で止まっていました。
  //
  // いまは二段構えです。
  //   ・日本の収録エリアに当たる → その範囲から選ぶ（従来どおり）
  //   ・当たらない → 検索を使って行き先そのものを割り出し、調べる
  // 後者は国内・国外を問いません。地名が書かれていない希望
  // （「オーロラが見たい」）も、体験できる場所を割り出して調べます。
  const discovered = [];
  const discoverFn = opts.discover ?? discoverArea;
  const resolveFn = opts.resolve ?? resolveDestination;
  const when = `${trip.departAt.getFullYear()}年${trip.departAt.getMonth() + 1}月`;
  const requested = [];   // 利用者が名指しした場所（調べがついたもの）

  async function bring(term, country) {
    // 日数に見合う量を調べます。3日の旅で4エリア×6件は多すぎ、
    // 10日の旅で1エリア×3件では埋まりません。
    const days0 = nightsOf(trip) + 1;
    const found = await discoverFn(term, {
      kb, country, when, note: trip.note, signal: opts.signal,
      areaCount: Math.max(1, Math.min(5, Math.ceil(days0 / 2))),
      spotCount: Math.max(4, Math.min(8, days0 * 2)),
    });
    if (!found.ok) {
      discovered.push({ term, ok: false, reason: found.reason });
      return false;
    }
    mergeIntoKb(kb, found);
    requested.push(term);
    discovered.push({
      term, ok: true, country: found.country ?? country,
      areas: found.regions.length, spots: found.spots.length,
      cached: found.cached, rejected: found.rejected.length,
      unverifiedPlace: found.unverifiedPlace ?? [],
      sources: found.sources ?? [],
    });
    return true;
  }

  // 名指しされた場所は、収録の有無にかかわらず調べにいきます。
  //
  // 以前は「日本のエリアが1つでも当たったら調べない」作りでした。
  // その結果、「北海道の…宗谷岬、知床、青い池を巡りたい」と書いても
  // 北海道が当たった時点で打ち切られ、宗谷岬は「収録がありません」と
  // 言われて終わっていました。当たったのは地方名で、名指しされた場所は
  // 何ひとつ調べていないのに、です。
  //
  // 呼びすぎないよう、名指しがあるときだけ割り出しを走らせます。
  // 「温泉でゆっくり」のように場所の名前が無い希望では呼びません。
  let resolved = null;
  let namedTerms = [];
  if (!opts.ignoreAreas) {
    const named = [...new Set([
      ...scope.missing.map((a) => a.term),
      ...unknownPlaceTerms(trip.note, kb),
    ])];
    namedTerms = named;
    const canAsk = hasApiKey() || opts.resolve || opts.discover;

    if (named.length && canAsk) {
      if (hasApiKey() || opts.resolve) {
        onProgress(1, `${named.slice(0, 2).join("・")}を調べています`);
        resolved = await resolveFn(trip.note, { signal: opts.signal });
      }
      const targets = resolved?.places?.length
        ? resolved.places.slice(0, 3).map((p) => [p.name, p.country])
        : named.slice(0, 2).map((t) => [t, "日本"]);
      for (const [name, country] of targets) {
        onProgress(1, `「${name}」を調べています`);
        await bring(name, country);
        stop();
      }
    } else if (named.length) {
      for (const term of named.slice(0, 3)) {
        discovered.push({ term, ok: false,
          reason: "AIキーが未設定のため、収録に無い土地は調べられません" });
      }
    }
  }

  if (discovered.some((d) => d.ok)) {
    // 調べたぶんを含めて解釈し直す
    const before = scope.regionIds;
    scope = areaScope(detectAreas(trip.note, kb, actx));
    if (!scope.regionIds) {
      // 収録の地名として解釈できない場合は、調べたエリアに絞る
      const ids = new Set(kb.regions.filter((r) => r.source === "ai")
        .map((r) => r.id));
      if (ids.size) scope = { regionIds: ids, matched: [], missing: [] };
    } else if (before) {
      // 地方名（北海道など）で絞られていた場合、調べたエリアも必ず含めます
      for (const r of kb.regions) {
        if (r.source === "ai") scope.regionIds.add(r.id);
      }
    }
    matches = searchSpotsByKeyword(kb, searchWords,
      { limit: 200, hiddenBias: trip.hiddenBias, touring: isTouring(trip),
        companions: trip.companions ?? [] });
    if (!matches.length) matches = kb.spots.map((spot) => ({ spot, score: 0 }));

    // 名指しされた場所は、検索の点数ではなく「頼まれたから」上に来ます。
    const wanted = [...requested, ...(resolved?.places ?? []).map((p) => p.name)];
    const have = new Set(matches.map((m) => m.spot.id));
    for (const spot of kb.spots) {
      if (spot.source !== "ai") continue;
      const hit = wanted.some((w) => spot.name.includes(w)
        || spot.region?.includes(w));
      if (!hit) continue;
      const existing = matches.find((m) => m.spot.id === spot.id);
      if (existing) existing.score += 5;
      else if (!have.has(spot.id)) matches.push({ spot, score: 5 });
    }
  }

  const nights = nightsOf(trip);
  const days = nights + 1;

  // 「明日晴れていて、近いところ」。行き先の名前が無いときだけ、
  // 出発日の予報と出発地からの距離で、行き先にしてよいエリアを絞ります
  // （js/sunny.js）。名前が書いてあれば、そちらが勝ちます。
  const wishNotes = [];
  if ((wish.sunny || wish.near) && !scope.regionIds && !opts.ignoreAreas) {
    onProgress(1, wish.sunny ? "行ける範囲の天気予報を見ています" : "近いエリアを探しています");
    const got = await wishScope(wish, {
      regions: kb.regions, origin: trip.origin, date: trip.departAt, nights,
      fetch: opts.fetchSky, signal,
    });
    stop();
    wishNotes.push(...got.notes);
    if (got.regionIds?.size) scope = { ...scope, regionIds: got.regionIds, matched: [], missing: [] };
  }

  // 移動を楽しみたい人で、地名の指定が無いなら、全国を地方ごとに散らします。
  // 指定が無いまま点の高い順に選ぶと、近くに固まった数エリアで終わり、
  // 「できるだけ移動したい」に応えられません。
  if (enjoyTravel && days > 1 && !scope.regionIds && !opts.ignoreAreas) {
    scope = { ...scope, spread: true, groupById: blockGroups(kb) };
  }
  // 沿う道が決まっていない全国の旅（最長片道切符・日本一周）も同じです。
  if (journey?.spread && !scope.regionIds && !opts.ignoreAreas) {
    scope = { ...scope, spread: true, groupById: blockGroups(kb) };
  }
  // 沿う道が決まっている旅（国道1号線・東海道など）は、その道沿いの街から
  // 選びます。街ごとに内訳を持たせ、1つの街に固まらないようにします。
  // 書かれた地名があるときは、そちらを優先します（「国道1号線で静岡へ」）。
  if (journey?.along.length && !scope.matched?.length) {
    const alongScope = alongRegions(journey.along, kb);
    if (alongScope) scope = { ...scope, ...alongScope };
  }

  if (scope.regionIds) {
    // 語句に一致したものだけを残すと、「四国」という語を説明文に含む
    // 数件だけが候補になり、四国7エリアのうち3エリアしか検討されません
    // でした。指定された範囲は丸ごと候補にしたうえで、語句に一致した
    // ものを上に置きます。
    //
    // そのうえで、**指定エリアだけでは日数が埋まらないなら、隣を足します。**
    // 箱根の収録は11件です。「箱根で」と書いて3泊4日にすると、
    // 4日で11か所（1日2〜3か所）にしかならず、あとは空きます。
    // 実際に行く人も、その場合は小田原や熱海まで足を延ばします。
    // 足りているときは触りません（指定を無視して広げたりはしません）。
    widenScopeForDays(scope, kb, days);
    const inArea = matches.filter((m) => scope.regionIds.has(m.spot.regionId));
    const have = new Set(inArea.map((m) => m.spot.id));
    const rest = kb.spots
      .filter((sp) => scope.regionIds.has(sp.regionId) && !have.has(sp.id))
      .map((spot) => ({ spot, score: 0 }));
    matches = [...inArea, ...rest];
  }
  // 1日に動ける時間から、その日の件数を決めます。
  //
  // ペース（ゆったり／標準／詰込）だけで決めていたときは、
  // 「毎日6時間で切り上げたい」も「朝から晩まで歩ける」も同じ件数に
  // なっていました。滞在と移動で1か所あたり約1.6時間として割ります。
  const basePerDay = SPOTS_PER_DAY[trip.pace] ?? 4;
  const dayHours = Number.isFinite(trip.dayStartHour)
      && Number.isFinite(trip.dayEndHour)
    ? trip.dayEndHour - trip.dayStartHour
    : null;
  const perDay = Number.isFinite(dayHours)
    ? Math.max(2, Math.min(basePerDay + 2, Math.round(dayHours / 1.6)))
    : basePerDay;
  // 日帰りは残り時間で決まり、泊まりは日数で決まります。
  // 「1日あたり3〜4か所」を素直に日数倍しないと、10日間の旅程が
  // 4スポットのままになります（実際にそうなっていました）。
  // 「この場所は外す」を押されたときの上限。
  //
  // 除外するだけでは、空いた枠を別の場所が埋めます。組み直しとしては
  // 正しいのですが、押した人には「消したのに数が減らない」と映り、
  // 「別の候補」との違いも分かりません。
  //
  // 減らす数ではなく**上限の絶対値**で受け取ります。ここで計算する
  // maxSpots は「入れてよい数」であって「実際に入る数」ではありません。
  // 収録が少ない土地では、11まで入れてよくても10しか入りません。
  // そこで11から1を引いても、結果は10のままで何も変わりませんでした。
  // 押したときの実際の件数から1を引いた値を、呼ぶ側が渡します。
  const cap = Number.isFinite(trip.must?.spotCap)
    ? Math.max(1, Math.round(trip.must.spotCap)) : Infinity;
  const maxSpots = Math.min(cap, nights === 0
    ? Math.max(3, Math.min(11, Math.round(hours / 1.8)))
    : Math.max(4, Math.min(48, days * perDay)));
  // 宿の取りかたで、回るエリアの数が変わります。連泊なら絞り、
  // 周遊なら泊まるたびに土地が変わります（stays.js）。
  //
  // 移動を楽しみたい人には、宿の取りかたが「おまかせ」なら泊まり歩きにします。
  // 毎日ちがう土地へ動くことが、この人たちの旅だからです。
  const maxRegions = suggestRegionCount(days, null,
    enjoyTravel && trip.stayStyle === "auto" ? "tour" : trip.stayStyle);
  const targets = mixTargets(maxSpots, trip.hiddenBias);

  // 「必ず行く」は絶対条件なので、地名の指定より優先します。
  // ただし到達できるかどうかは、他のエリアと同じように確かめます。
  // ここで検査から外すと、往復できないエリアが黙って旅程に入ります。
  const mustSpotIds = (trip.must?.spotIds ?? []).filter((id) => kb.spotsById.has(id));
  const avoidSpotIds = trip.must?.avoidSpotIds ?? [];
  const mustRegionIds = new Set(
    mustSpotIds.map((id) => kb.spotsById.get(id).regionId));

  const searchRegions = scope.regionIds
    ? kb.regions.filter((r) => scope.regionIds.has(r.id) || mustRegionIds.has(r.id))
    : kb.regions;
  const { kept: reachable, rejected: unreachable } = reachableRegions(
    searchRegions, {
      origin: trip.origin,
      endPlace: endPlace(trip) ?? trip.origin,
      totalMinutes: Math.round((trip.arriveBy - trip.departAt) / 60000),
      nights, travelFn: estimateMinutes,
    });
  if (!reachable.length) {
    const term = scope.matched.map((a) => a.term).join("・");
    const where = term ? `「${term}」の収録エリアは`
      : "指定の時間内で行ける旅先が";
    throw new PlanError(
      `${where}、この日程では${trip.origin.name}から往復できませんでした。`,
      relaxForUnreachable({ trip, rejected: unreachable, areaTerm: term }));
  }
  const reachableIds = new Set(reachable.map((r) => r.region.id));
  const inRange = matches.filter((m) => reachableIds.has(m.spot.regionId));

  // 絶対条件のエリアは、検索の点数で落とさない（到達判定は通ったもののみ）。
  // 「行ける候補が無い」の判定より前に入れます。地名の指定に合う場所が
  // 全部届かなくても、「必ず行く」が届くならその旅程は成立するからです。
  const unreachableMust = [];
  for (const rid of mustRegionIds) {
    if (!reachableIds.has(rid)) {
      unreachableMust.push(kb.regionsById.get(rid));
      continue;
    }
    if (inRange.some((m) => m.spot.regionId === rid)) continue;
    for (const sp of kb.spotsByRegion.get(rid) ?? []) {
      inRange.push({ spot: sp, score: mustSpotIds.includes(sp.id) ? 9 : 0.5 });
    }
  }

  if (!inRange.length) {
    throw new PlanError(
      "ご希望に合う場所は見つかりましたが、この時間内では往復できません"
      + `（${unreachable.length}件の旅先が時間の都合で対象外）。`,
      relaxForUnreachable({ trip, rejected: unreachable }));
  }

  const travelByRegion = new Map(
    reachable.map((r) => [r.region.id, r.oneWay + r.toEnd]));
  const ranked = rankRegions(kb, inRange, 12, {
    oneWayByRegion: travelByRegion,
    totalMinutes: Math.round((trip.arriveBy - trip.departAt) / 60000),
    wantedGenres: [...new Set([...trip.interests, ...query.interests])],
    days, enjoyTravel,
  });
  const spreadGroups = scope.spread ? scope.groupById : null;
  const candidates = spreadCandidates(ranked, 10, spreadGroups, {
    avoidRegionIds: opts.avoidRegionIds ?? [],
    keepRegionIds: mustRegionIds,
    need: maxRegions,
  }).map((c) => {
    const matched = new Map(c.spots.map((s) => [s.spot.id, s]));
    const all = kb.spotsByRegion.get(c.region.id) ?? [];
    const pool = [
      ...c.spots,
      ...all.filter((s) => !matched.has(s.id)).map((s) => ({ spot: s, score: 0 })),
    ];
    // モデルに見せる候補。16件では、選ぶ前から選択肢が尽きていました。
    const shown = balanceByTier(pool, Math.min(28, pool.length),
                                trip.hiddenBias);
    // 「必ず行く」は、上限からはみ出しても必ず入れます。
    //
    // ここを見落としていました。エリアの候補を28件に絞るときに、
    // 指定された場所が29番目だと、そこで消えます。以降の「必ず入れる」
    // 処理は候補集合の中しか見ないので、**指定したのに入らない**旅程が
    // できていました（鎌倉大仏を指定して鎌倉が選ばれるのに、
    // 大仏だけ入らない）。
    const have = new Set(shown.map((x) => x.spot.id));
    for (const s of pool) {
      if (mustSpotIds.includes(s.spot.id) && !have.has(s.spot.id)) {
        shown.unshift(s);
        have.add(s.spot.id);
      }
    }
    return { ...c, spots: shown };
  });

  // 絵に、候補を渡します（待ち画面で、絞られた星が明るくなります）。
  // 描くのは本物の座標です。候補は多くても数百件なので、そのまま。
  onProgress(2, "", { picks: candidatePool(candidates).slice(0, 400) });
  const planOpts = { maxRegions, days, mustSpotIds, avoidSpotIds,
                     groupById: scope.groupById ?? null,
                     // 広い範囲の指定（日本全国・九州など）。1つの地方に固めません。
                     spread: Boolean(spreadGroups),
                     enjoyTravel,
                     // 車で来ている人に、駅前だけを並べないための合図です。
                     touring: isTouring(trip), signal };
  let proposal = await proposePlan(candidates, query, trip.note,
                                   maxSpots, targets, "", planOpts);
  stop();

  onProgress(3, "移動時間と営業時間を照合しています");
  let checked = await verifyProposal(proposal, trip, candidates, kb,
                                     { useRoutes: false, signal });

  // 通る案になるまで、作り直します。
  //
  // 1回だけ直していたころは、「時間が合わない場所が3件」のまま出ることが
  // ありました。2回目で別の問題が出ても、そこで打ち切っていたためです。
  // 問題が残っているあいだは、その理由を渡してまた作らせます。
  // 案は毎回点をつけて、**いちばん良かったものを覚えておきます**
  // （作り直すほど良くなるとは限らないので、最後の案を採るのは誤りです）。
  let repaired = false;
  // AIに案を聞いた回数（管理画面の「平均ラウンド数」。js/metrics.js）
  let usedRounds = 1;
  // 作り直す条件。
  //
  //   ・時間の合わない立ち寄りが残っている
  //   ・日数を埋めきれていない
  //   ・**予定の空いている時間が長い**（5時間の空白は旅程ではありません）
  //   ・**開くまでの待ちが長い**（「開くまで約60分」の行が立つ日）
  //
  // 下の2つは、時刻の入った旅程にしないと分かりません。案ごとに一度
  // 組んで（draftItinerary）から見ます。組むのは手元の計算だけなので、
  // 何度呼んでも費用はかかりません。
  const needsRepair = (c, itin) => !c.result.ok || c.result.underfilled
    || longestGap(itin) > MAX_GAP_MIN
    || longestFreeMin(itin) > MAX_FREE_MIN;
  let firstDraft = draftItinerary(checked, trip, kb);
  if (needsRepair(checked, firstDraft) && hasApiKey()) {
    const rounds = Math.max(1, TUNING.maxPlanRounds ?? 4);
    let best = { proposal, checked, itin: firstDraft, key: "first" };
    for (let round = 2; round <= rounds; round++) {
      const worst = best.checked.result.issues.length;
      const gap = longestGap(best.itin);
      onProgress(4, worst
        ? `${worst}件の問題を見つけました。${round - 1}回目の作り直しです`
        : gap > MAX_GAP_MIN
          ? `予定の空いている時間が${Math.round(gap / 60)}時間あります。`
            + `${round - 1}回目の作り直しです`
          : `予定の空きが多いため、${round - 1}回目の作り直しです`);
      let next;
      try {
        next = await proposePlan(candidates, query, trip.note, maxSpots,
                                 targets, issuesToPrompt(best.checked.result),
                                 planOpts);
      } catch (e) {
        // やめると言われたのなら、最善を出さずに止まります。
        stop();
        // 途中で聞けなくなっても、それまでの最善は残っています。
        noteAiError(e);
        break;
      }
      stop();
      usedRounds = round;
      const recheck = await verifyProposal(next, trip, candidates, kb,
                                           { useRoutes: false, signal });
      const round0 = { key: `round${round}`, proposal: next, checked: recheck,
                       itin: draftItinerary(recheck, trip, kb) };
      const pick = pickBest([best, round0],
                            { interests: trip.interests ?? [], enjoyTravel });
      if (pick?.key === round0.key) {
        best = round0;
        repaired = true;
      }
      // 通ったら、そこで止めます。これ以上こねても良くなりません。
      if (!needsRepair(best.checked, best.itin)) break;
    }
    proposal = best.proposal;
    checked = best.checked;
  }

  // 採用が決まってから、実際の経路を取りにいきます（ここだけが課金対象）。
  // 絵には決まった順を渡します。線が落ち着き、番号が打たれます。
  onProgress(4, "採用した案の経路を確認しています",
             { route: (checked.result?.visits ?? []).map((v) => v.spot) });
  const routed = await verifyProposal(proposal, trip, candidates, kb,
                                      { useRoutes: true, signal,
                                        nightTrain: intent.nightTrain });
  stop();
  if (routed.result.visits.length) checked = routed;

  onProgress(5, "", { route: (checked.result?.visits ?? []).map((v) => v.spot) });
  // 使い回せるように、読み取り結果を外へ返します
  const region = kb.regionsById.get(proposal.regionId);
  const reasons = new Map(proposal.picks.map((p) => [p.spotId, p.reason]));
  const itin = buildItinerary({
    trip, kb, region, stays: checked.stays, visits: checked.result.visits,
    meals: checked.result.meals, moves: checked.result.moves,
    reasons, legs: checked.legs, legDetail: checked.legDetail,
  });
  // AIが付けた見出しだけを使います。キー未設定のときの自動見出しは
  // エリア名の羅列でしかなく、上の見出しと同じことを繰り返すだけなので。
  // 1日が始まる前に着いてしまい、何もできなかった時間。助言に使います。
  itin.morningIdleMin = checked.result.morningIdleMin ?? 0;
  itin.headline = proposal.fromModel ? proposal.headline : "";
  itin.rationale = proposal.rationale;
  itin.verifyNote = buildVerifyNote(checked, repaired, proposal);
  itin.rounds = usedRounds;
  // 連泊なら、その1か所。宿を動かさない旅だと分かる1行を出すために
  // 使います（stays.js が選んでいます）。
  //    駅名ではなく土地の名前で言います。「松江駅に2泊」は、駅で
  //    寝るように読めます。
  itin.basedAt = checked.basedAt
    ? (checked.stays?.find((s) => s.station === checked.basedAt)?.region?.name
       ?? checked.basedAt.name)
    : null;

  // 7. 希望に応えられたか
  const chosenSpots = checked.result.visits.map((v) => v.spot);
  // 地名は areaNote が別に説明するので、ここでは数えません。
  // 二重に「応えられなかった」と言うことになるためです。
  const areaTerms = new Set([
    ...scope.matched.map((a) => a.term),
    ...scope.missing.map((a) => a.term),
  ]);
  const wanted = extractKeywords(trip.note).keywords
    .filter((t) => !areaTerms.has(t) && !areaTerms.has(`${t}県`))
    // 「さん都心」から取り出された「都心」は、呼び名（三都心）の一部です。
    .filter((t) => t.length < 2
      || ![...areaTerms].some((a) => a.length > t.length && a.includes(t)))
    // 旅のしかたの名前（「国道」「最長往復切符」）は、場所ではありません。
    .filter((t) => !journey || !isJourneyWord(t, journey));
  const coverage = analyzeCoverage(wanted, chosenSpots, kb.spots);
  itin.coverage = coverageMessage(coverage, itin.regionName,
                                  { sampleData: kb.source === "sample" });
  const discoveryNotes = [];
  const sources = [];
  for (const d of discovered) {
    if (d.ok) {
      const where = d.country && d.country !== "日本" ? `${d.country}の` : "";
      discoveryNotes.push(`${where}「${d.term}」は収録が無かったため、`
        + `AIが検索して調べた${d.areas}エリア・${d.spots}スポットを`
        + "候補に加えました。営業時間・料金・場所は未確認です。"
        + "訪問前に公式情報をご確認ください。");
      if (d.unverifiedPlace?.length) {
        discoveryNotes.push(`${d.unverifiedPlace.join("・")}については、`
          + "国の位置と突き合わせる基準を持っていないため、"
          + "座標の確からしさを確認できていません。");
      }
      for (const src of d.sources ?? []) sources.push(src);
    } else {
      discoveryNotes.push(`「${d.term}」は収録が無く、${d.reason}。`);
    }
  }
  itin.discovered = discovered;
  itin.sources = dedupeSources(sources);

  // 絶対条件が守れなかったときは、いちばん先に伝えます。
  const mustNotes = (checked.conflicts ?? []).map((c) =>
    `「必ず行く」に指定された${c.name}を旅程に入れられませんでした。${c.detail}`);
  for (const r of unreachableMust) {
    mustNotes.push(`「必ず行く」に指定された${r.name}は、この日程では`
      + `${trip.origin.name}から往復できないため外しました。`);
  }
  // 地名を書いたのに別の地方が選ばれたなら、理由を言います。
  // 絶対条件が優先された結果であって、地名を無視したのではありません。
  if (scope.regionIds && !scope.regionIds.has(itin.regionId)) {
    const pinnedHere = mustSpotIds
      .filter((id) => kb.spotsById.get(id).regionId === itin.regionId)
      .map((id) => kb.spotsById.get(id).name);
    mustNotes.push(pinnedHere.length
      ? `「${scope.matched.map((a) => a.term).join("・")}」をご指定でしたが、`
        + `「必ず行く」の${pinnedHere.join("・")}を優先して`
        + `${itin.regionName}にしました。`
      : `「${scope.matched.map((a) => a.term).join("・")}」の中には`
        + `この日程で回れるエリアが無かったため、${itin.regionName}にしました。`);
  }

  // 調べにいった地名については discoveryNotes が結果を述べています。
  // areaNote が同じ地名でもう一度「収録がありません」と言うと、
  // 同じことを二度言うことになります。
  // 割り出しが走ったなら、名指しの場所は「調べていない」わけではありません。
  // 調べたうえで日程に入らなかったものと、そもそも収録が無いものは別物です。
  const askedFor = resolved?.places?.map((p) => p.name) ?? [];
  const covered = discovered.filter((d) => d.ok).map((d) => d.term);
  const notCovered = namedTerms.filter((t) =>
    !covered.some((c) => c.includes(t) || t.includes(c))
    && !askedFor.some((a) => a.includes(t) || t.includes(a)));
  if (resolved && notCovered.length) {
    discoveryNotes.push(
      `名指しいただいた場所のうち、${covered.join("・")}を調べて旅程に入れました。`
      + `${notCovered.join("・")}は、日程に対して行き先が多くなるため`
      + "今回は入れていません。日数を延ばすか、行き先を絞ると入れられます。");
  }

  const handled = new Set([
    ...discovered.map((d) => d.term),
    // 割り出しが走った場合、名指しの語はすべて「見た」ことになります。
    // 見たうえで外したものに「収録がありません」と言うのは誤りです。
    ...(resolved ? namedTerms : []),
  ]);
  const areaNotes = areaNote(
    { ...scope, missing: scope.missing.filter((a) => !handled.has(a.term)) },
    {
      chosenRegionName: itin.regionName,
      unknownTerms: unknownPlaceTerms(trip.note, kb)
        .filter((t) => !handled.has(t)),
    });
  // 「出発地の近くに収録エリアが無い」ときだけ伝える。
  // 判断材料は、選ばれた旅先までの距離ではなく *最も近い* 収録エリアまでの
  // 片道時間です。近場があるのに遠くが選ばれたのは、希望に合ったからであって
  // 収録不足ではないので、そこで警告を出すのは誤りになります。
  const nearestOneWay = Math.min(...reachable.map((r) => r.oneWay));
  const chosenOneWay = reachable.find((r) => r.region.id === region.id)?.oneWay ?? 0;
  const farNotes = [];
  // 地名を指定されたときは、その範囲だけを見ています。範囲の外に近い
  // エリアがあっても「近くに収録が無い」とは言えないので、出しません。
  if (!scope.regionIds && nearestOneWay > 180) {
    farNotes.push(`${trip.origin.name}の近くには収録エリアがありません。`
      + `最も近い収録エリアでも片道約${Math.round(nearestOneWay / 60)}時間のため、`
      + `${region.name}（片道約${Math.round(chosenOneWay / 60)}時間）を提案しています。`
      + "近場を増やすには知識ベースの拡充が必要です。");
  }
  itin.crowd = trip.avoidCrowds === false ? null : itineraryCrowd(itin);
  itin.cost = costBreakdown(itin, { people: trip.people ?? 1,
                                    transport: trip.transport ?? "any" });
  // 何人ぶんの金額なのかを、旅程そのものに持たせます（画面と
  // 書き出しが、それぞれ trip を見に行かなくて済むように）。
  itin.people = trip.people ?? 1;
  itin.sun = sunNotes(itin);
  itin.critique = critique(itin);
  // 旅程の質は、プログラム側で数えて採点します。AIに自己採点させると、
  // 同じ旅程でも聞くたびに点が変わり、案どうしを比べられません。
  itin.score = scoreItinerary(itin, { interests: trip.interests ?? [],
                                     enjoyTravel });
  // 3案を作るとき、広い範囲の指定なら案ごとに別の地方を出すために使います。
  itin.regionIds = [...new Set(chosenSpots.map((sp) => sp.regionId))];
  itin.spread = Boolean(spreadGroups);
  itin.enjoyTravel = enjoyTravel;
  // 帰りの余裕は verify.js が数えています。旅程にも持たせます
  // （どこまで裏が取れているかを出すのに要ります）。
  itin.slackMin = checked.result.slackMin;
  itin.reliability = tripReliability(itin);

  // 8. 天気・日没・混雑から、見直しの提案を作ります。
  //    ここでは提案を出すだけで、旅程は変えません。押されたときだけ
  //    条件を書き換えて、同じ手順で組み直します。
  itin.replan = await buildReplan(itin, candidates, opts);
  stop();
  //    予定どおりに行けなかったときの代わりも、ここで1か所ずつ決めます。
  //    雨や休館は現地で分かることなので、出発前に近くの代わりを
  //    決めておかないと、電波の弱い場所で探すことになります。
  itin.backupCount = attachBackups(itin, candidatePool(candidates),
                                   { transport: itin.transport });
  //    食事は「昼食／◯◯で」だけでは旅程になりません。その土地の
  //    名物までは決められるので、決めます（店は持っていないので、
  //    店は地図に渡します）。候補集合ではなく収録全件から探すのは、
  //    食事どころが興味の絞り込みで落ちていることがあるためです。
  itin.mealCount = attachMeals(itin, {
    spots: kb.spots, genre: trip.foodGenre,
    // 食べられないもの。ここが抜けていると、選んでも何も変わりません。
    diet: trip.diet,
  });
  // 制約があるなら、旅程に断り書きを添えます。
  // **「対応店です」とは言いません。** 変えたのは地図を探す言葉だけで、
  // その店が条件に合うかは確かめられません。
  const dn = dietNote(trip.diet);
  if (dn) itin.warnings = [...(itin.warnings ?? []), dn];
  // 8.5 移動そのものを、旅の一部にする。
  //
  //     車で来ている人は、走ること自体を目的にしています。電車でも
  //     同じで、五能線の日本海沿いは乗ることが目的になります。
  //     これまで移動は「あいだの時間」でしかありませんでした。
  //
  //     時刻も費用も経路も変えません。**説明だけ**を足します。
  itin.scenicCount = attachScenic(itin, { transport: trip.transport });
  // 8.55 点ではないもの（道・広い場所）を、点として案内しない。
  //
  //      「山背古道 40分」と書かれても、どこから入ってどこへ抜けるのか
  //      が決まっていません。「舞洲 40分」も、島のどこへ行くのかが
  //      決まっていません。
  //
  //      **経路は組み替えません。** 組み替えるには道の形が要り、
  //      収録で両端が分かるのは144本中1本だけです（山背古道）。
  //      持っていないものを推し量ると、行けない旅程ができます。
  //      分かることを言い切り、分からないことは分からないと書きます。
  // 8.45 同行者のための一言（js/access.js）。
  //
  //      収録に「バリアフリーかどうか」はありません。持っているのは
  //      分類だけです。**「行けません」とは言いません。** 何がつらい
  //      分類なのかと、確かめ先を書きます。
  itin.accessCount = attachAccess(itin, trip.companions);

  itin.shapeCount = await attachShapes(itin, {
    spots: kb.spots,
    nearestStop,
  });
  stop();

  // 8.5 終電の線。
  //
  //     帰りの移動には「18:40発」としか書いてありませんでした。
  //     当日に知りたいのは、その隣にある数です——その駅の終電は何時か。
  //
  //     これが無いと2つのことが起きます。夕暮れがきれいでも、何分まで
  //     粘れるか分からないので1本前で帰ります。そして、立ち寄りを
  //     足して帰りが終電より後になっても、**誰も何も言いません**。
  //
  //     Yahoo!路線情報には終電の検索（type=2）があります。あるものを
  //     聞くだけです。聞けなければ黙って空けます。
  //
  //     経路を調べられなかった旅程（目安だけで組んだもの）には出ません。
  //     どの駅から乗るのかが分からないので、終電も聞けません。
  itin.lastTrainCount = await attachLastTrain(itin, async (from, to, when) => {
    try {
      return await searchYahooTransit(from, to, {
        departAt: when, search: "last",
        modes: yahooFlags(trip.transport ?? "any"),
        signal: opts.signal,
      });
    } catch {
      // 回数制限や通信の失敗。終電のために旅程を止めません。
      return null;
    }
  });
  stop();

  // 8.55 切符のこと。
  //
  //      「乗れる」と「乗車券だけで乗れる」は違います。新幹線は
  //      乗車券のほかに特急券が要り、指定席か自由席かを買うときに
  //      決める必要があります。同じ会社に1日で何度も乗るなら、
  //      1日乗車券があるかもしれません。
  //
  //      **得かどうかは言いません。** 券の名前も値段も条件も
  //      持っておらず、毎年変わります。数えられるのは回数だけです。
  itin.ticketCount = attachTickets(itin);

  // 8.6 同じ地点にある立ち寄りを、そう書く。
  //
  //     名前が違うので1つにはまとめませんでした（別のものかもしれない
  //     からです）。ただ、座標が同じなら移動は0分です。
  //
  //       九重山 と 久住山          同じ座標の別名。どちらが正しいかは
  //                                こちらでは決められません
  //       小樽美術館 と 小樽文学館   同じ建物の別の施設。続けて回れます
  //
  //     **決めずに、そう書きます。** 読む人が判断できます。
  for (const day of itin.days ?? []) {
    const spots = (day.items ?? []).filter((i) => i.kind === "spot" && i.place);
    for (const group of coLocated(spots.map((i) => i.place))) {
      const names = group.map((p) => p.name);
      for (const item of spots) {
        if (!group.includes(item.place)) continue;
        const others = names.filter((n) => n !== item.place.name);
        item.sameSpot = others;
      }
    }
  }
  // 9. その時期ならではのこと、荷物、旅の意味づけ。
  //    どれも数えれば決まるので、AIには書かせません
  //    （同じ旅程で毎回違う説明が出ると、説明として成立しません）。
  itin.seasonNotes = eventNotesFor(itin);
  itin.luggage = luggagePlanFor(itin);
  //    そのうえで、「荷物を預ける」を朝いちの一手として旅程に入れます。
  //    下の囲みに書いてあっても、現地では旅程の行しか追いません。
  //    時刻はずらしません（出発の前に置きます。luggage.js）。
  itin.luggageSteps = attachLuggage(itin);
  itin.story = storyFor(itin);

  // 3案を作るときに使い回すための持ち出し
  itin.query = query;
  itin.vector = vector;
  itin.suggestions = relaxForItinerary({ trip, checked });

  // 「できるだけ予算内に収める」を選んでいたら、入場料の高い場所を
  // 外して組み直します。1回だけです。削るほど旅は薄くなるので、
  // 収まらなければ「収まりません」と言うほうが正直です。
  if (trip.budgetMode === "strict" && !opts.noBudgetRetry) {
    const overs = overBudgetSpots(itin, trip.budgetYen);
    if (overs.length) {
      const trimmedTrip = { ...trip, must: { ...(trip.must ?? {}),
        avoidSpotIds: [...(trip.must?.avoidSpotIds ?? []),
                       ...overs.map((s) => s.spotId).filter(Boolean)] } };
      try {
        const again = await planTrip({ ...opts, kb, onProgress,
                                       trip: trimmedTrip,
                                       noBudgetRetry: true, query, vector });
        const now = again?.cost?.total ?? Infinity;
        if (now <= trip.budgetYen) {
          again.warnings = [
            `予算に収めるため、入場料の高い${overs.length}か所を外しました`
            + `（${overs.map((s) => s.title).join("・")}）。`
            + "残したい場所があれば、「◯◯は入れて」と書き足してください。",
            ...(again.warnings ?? []),
          ];
          return again;
        }
      } catch { /* 組み直せなければ、下の注意書きで伝えます */ }
    }
  }

  const journeyNotes = [];
  if (journey) journeyNotes.push(journeyNote(journey));
  if (enjoyTravel) {
    journeyNotes.push("移動も旅のうちとして組んでいます。遠いエリアや長い"
      + "乗車を減点せず、日ごとに土地を移るようにしました。"
      + (!["any", "transit"].includes(trip.transport) ? ""
        : "青春18きっぷで行くなら、移動手段を「普通列車のみ」にすると、"
          + "新幹線と特急を使わずに組みます。"));
  }
  if (spreadGroups && itin.regionIds.length > 1 && !journey?.along.length) {
    const blocks = [...new Set(itin.regionIds
      .map((id) => spreadGroups.get(id)).filter(Boolean))];
    if (blocks.length > 1) {
      journeyNotes.push(scope.matched.length
        ? `広い範囲のご指定なので、1か所に固めず${blocks.join("・")}に`
          + "分けて回ります。"
        : `${blocks.join("・")}と、地方をまたいで回ります。`);
    }
  }

  itin.warnings = [
    ...intent.notes,
    ...journeyNotes,
    ...poolNote(kb, candidates),
    ...earlyStartNote(itin, trip),
    ...aiNotes(),
    ...transitSourceNote(itin),
    ...budgetNotes(itin, trip),
    ...mustNotes,
    ...discoveryNotes,
    ...areaNotes,
    ...farNotes,
    ...wishNotes,
    ...seasonalNotes(chosenSpots, trip.departAt),
    ...itin.warnings,
  ];

  return itin;
}

/**
 * その区間に乗って、着く時刻。
 *
 * Yahoo!が返す minutes は「頼んだ時刻から着くまで」で、**便を待つ時間を
 * すでに含んでいます**（4:00発で頼んで6:28発の便なら、8:49着まで
 * 4時間49分）。ここに waitMinutes をもう一度足していたので、着いてから
 * 2時間28分が空白になっていました（8:49着なのに、次の予定が11:17）。
 */
export function arrivalAfter(departAt, leg) {
  // 夜行は、出発できる時刻に所要時間を足しても着きません。
  // 21:50に東京を出る列車は、10時に家を出ても21:50発です。
  // 着く時刻そのものを持っているなら、それを使います。
  if (leg?.arriveAt instanceof Date) return new Date(leg.arriveAt);
  const min = Number.isFinite(leg?.minutes) ? leg.minutes : 0;
  return new Date(departAt.getTime() + min * 60000);
}

/** 旅の d 日目の、hour 時ちょうど。 */
function dayTime(trip, day, hour) {
  const d = new Date(trip.departAt.getTime() + day * 86400000);
  d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  return d;
}

/** 帰りの便に乗る時刻。帰着の期限から、かかる時間を引きます。 */
function returnDeparture(trip, nights, points) {
  const back = estimateMinutes(points[points.length - 2],
                               points[points.length - 1]);
  const limit = trip.arriveBy ?? dayTime(trip, nights, 20);
  return new Date(limit.getTime() - back * 60000);
}

/**
 * 立ち寄りを、いちばん近い拠点に割り当てます。
 *
 * ここは以前、**エリアIDが滞在先と完全に一致する立ち寄りだけ**を
 * 残していました。収録のエリアは1,370あり、大阪の難波なら
 * 「大阪・ミナミ」と「大阪市」に分かれています。AIが両方から選ぶと、
 * 片方が黙って消えます。実際に出ていた旅程が、難波を拠点にした1日で
 * 立ち寄り1か所です（近くに146か所あるのに）。収録を増やすほど、この
 * 取りこぼしはひどくなります。エリアが細かくなるからです。
 *
 * 見るのは名前ではなく距離です。どの拠点からも遠い立ち寄りは、その日の
 * うちに往復できないので外します。
 *
 * @param {object[]} spots
 * @param {Array<{station?:object, region:object}>} stays
 * @returns {object[][]} 拠点ごとの立ち寄り
 */
export function assignToStays(spots, stays) {
  const byStay = stays.map(() => []);
  for (const spot of spots) {
    let best = -1;
    let bestKm = Infinity;
    for (const [i, s] of stays.entries()) {
      const km = haversineKm(spot, s.station ?? s.region);
      if (km < bestKm) { best = i; bestKm = km; }
    }
    if (best < 0 || bestKm > STAY_REACH_KM) continue;
    byStay[best].push(spot);
  }
  return byStay;
}

/**
 * 立ち寄りが日数に足りない滞在を、近くの収録から埋めます。
 *
 * 埋めるのは**足りないぶんだけ**です。AIの選びかたを上書きするので
 * はなく、選び残した日を埋めます。近い順に採るので、その日の道順を
 * 大きく崩すことはありません。
 *
 * @param {Array<object[]>} byStay その場で書き換えます
 */
function topUpStays(byStay, stays, kb, { perDay, avoid }) {
  const taken = new Set(byStay.flat().map((s) => s.id));
  for (const [i, stay] of stays.entries()) {
    // 少し多めに用意します。営業時間や定休日でいくつかは落ちるので、
    // ぴったりの数だけ渡すと、落ちたぶんがそのまま**その日の穴**に
    // なります（9:04に見学が終わって、次は17:30の夕食）。
    const want = Math.max(3, Math.round(perDay * (stay.days ?? 1) * 1.4));
    const have = byStay[i].length;
    if (have >= want) continue;
    const base = stay.station ?? stay.region;
    const near = [];
    for (const spot of kb.spots) {
      if (taken.has(spot.id) || avoid.has(spot.id)) continue;
      const km = haversineKm(spot, base);
      if (km <= TOP_UP_KM) near.push({ spot, km });
    }
    // 近い順。同じ距離なら、知られている場所から。
    const tier = { major: 0, known: 1, hidden: 2 };
    near.sort((a, b) => (a.km - b.km)
      || ((tier[a.spot.fame_tier] ?? 3) - (tier[b.spot.fame_tier] ?? 3)));
    for (const { spot } of near.slice(0, want - have)) {
      byStay[i].push(spot);
      taken.add(spot.id);
    }
  }
}

// 埋めるときに見る範囲。拠点から歩きか短い乗り物で行ける距離です。
const TOP_UP_KM = 12;

/**
 * 予定の尽きた日に、その日の拠点の近くから立ち寄りを足します。
 *
 * @returns {object[]} 足した立ち寄り（無ければ空）
 */
function fillEmptyDays(visits, opt) {
  const { kb, baseByDay, stays, dayEndHour, nights, used, avoid,
          dayFloorById, dayCeilById } = opt;
  const lastEndByDay = new Map();
  for (const v of visits) {
    const d = v.day ?? 0;
    const prev = lastEndByDay.get(d);
    if (!prev || v.end > prev) lastEndByDay.set(d, v.end);
  }

  const out = [];
  for (let day = 0; day <= nights; day++) {
    const end = lastEndByDay.get(day);
    if (!end) continue;                       // 立ち寄りの無い日は別の話です
    const limit = atHour(end, dayEndHour);
    const freeMin = Math.round((limit - end) / 60000);
    if (freeMin <= FILL_GAP_MIN) continue;

    // 空いた時間を、1か所あたり90分（見学＋移動）で割ります。
    const want = Math.min(4, Math.floor(freeMin / 90));
    const base = baseByDay?.[day] ?? stays[0].station;
    // 近いところから。見つからなければ、少し広げます。山あいの拠点だと
    // 12km以内に残りが無いことがあり、そこで諦めると日が空いたままです。
    let near = [];
    for (const reach of [TOP_UP_KM, TOP_UP_KM * 2.5]) {
      near = [];
      for (const spot of kb.spots) {
        if (used.has(spot.id) || avoid.has(spot.id)) continue;
        const km = haversineKm(spot, base);
        if (km <= reach) near.push({ spot, km });
      }
      if (near.length >= want) break;
    }
    const tier = { major: 0, known: 1, hidden: 2 };
    near.sort((a, b) => (a.km - b.km)
      || ((tier[a.spot.fame_tier] ?? 3) - (tier[b.spot.fame_tier] ?? 3)));
    for (const { spot } of near.slice(0, want)) {
      // その日に回るものとして入れます。前後の日へ流れると、また空きます。
      dayFloorById.set(spot.id, day);
      dayCeilById.set(spot.id, day);
      used.add(spot.id);
      out.push(spot);
    }
  }
  return out;
}

// これ以上あくと、その日は「予定のある日」とは言えません。
// ここを超えるとAIに案を作り直させます（聞き直すので、しきい値は高め）。
const MAX_GAP_MIN = 300;
/**
 * 日の終わりにこれ以上あいたら、近くから足します。
 *
 * 作り直しと違って、足すのは手元の計算だけです。聞き直さないので、
 * もっと早い段階で動かして構いません。300分にそろえていたので、
 * 「13:34に見学が終わって、次は17:30の夕食」（296分）が、ちょうど
 * すり抜けていました。2時間の空白は、予定表としては空白です。
 */
const FILL_GAP_MIN = 120;
// 開くまでの待ちが、これを超える旅程は作り直します。
const MAX_FREE_MIN = 20;

/** 旅程の中で、いちばん長い「自由時間」（分）。 */
function longestFreeMin(itin) {
  const free = (itin?.days ?? []).flatMap((d) => d.items ?? [])
    .filter((i) => i.kind === "free" && i.start && i.end)
    .map((i) => Math.round((i.end - i.start) / 60000));
  return free.length ? Math.max(...free) : 0;
}

/**
 * 立ち寄りの数に上限があるなら、そこまでに絞ります。
 *
 * 上限は「この場所は外す」を押されたときだけ入ります。
 *
 * 絞る場所がここなのには理由があります。案を選ぶ段階（proposePlan）でも
 * 上限までに切っていますが、そのあと topUpStays と fillEmptyDays が
 * 「空いた日」を埋めるために足します。押した人から見ると、1か所外した
 * そばから別の場所が入ってくることになります。**外したぶんは空けたまま
 * にする**のが、押したときの意味です。
 *
 * 「必ず行く」は残します。行くと言った場所を、数合わせで落としません。
 */
function capSpots(spots, trip) {
  const cap = trip.must?.spotCap;
  if (!Number.isFinite(cap) || spots.length <= cap) return spots;
  const pinned = new Set(trip.must?.spotIds ?? []);
  const keep = spots.filter((s) => pinned.has(s.id));
  const rest = spots.filter((s) => !pinned.has(s.id));
  // 並びは崩しません。落とすのは後ろからです。前を落とすと、旅程の
  // 前半が丸ごと入れ替わったように見えます。
  const room = Math.max(0, Math.round(cap) - keep.length);
  const kept = new Set([...keep, ...rest.slice(0, room)].map((s) => s.id));
  return spots.filter((s) => kept.has(s.id));
}

// 出発地がこれより近ければ、最初の拠点は出発地そのものにします。
const ORIGIN_IS_BASE_KM = 3;

// 拠点から、その日のうちに往復できる距離。これを超える立ち寄りは、
// どの拠点にも紐づけません（片道1時間半ほどが目安です）。
const STAY_REACH_KM = 80;

async function verifyProposal(proposal, trip, candidates, kb, opts = {}) {
  // 案を選ぶ段階では、経路APIを呼びません。
  //
  // 以前は1回目の案と作り直した案の両方で経路を取りに行っていました。
  // 1回の旅程作成で 3リクエストのはずが 6 になり、しかも捨てるほうの案の
  // ぶんは完全に無駄です。順序や取捨は距離からの推定で足りるので、
  // 実際の経路は「採用した案」に対してだけ取りにいきます。
  const useRoutes = opts.useRoutes !== false;
  const nights = nightsOf(trip);
  const days = nights + 1;
  const end = dayEnd(trip, nights).place ?? endPlace(trip) ?? trip.origin;

  // AI が選んだエリアを、地理的に無理のない順に並べ、日数を割り振る。
  const chosen = (proposal.regionIds ?? [proposal.regionId])
    .map((id) => candidates.find((c) => c.region.id === id))
    .filter(Boolean);
  if (!chosen.length) chosen.push(candidates[0]);
  let { stays, baseByDay, basedAt } = planStays(chosen, {
    days, origin: trip.origin, end, pace: trip.pace,
    stayStyle: trip.stayStyle,
  });

  // 出発地がもう最初の拠点の中にいるなら、そこが拠点です。
  //
  // 東京駅発で1日目が千代田区だと、こう出ていました。
  //
  //   8:00 東京駅 → 竹橋駅（1.3km）
  //   8:15 貨幣博物館へ移動（1.2km）   ← 東京駅の隣です
  //
  // 出発地から1.3km動いて、また戻ってきています。旅程の1行目が
  // これでは、「東京駅から始まる旅」には見えません。
  if (haversineKm(trip.origin, stays[0].station) < ORIGIN_IS_BASE_KM) {
    const was = stays[0].station;
    stays[0].station = trip.origin;
    if (baseByDay.length) {
      // 連泊では、どの日も同じ拠点が入っています。1日目だけ差し替えると、
      // 同じ宿なのに日によって場所が違うことになります。
      for (let i = 0; i < baseByDay.length; i++) {
        if (i <= stays[0].dayTo || baseByDay[i] === was) {
          baseByDay[i] = trip.origin;
        }
      }
      // 連泊の拠点そのものが出発地だったなら、連泊するのはそこです
      if (basedAt === was) basedAt = trip.origin;
    }
  }

  // 立ち寄りを滞在の順に並べ替える（同じ拠点のぶんは続けて回る）
  const byStay = assignToStays(
    proposal.picks.map((p) => kb.spotsById.get(p.spotId)).filter(Boolean),
    stays);
  // 足りない日を埋めます。
  //
  // 4泊5日で、2日目の立ち寄りが1か所という旅程が出ていました。AIが
  // 選んだ数がそのまま日数に足りていないと、こうなります。周りに
  // 候補が146か所あっても、選ばれなければ旅程には出ません。
  topUpStays(byStay, stays, kb, {
    perDay: SPOTS_PER_DAY[trip.pace] ?? 4,
    avoid: new Set(trip.must?.avoidSpotIds ?? []),
  });
  // 滞在時間を押されたぶんは、ここで差し替えます。足りない日を埋める
  // ぶん（topUpStays）も通るので、どの道から入った場所にも効きます。
  let spots = capSpots(dropSamePlace(byStay.flat()), trip)
    .map((sp) => withDwell(sp, trip.must?.dwellById));
  // 「このスポットは何日目以降に回る」を滞在計画から決めておく。
  //
  // 滞在の初日にまとめて詰め込むと、3日いるエリアで「1日目に4か所、
  // 2日目に1か所、3日目は何も無し」という旅程になります（実際そうでした）。
  // 滞在日数で割って、均した日を下限として与えます。上限ではないので、
  // 前が押していれば後ろにずれるだけです。
  const dayFloorById = new Map();
  // **いつまでに回るか**も決めます。下限しか無かったので、前が押すと
  // 拠点を移したあとの日へずれ込んでいました。実際に出ていた旅程:
  //
  //   2日目 4:00  金沢駅 → 三ノ宮駅（拠点を移します・約200分）
  //         7:20  近江町市場へ移動（約158分・247km）  ← 金沢へ戻っている
  //
  // その日の拠点から247km離れた場所は、もう「その日に回る場所」では
  // ありません。滞在の最終日を上限にして、越えるなら諦めます。
  const dayCeilById = new Map();
  for (const [i, s] of stays.entries()) {
    const list = byStay[i] ?? [];
    const n = list.length || 1;
    list.forEach((sp, k) => {
      dayFloorById.set(sp.id, s.dayFrom + Math.floor((k * s.days) / n));
      dayCeilById.set(sp.id, s.dayFrom + Math.max(0, s.days - 1));
    });
  }

  const dayStart = Number.isFinite(trip.dayStartHour)
    ? trip.dayStartHour : TUNING.dayStartHour;
  const first = stays[0].station;

  let outRoute = null;
  let localRoute = null;
  let stationRoute = null;
  let travelFn = estimateMinutes;
  let legDetail = () => null;
  let outbound = { minutes: estimateMinutes(trip.origin, first),
                   routed: false, line: null };

  // 夜行で行くと書かれていて、その区間に夜行があるなら、往路にします。
  //
  // Yahoo!路線情報は「その時刻に出たら」で答えるので、夜行を狙って
  // 引くのは向きません（朝10時に出れば新幹線が返ります）。夜行は毎日
  // 同じ時刻で走る定期列車なので、表から引きます（js/trains.js）。
  //
  // **決めるのは、日程を組む前です。** あとから差し替えると、
  // 「21:50に東京を出る」旅程なのに、その日の16時に出雲で観光している
  // ことになります（着く時刻が変わるのに、組み直していないため）。
  const nightOut = opts.nightTrain
    ? nightTrainLeg(trip.origin, first, trip.departAt,
                    opts.nightTrain === "any" ? null : opts.nightTrain)
    : null;
  if (nightOut) outbound = nightOut;

  // ここでは**まだ聞きません**。
  //
  // 以前はこの段階で、拠点どうしとエリア内の経路をYahoo!に聞いていました。
  // ところが、このあと trimToFit が時間の合わない立ち寄りを落とすので、
  // 聞いた区間の何本かは旅程に残りません。逆に、落ちた場所をまたぐ
  // 新しい区間は誰も聞いていません。**聞いた区間と、並ぶ区間が違う**
  // というのが、19区間のうち10区間しか実際の便になっていなかった理由です。
  //
  // 順番を決めるだけなら距離の目安で足ります。実際の便は、並びが
  // 決まってから、端から端まで一度に聞きます（measureFinalOrder）。
  // ここには、outbound を推定値へ「戻す」だけの行がありました。
  // 上で入れたばかりの同じ値をもう一度入れるので、ふだんは何も起きません。
  // けれど夜行を入れたあとに通ると、**それを消します**。
  // 何もしない行は、いつか何かを壊します。

  // その日の並び順を決めます。
  //
  // **まず道順、そのあとで混雑**です。混雑だけで並べていたときは、
  // 上高地の河童橋 → 市街の松本城 → また上高地の大正池、という旅程が
  // 出ていました（松本城がいちばん混むので朝いちに引き上げられる）。
  //
  // 混雑を避ける設定を切っていても、道順は整えます。順番がでたらめな
  // 旅程に意味はありません。
  spots = spreadCrowds(spots, {
    dayFloorById,
    start: first,
    // その日の拠点。拠点を移した日は、そこから近い順に回ります。
    baseByDay,
    travelFn,
    // 早く閉まる場所と「必ず行く」場所は、先に回さないと間に合いません。
    pinnedIds: trip.must?.spotIds ?? [],
    useCrowd: trip.avoidCrowds !== false,
    // 並べ替えを押されたぶんは、道順より好みを勝たせます。
    // 時刻はこのあと verify.js が組み直します（その順で入らなければ、
    // これまでどおり入らないぶんが落ちます）。
    orderedIds: trip.must?.orderedSpotIds ?? [],
  });

  // 1日目の起点は、**実際に着く時刻**です。
  //
  // Yahoo!が返す minutes は「頼んだ時刻から着くまで」で、便を待つ時間を
  // **すでに含んでいます**（4:00発で頼んで6:28発の便なら、8:49着まで
  // 4時間49分）。ここに waitMinutes をもう一度足していたので、着いて
  // からの2時間28分が空白になっていました（8:49着、次の予定11:17）。
  const ctx = {
    start: first,
    startAt: arrivalAfter(trip.departAt, outbound),
    end, endBy: trip.arriveBy, pace: trip.pace, travelFn,
    nights, baseByDay, dayFloorById, dayCeilById, day0: trip.departAt,
    // 選んでもらった時間帯を、そのまま2日目以降の枠にします。
    // 渡さないと TUNING の 9:00〜18:30 に固定されたままです。
    dayStartHour: trip.dayStartHour,
    dayEndHour: trip.dayEndHour,
    pinnedIds: trip.must?.spotIds ?? [],
  };
  let trimmed = trimToFit(spots, ctx);

  // 空いた日を埋めます。
  //
  // 「10:51に見学が終わって、次は17:30の夕食」という日が出ていました。
  // 予定表としては成立していますが、6時間半をどう過ごすのかは書いて
  // ありません。**書いていない時間は、旅程ではありません。**
  //
  // 埋めかたは、足りない日に、その日の拠点の近くから足すだけです。
  // AIに聞き直すのではありません（聞ける状態とは限らないうえ、
  // 同じことを何度も頼むことになります）。
  for (let pass = 0; pass < 3; pass++) {
    // 「外す」で上限が入っているなら、埋めません。外したぶんを別の
    // 場所で埋め戻したら、押した意味がなくなります。
    if (Number.isFinite(trip.must?.spotCap)
        && trimmed.result.visits.length >= trip.must.spotCap) break;
    const more = fillEmptyDays(trimmed.result.visits, {
      kb, stays, baseByDay, dayStart, dayEndHour: ctx.dayEndHour ?? 18.5,
      nights, used: new Set(spots.map((x) => x.id)),
      avoid: new Set(trip.must?.avoidSpotIds ?? []),
      dayFloorById, dayCeilById,
    });
    if (!more.length) break;
    // 埋めるときも、同じ場所を足しません。ここを通らないと、いったん
    // 落とした二重の片割れが戻ってきます。
    spots = spreadCrowds(capSpots(dropSamePlace([...spots, ...more]), trip), {
      dayFloorById, start: first, baseByDay, travelFn,
      pinnedIds: trip.must?.spotIds ?? [],
      useCrowd: trip.avoidCrowds !== false,
    });
    trimmed = trimToFit(spots, ctx);
  }

  // ここからが**本番の経路調べ**です。
  //
  // これまでは「AIが選んだ順」で経路を引いていました。ところが、そのあと
  // trimToFit が時間の合わない立ち寄りを落とすので、**実際に並ぶ順とは
  // 別の区間**を調べていたことになります。落ちた場所をまたぐ区間は、
  // 誰も調べていないまま「推定」で残ります。
  //
  // 決まった順番でもう一度、端から端まで引き直します。
  //
  //   1. 旅程を組む（ここまで）
  //   2. 立ち寄り先ごとに、いちばん近い駅・バス停を見つける（routes.js）
  //   3. その並びのまま、全区間をYahoo!路線情報に聞く
  //   4. 返ってきた実際の所要時間で、もう一度時刻を組み直す
  //
  // 3で聞く回数は区間の数だけ増えます（5日で30回ほど）。中継の制限は
  // 電車・バスは中継の別枠（無料側）で数えるので、旅程1本ぶんは
  // 止まらずに通ります。目安で埋めた
  // 旅程を早く出すより、実際の便が入った旅程を待つほうがよい、という
  // 判断です。
  if (useRoutes && opts.measureFinal !== false) {
    // 選んだ場所と、あとから足した穴埋め（topUpStays・fillEmptyDays）。
    // 実際の時刻で入りきらなくなったとき、先に外すのは穴埋めのほうです。
    const chosenIds = new Set([...proposal.picks.map((p) => p.spotId),
                               ...(trip.must?.spotIds ?? [])]);
    const fillerIds = new Set(spots.map((x) => x.id)
      .filter((id) => !chosenIds.has(id)));
    const measured = await measureFinalOrder(trimmed, ctx, trip,
                                             { stays, outbound, nightOut,
                                               fillerIds,
                                               signal: opts.signal });
    if (measured) {
      // 外した場所は、**目安で組んだときのぶんも残します**。
      //
      // ここで measured.trimmed に置き換えるだけだったので、目安の
      // 段階で外した場所（「宮島に行きたい」の弥山・厳島）は数えられず、
      // 実際の経路で組み直すたびに「全スポットが時間内に収まることを
      // 確認」と出ていました。外したのに、外していないと言っていました。
      trimmed = { ...measured.trimmed,
                  dropped: [...(trimmed.dropped ?? []), ...measured.dropped] };
      travelFn = measured.travelFn;
      legDetail = measured.legDetail;
      localRoute = measured.route ?? localRoute;
      // 夜行は表から決めた便です。区間ごとの調べ直しで上書きしません
      // （Yahoo!に聞けば、その時刻の新幹線が返ってきます）。
      if (!nightOut) outbound = measured.outbound ?? outbound;
    }
  }


  const inbound = localRoute?.legs.at(-1) ?? outbound;
  const routeError = localRoute?.error ?? outRoute?.error ?? stationRoute?.error;
  return {
    result: trimmed.result, dropped: trimmed.dropped,
    conflicts: trimmed.conflicts ?? [], stays,
    // 連泊するなら、どこに連泊するか。画面で言えるように持ち出します。
    basedAt,
    legs: { outbound, inbound, local: localRoute, routeError,
            modeNote: localRoute?.modeNote, routed: useRoutes },
    legDetail,
  };
}

/**
 * 決まった並びのまま、全区間の実際の所要時間を取り直します。
 *
 * @returns {{trimmed:object, travelFn:Function, legDetail:Function,
 *            route:object}|null} 取れなければ null（そのままにします）
 */
/**
 * 同じ場所を、2回は置きません。
 *
 * 収録は複数の出典を継ぎ足して作っているので、同じ場所が別の名前で
 * 入っていることがあります。名前でまとめる仕組み（tools/dedupe_spots.py）は
 * ありますが、名前が違えば通り抜けます。
 *
 *   高尾山山頂（takao-2）と 高尾山（lm-60）は **21m** 離れているだけ
 *
 * 結果、旅程にはこう出ていました。
 *
 *   17:50  高尾山
 *   20:43  高尾山山頂へ移動   徒歩約11分・約0.0km
 *   20:54  高尾山山頂
 *
 * 同じ山頂に2回立ち、あいだの「0.0kmを11分」は歩きようがありません。
 * 名前が違っても、これだけ近ければ人にとっては同じ場所です。
 * 先に来たほうを残します（並びは選んだ側が決めています）。
 *
 * 収録データそのものは触りません。別の旅程では別々に出したい場面が
 * ありうるうえ、どちらが正しい名前かはここでは決められないためです。
 */
const SAME_PLACE_KM = 0.12;

export function dropSamePlace(spots) {
  const kept = [];
  for (const s of spots) {
    const twin = kept.find((k) => haversineKm(k, s) < SAME_PLACE_KM);
    if (twin) continue;
    kept.push(s);
  }
  return kept;
}

/**
 * 旅程に並ぶとおりの、端から端までの一本道と、その各区間を通る時刻。
 *
 * ここは以前「拠点 → 立ち寄り… → 終点」だけでした。拠点を移す区間
 * （2日目の朝に別の街へ渡る、など）はこの並びに入らないので、
 * 調べ直しの対象から外れ、そのまま「推定」で残っていました。
 *
 *   往路（出発地→最初の拠点）
 *   その日の立ち寄り…
 *   拠点を移す区間（滞在が変わる日の朝）
 *   次の街の立ち寄り…
 *   帰り（最後の立ち寄り→終点）
 */
export function chainOf(visits, ctx, trip, stays) {
  const points = [trip.origin, stays[0].station];
  const times = [new Date(trip.departAt)];
  // それぞれの点が何なのか（出発地・拠点・立ち寄り・終点）。
  // 電車＋現地の車では、**どの区間を電車で聞くか**をこれで決めます。
  const kinds = ["origin", "station"];
  let stayIdx = 0;
  for (const v of visits) {
    // 滞在が変わる日に入ったら、その朝の拠点移動を挟みます。
    while (stayIdx + 1 < stays.length
           && (v.day ?? 0) >= (stays[stayIdx + 1].dayFrom ?? Infinity)) {
      // **前の拠点の駅から挟みます。**
      //
      // ここが抜けていました。連なりは
      //
      //   … → 前日最後の立ち寄り → 新しい拠点の駅 → …
      //
      // となっていて、調べた区間は「立ち寄り→駅」でした。ところが
      // 旅程に出る行は「京都駅 → 祇園四条駅」（駅から駅）です。
      // 聞いた組と出す組が違うので、**拠点を移す行だけが必ず「目安」**に
      // なっていました。1日目は実測なのに2日目から目安になる、の
      // もう一つの正体がこれです。
      const prevStation = stays[stayIdx].station;
      stayIdx++;
      const at = dayTime(trip, stays[stayIdx].dayFrom,
                         ctx.dayStartHour ?? TUNING.dayStartHour);
      if (prevStation && points.at(-1) !== prevStation) {
        times.push(at);
        points.push(prevStation);
        kinds.push("station");
      }
      times.push(at);
      points.push(stays[stayIdx].station);
      kinds.push("station");
    }
    times.push(new Date(v.arrive.getTime() - (v.travel + v.wait) * 60000));
    points.push(v.spot);
    kinds.push("spot");
  }
  times.push(new Date(visits.at(-1).end));
  points.push(ctx.end);
  kinds.push("end");
  return { points, times, kinds };
}

/**
 * 区間を、移動手段ごとのひと続きに分けます。
 *
 * 「新幹線で行って、駅でレンタカーを借りる」旅では、区間によって
 * 乗るものが違います。ひとつの手段で全部を聞くと、どちらかが嘘に
 * なります。DRIVE で聞けば新幹線が車の所要時間になり、TRANSIT で
 * 聞けばバスが1日3本の土地を待ち続ける旅程になります。
 *
 * 分けかたは1つだけです。
 *   ・出発地 ↔ 拠点、拠点 ↔ 拠点、最後 → 終点 …… 電車（遠出）
 *   ・それ以外（拠点と立ち寄りのあいだ）  …… 車（現地）
 *
 * ほかの移動手段では、これまでどおり**ひと続きのまま**返します。
 * 区間を分けると経路検索の回数が増えるので、分ける理由があるときだけ
 * 分けます。
 *
 * @returns {Array<{mode:string, points:Array, times:Array}>}
 */
export function modeGroups(points, times, kinds, transport) {
  const one = [{ mode: pickMode(points, transport), points, times }];
  if (transport !== "transit+car" || points.length < 2 || !kinds) return one;

  // 拠点に着く区間と、終点に着く区間が遠出です。
  //
  // 立ち寄りから次の拠点へ移る区間も、ここでは電車にします。
  // 車は**その土地で借りて、その土地で返す**前提です（乗り捨ては
  // 別料金なので、勝手に前提にはできません）。
  const longHaul = (i) => kinds[i + 1] === "station" || kinds[i + 1] === "end";

  const out = [];
  let start = 0;
  let mode = longHaul(0) ? "TRANSIT" : "DRIVE";
  for (let i = 1; i + 1 < points.length + 1 && i < points.length - 1; i++) {
    const m = longHaul(i) ? "TRANSIT" : "DRIVE";
    if (m === mode) continue;
    // 境目の点は、両方のひと続きに入れます（区間が抜けないように）
    out.push({ mode, points: points.slice(start, i + 1),
               times: times.slice(start, i + 1) });
    start = i;
    mode = m;
  }
  out.push({ mode, points: points.slice(start), times: times.slice(start) });
  return out.filter((g) => g.points.length >= 2);
}

/**
 * 調べた時刻と、旅程に出る時刻がどれだけずれたか（分）。
 *
 * 同じ並びでも、時刻は1回では決まりません。実際の便で組み直すと、
 * その先の区間を通る時刻がまるごと動くからです。
 */
function worstShift(a, b) {
  let worst = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    worst = Math.max(worst, Math.abs(a[i] - b[i]) / 60000);
  }
  return worst;
}

/**
 * 時刻がずれたと見なす幅（分）。
 *
 * 10:38に出る区間を「09:02発の便」で調べていました。1本目の実測で
 * 旅程ぜんぶが後ろへ動いたのに、調べ直していなかったためです。
 *
 * ここは30分にしていましたが、**都市部では10分で別の便です**
 * （「11:08 夢の島熱帯植物館へ移動／11:19発」が、その幅で残りました）。
 * 数分のずれなら同じ便なので、5分で切ります。
 */
const SHIFT_TOLERANCE_MIN = 5;
/** 調べ直す回数の上限。ここで収まらないなら、それ以上こねても同じです。 */
const MEASURE_ROUNDS = 3;

/**
 * 決まった並びのまま、全区間の実際の所要時間を取り直します。
 *
 * **時刻が動かなくなるまで繰り返します。**
 *
 * 1回では足りません。往路を実測すると、その日の始まりが動きます。
 * すると2区間目以降を通る時刻も動くのに、調べたのは動く前の時刻です。
 * 画面には「10:38 多摩森林科学園へ移動／09:02発→09:04着」と、
 * 1時間半ずれた便が並んでいました。
 *
 * 組み直したあとの時刻を見て、30分以上ずれた区間があれば、その時刻で
 * もう一度聞きます。ふつうは2回で収まります。
 *
 * @returns {{trimmed:object, travelFn:Function, legDetail:Function,
 *            route:object}|null} 取れなければ null（そのままにします）
 */
async function measureFinalOrder(trimmed, ctx, trip, ctxIn) {
  const { stays, outbound } = ctxIn;
  if (!(trimmed.result?.visits ?? []).length) return null;

  let current = trimmed;
  let best = null;
  let lastShift = Infinity;
  // 組み直しの回ごとに外れた場所。最後の回の dropped だけを見ると、
  // 1回目で外れた場所が消えます（2回目は、外れたあとの並びから始まるため）。
  const lostSoFar = [];

  for (let round = 0; round < MEASURE_ROUNDS; round++) {
    const visits = current.result?.visits ?? [];
    if (!visits.length) break;
    const { points, times, kinds } = chainOf(visits, ctx, trip, stays);
    const usable = points.filter(Boolean);
    if (usable.length !== points.length || usable.length < 2) break;

    // 乗るものが区間で変わる旅（電車＋現地の車）は、分けて聞きます。
    // ほかの旅では、これまでどおりひと続きで1回です。
    const groups = modeGroups(points, times, kinds, trip.transport);
    const merged = [];
    const parts = [];
    let failed = false;
    for (const g of groups) {
      try {
        const part = await routeChain(g.points, {
          mode: g.mode, departAt: g.times[0], departTimes: g.times,
          signal: ctxIn.signal,
          // **選ばれた乗り物を、そのまま下まで渡します。**
          //
          // ここで落ちていたので、時刻表への問い合わせは画面の選択と
          // 無関係に「全部の乗り物・速い順」でした。「フェリーで」を
          // 選んでも陸の経路が返り、「飛行機で」を選んでも
          // 33時間の新幹線＋船が返っていました。
          //
          // 区間ごとに乗るものが変わる旅（電車＋現地の車）では、
          // 車の区間は Yahoo!に聞かないので、渡しても使われません。
          transport: g.mode === "DRIVE" ? "car" : trip.transport,
        });
        if (!part?.legs?.length) { failed = true; break; }
        // どの手段で調べた区間なのかを、区間そのものに書いておきます。
        // 画面（絵・言葉）と .ics の説明が、これを見て変わります。
        for (const leg of part.legs) leg.mode = g.mode;
        merged.push([g.points, part.legs]);
        parts.push(part);
      } catch {
        failed = true;
        break;   // 取れなければ、いま組んである旅程のままにします
      }
    }
    if (failed || !merged.length) break;
    const allLegs = merged.flatMap(([, legs]) => legs);
    // ひと続きで聞いたときは、返ってきたものをそのまま使います
    // （どこまで引けたか・どの手段だったかを、そのまま持たせます）。
    const route = parts.length === 1
      ? { ...parts[0], legs: allLegs }
      : {
        legs: allLegs,
        routed: parts.every((x) => x.routed),
        mode: "MIXED",
        modeNote: "遠出は電車・バス、現地は車で調べています",
        error: parts.find((x) => x.error)?.error,
      };
    const nextTravel = legLookupAll(merged);
    const nextDetail = legDetailLookup(merged);

    // 実際の時刻で、もう一度組み直します。
    //
    // 1日目の起点も引き直します。往路が「4:00発で、乗れるのは6:28の便、
    // 8:49着」なら、その日は8:49から始まります。目安のままだと、
    // 着く前に見学が始まる旅程になります。
    const measuredOut = ctxIn.nightOut ?? route.legs[0] ?? outbound;
    const startAt = arrivalAfter(trip.departAt, measuredOut);
    const again = trimKeepingPicks(visits.map((v) => v.spot),
                                   { ...ctx, startAt, travelFn: nextTravel },
                                   ctxIn.fillerIds);
    const settled = again.result?.visits?.length ? again : current;
    if (settled === again) {
      // 穴埋めは数えません。あとから足した場所です。
      lostSoFar.push(...(again.dropped ?? [])
        .filter((s) => !ctxIn.fillerIds?.has(s.id)));
    }

    best = {
      trimmed: settled,
      dropped: [...lostSoFar],
      travelFn: nextTravel, legDetail: nextDetail, route,
      outbound: measuredOut,
    };

    // 組み直した結果、各区間を通る時刻はどこまで動いたか。
    const after = settled.result?.visits?.length
      ? chainOf(settled.result.visits, ctx, trip, stays).times
      : times;
    const shift = worstShift(times, after);
    if (shift < SHIFT_TOLERANCE_MIN) break;
    // 縮まらないなら、これ以上聞いても同じです（便に合わせて動いた時刻が、
    // また別の便を呼ぶ、という行ったり来たりを止めます）。
    if (shift >= lastShift) break;
    lastShift = shift;
    current = settled;
  }
  return best;
}

/**
 * 長い一本道を、経路APIの上限に合わせて切りながら引きます。
 *
 * 公共交通（Yahoo!路線情報）は区間ごとに聞くので、何地点あっても構い
 * ません。車と徒歩（Googleの経路API）は1回12地点までで、超えると
 * まるごと推定に落ちます。旅程は20地点を超えるので、そのままでは
 * **車の旅がいつも推定**になります。つなぎ目を重ねて切ります。
 */
async function routeChain(points, opts) {
  if (opts.mode === "TRANSIT" || points.length <= MAX_POINTS) {
    return computeRoute(points, opts);
  }
  const legs = [];
  const step = MAX_POINTS - 1;
  for (let i = 0; i < points.length - 1; i += step) {
    const chunk = points.slice(i, i + MAX_POINTS);
    const times = opts.departTimes?.slice(i, i + step);
    const part = await computeRoute(chunk, {
      ...opts, departTimes: times, departAt: times?.[0] ?? opts.departAt,
    });
    legs.push(...part.legs);
  }
  return { legs, routed: legs.every((l) => l.routed), mode: opts.mode };
}

/**
 * 採点のためだけに、旅程をいったん組み立てます。
 *
 * buildItinerary は外に触らない純粋な処理なので、案を比べるために
 * 何度呼んでも費用はかかりません。点を出すには時刻の入った旅程が
 * 要るので、比べる前に一度組みます。
 */
function draftItinerary(checked, trip, kb) {
  try {
    return buildItinerary({
      trip, kb,
      region: kb.regionsById.get(checked.stays?.[0]?.region?.id),
      stays: checked.stays, visits: checked.result.visits,
      meals: checked.result.meals, moves: checked.result.moves,
      reasons: new Map(), legs: checked.legs,
    });
  } catch {
    // 組めない案は、比べる土俵に乗りません
    return { days: [] };
  }
}

/**
 * 滞在時間を、押されたぶんだけ差し替えます。
 *
 * 収録のスポットそのものは書き換えません。同じ物を旅程1本ごとに
 * 使い回しているので、書き換えると**別の旅程にも残ります**。
 * 写しを作って、そこだけ変えます。
 */
function withDwell(spot, dwellById) {
  if (!spot) return spot;
  const min = dwellById?.[spot.id];
  if (!Number.isFinite(min)) return spot;
  return { ...spot, dwell: Math.max(10, Math.round(min)) };
}

/**
 * その希望に要る収録だけを読み込みます。
 *
 * 判断の材料は3つです。
 *   ・書かれた地名から当たるエリア（detectAreas。エリアの一覧だけで分かる）
 *   ・「必ず行く」に指定されたスポットのエリア（呼ぶ側が渡します）
 *   ・地名が1つも当たらない → 全部（絞る材料がありません）
 *
 * 名前の索引（names.json）は、**地名らしい語が書かれているときだけ**
 * 取りにいきます。「温泉でゆっくり」には地名らしい語が無いので、
 * 226KB を取る理由がありません。
 */
async function loadNeededSpots(kb, trip, opts = {}) {
  if (!kb?.staged) return;   // まとめて読んである（試験・admin・道具）

  const onProgress = opts.onProgress ?? (() => {});
  const signal = opts.signal;
  const prog = (done, total, label) => {
    if (total > 1) onProgress(1, label);
  };

  const areas = opts.ignoreAreas ? []
    : detectAreas(trip.note, kb, { originCity: originCity(trip.origin) });
  const scope = areaScope(areas);
  const wanted = new Set(scope.regionIds ?? []);
  // 「必ず行く」のエリアは、地名が書かれていなくても要ります。
  for (const id of opts.mustRegionIds ?? []) wanted.add(id);

  if (!wanted.size) {
    await ensureAllSpots(kb, { onProgress: prog, signal });
    return;
  }
  await ensureRegions(kb, wanted, { onProgress: prog, signal });

  // 指定された「必ず行く」が、読んだぶんに入っていなければ、
  // どの段にいるのか分かりません。そのときは全部読みます。
  // **黙って落とす**のがいちばん悪い結果です（押した場所が消えます）。
  if ((trip.must?.spotIds ?? []).some((id) => !kb.spotsById.has(id))) {
    await ensureAllSpots(kb, { onProgress: prog, signal });
    return;
  }

  // 名前の索引は、**最後の手段**です。
  //
  // 「収録に無い土地」と判定した語があるときだけ取りにいきます。
  // 読んだ県の中に見つかるなら、索引は要りません（226KB あります）。
  // 「出雲と松江。神社と海」の「神社」は語尾が地名らしいので候補に
  // 挙がりますが、島根のスポットの中に見つかるので、取りません。
  if (placeCandidates(trip.note).length
      && unknownPlaceTerms(trip.note, kb).length) {
    await ensureNames(kb, signal);
  }
}

/**
 * 候補のエリアを、地方ごとに散らして選びます。
 *
 * 点の高い順に10件取ると、たいてい同じ地方の10件になります（点の高い
 * エリアは近くに固まります）。「日本全国」と書いた人に瀬戸内の10エリアを
 * 見せても、選べるのは瀬戸内の旅だけです。
 *
 * まず各地方のいちばん良いエリアを点の順に1つずつ取り、残りを点の順に
 * 足します。散らす指定が無いときは、これまでどおり上から取るだけです。
 *
 * avoidRegionIds は、ほかの案ですでに使った地方を外すためのものです
 * （3案が同じ地方に固まらないように）。外すと足りなくなるときは外しません。
 */
export function spreadCandidates(ranked, limit, groupById,
                                 { avoidRegionIds = [], keepRegionIds = new Set(),
                                   need = 1 } = {}) {
  if (!groupById) return ranked.slice(0, limit);
  const groupOf = (c) => groupById.get(c.region.id) ?? c.region.id;
  const usedGroups = new Set(avoidRegionIds
    .map((id) => groupById.get(id)).filter(Boolean));
  const keep = (c) => keepRegionIds.has?.(c.region.id);
  const fresh = ranked.filter((c) => keep(c) || !usedGroups.has(groupOf(c)));
  const freshGroups = new Set(fresh.map(groupOf));
  // 別の地方だけで足りるなら、使った地方は見せません。足りないときは
  // 全部から選びます（何も出せないよりよいので）。
  const pool = fresh.length && freshGroups.size >= Math.max(1, need)
    ? fresh : ranked;

  const out = [];
  const seen = new Set();
  for (const c of pool) {
    if (out.length >= limit) break;
    if (seen.has(groupOf(c)) && !keep(c)) continue;
    seen.add(groupOf(c));
    out.push(c);
  }
  for (const c of pool) {
    if (out.length >= limit) break;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * 候補集合を、スポットの平らな配列にします。
 *
 * 差し替え案も代わりの案も、**旅程を作ったときに見ていた候補**から
 * しか取りません。ここで知識ベース全体を引くと、旅程と関係のない
 * 土地の名前が出てきます。
 */
function candidatePool(candidates) {
  return (candidates ?? []).flatMap((c) => (c?.spots ?? []).map((x) => x.spot))
    .filter(Boolean);
}

/**
 * 天気・日没・混雑から、見直しの提案を作ります。
 *
 * 天気は取れないことがあります（オフライン、予報の効かない先の日付）。
 * 取れなくても旅程は成立するので、失敗はそのまま「分かりません」として
 * 画面に出すだけにします。
 */
async function buildReplan(itin, candidates, opts = {}) {
  if (opts.useWeather === false) return { suggestions: [], notes: [] };

  const getForecast = opts.forecast ?? forecastFor;
  const weather = {};
  const sunset = {};
  const daySummaries = [];

  for (const [di, day] of (itin.days ?? []).entries()) {
    const first = (day.items ?? []).find((i) => i.kind === "spot" && i.place);
    const at = first?.place;
    if (!at) continue;

    // 日没は計算で出ます（通信も課金もありません）
    const t = sunTimes(day.date, at.lat, at.lng);
    if (t.sunset) sunset[di] = t.sunset;

    try {
      const f = await getForecast(at, day.date, { signal: opts.signal });
      weather[di] = f;
      if (f.ok) daySummaries.push(`${di + 1}日目: ${summarizeDay(f)}`);
    } catch {
      // 天気が取れないことは、旅程の失敗ではありません
    }
  }

  // 差し替え候補は、選定に使った候補集合から取ります。
  // ここに無い場所を持ち出すと、旅程と関係のない土地が混ざります。
  const pool = candidatePool(candidates);
  const out = suggestReplan(itin, { weather, sunset, candidates: pool });
  out.days = daySummaries;

  // 予報が出ない先の旅には、その時期の「ふつう」を出します。
  //
  // 「出発が48日先のため、天気予報はまだ出ていません」は正しいのですが、
  // これだけでは持ち物も決められません。**予報ではなく、過去の観測の
  // 平均**を出します（js/normals.js）。1回だけ、最初の日の場所で聞きます
  // （同じ旅の中で日ごとに聞いても、平年値はほとんど同じです）。
  const firstDay = (itin.days ?? [])[0];
  const firstAt = (firstDay?.items ?? [])
    .find((i) => i.kind === "spot" && i.place)?.place;
  if (firstAt && firstDay?.date) {
    try {
      const n = await (opts.normals ?? normalsFor)(
        firstAt, new Date(firstDay.date), { signal: opts.signal });
      if (n?.ok) out.normals = { text: n.text, ...n.value };
    } catch {
      // 取れないのは、旅程の失敗ではありません。
    }
  }
  return out;
}

function buildVerifyNote(checked, repaired, proposal) {
  const parts = [];
  if (proposal.fromModel) {
    const m = resolvedModel();
    parts.push(m ? `${m} が案を作成` : "AIが案を作成");
  } else {
    parts.push("検索結果から案を作成");
  }
  const dropped = checked.dropped?.length ?? 0;
  if (dropped) {
    parts.push(repaired ? `時間が合わない${dropped}件を差し替え`
                        : `時間が合わない${dropped}件を除外`);
  } else if (checked.result.ok) {
    parts.push("全スポットが時間内に収まることを確認");
  } else {
    parts.push("時間の制約が厳しく、立ち寄りを絞り込み");
  }
  parts.push(checked.legs.local?.routed
    ? "移動時間はGoogleマップの経路検索"
    : "移動時間は距離からの推定");
  const u = checked.result.underfilled;
  if (u) {
    parts.push(`${u.totalDays}日のうち${u.plannedDays}日ぶんしか予定を埋められず`
      + "（収録スポットが足りません）");
  } else if (checked.result.slackMin > 0) {
    const m = checked.result.slackMin;
    parts.push(m >= 120
      ? `終点まで約${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}の余裕`
      : `終点まで約${m}分の余裕`);
  }
  if (checked.stays?.length > 1) {
    parts.push(`${checked.stays.map((s) => `${s.region.name}${s.days}日`).join("→")}`
      + "で拠点を移動");
  }
  return parts.join("、") + "。";
}


/**
 * 旅程を組めなかったときのエラー。
 * 「できません」だけでなく「どうすればできます」を持ち歩きます。
 */
export class PlanError extends Error {
  constructor(message, suggestions = []) {
    super(message);
    this.name = "PlanError";
    this.suggestions = suggestions;
  }
}

/** 出典の重複を落とします（同じ記事が何度も返ることがあります）。 */
/** その日数を埋めるのに要る、おおよその立ち寄り件数。 */
/**
 * AIに聞けなかったときの注意書き。
 *
 * 聞けなくても旅程は出ます（収録から機械的に選びます）。画面からは
 * 成功に見えるので、黙っていると「AIの意見が入っていない気がする」と
 * いう形でしか気づけません。理由まで出します。
 */
/**
 * 予算を超えたときの注意書き。
 *
 * 超えたぶんを黙って削りません。何を削るか（入場料の高い場所か、宿か、
 * 特急か）は好みの問題で、こちらが決めると「行きたかった場所が消えた」に
 * なります。超えていることと、内訳のいちばん大きいところを伝えます。
 */
/**
 * 予算を超えたぶん、入場料の高い場所から外していきます（strict のとき）。
 *
 * 「2万円まで」を選んだ人は、2万円以内の旅程が出ると思っています。
 * それでも、何を削るかは好みの問題です。だから**入場料**から削ります
 * （宿や特急は、削ると旅そのものが変わります）。外した場所は名前を
 * 残すので、「それは残したい」と言い直せます。
 *
 * @returns {string[]} 外した場所の名前
 */
export function overBudgetSpots(itin, cap) {
  const total = itin?.cost?.total ?? itin?.totalCostYen ?? 0;
  if (!(cap > 0) || !(total > cap)) return [];
  const spots = (itin.days ?? []).flatMap((d) => d.items ?? [])
    .filter((i) => i.kind === "spot" && (i.costYen ?? 0) > 0)
    .sort((a, b) => (b.costYen ?? 0) - (a.costYen ?? 0));
  const out = [];
  let over = total - cap;
  for (const s of spots) {
    if (over <= 0) break;
    out.push(s);
    over -= s.costYen ?? 0;
  }
  return out;
}

/**
 * 電車・バスの時刻の出どころ。
 *
 * Yahoo!路線情報の検索結果を読んで組み立てています。公式の乗換案内では
 * ないので、ダイヤの改正や臨時の運休は反映されないことがあります。
 * 現地で乗り遅れるのは利用者なので、出どころは書いておきます。
 */
function transitSourceNote(itin) {
  const routed = (itin?.days ?? []).flatMap((d) => d.items ?? [])
    .some((i) => i.kind === "transit" && i.routed && i.yahoo);
  if (!routed) return [];
  return ["電車・バスの時刻はYahoo!路線情報の検索結果です。"
    + "出発前に、公式の乗換案内でもう一度お確かめください。"];
}

function budgetNotes(itin, trip) {
  const cap = trip?.budgetYen;
  const total = itin?.cost?.total ?? itin?.totalCostYen;
  if (!(cap > 0) || !(total > cap)) return [];
  const rows = itin?.cost?.rows ?? [];
  const worst = rows.reduce((a, b) => ((a?.yen ?? 0) >= b.yen ? a : b), null);
  return [`概算 ¥${total.toLocaleString()} で、決めた上限`
    + ` ¥${cap.toLocaleString()} を ¥${(total - cap).toLocaleString()} 超えています`
    + (worst ? `（いちばん大きいのは${worst.label} ¥${worst.yen.toLocaleString()}）` : "")
    + "。日数を減らすか、上限を上げてください。"];
}

/**
 * どれだけの中から選んだのか。
 *
 * 収録は30,000件ありますが、旅程に出るのは十数件です。読む側からは
 * 「たまたま出た数件」と区別がつきません（実際、収録を倍にしたあとも
 * 同じ場所が出て「本当に増えているのか」と言われました）。**その旅で
 * 実際に検討した件数**を出します。旅程の中身ではなく、選び方の話です。
 */
function poolNote(kb, candidates) {
  const pool = new Set();
  for (const c of candidates ?? []) {
    for (const s of c.spots ?? []) pool.add(s.spot?.id ?? s.id);
  }
  if (!pool.size) return [];
  const total = kb?.spots?.length ?? 0;
  return [`収録${total.toLocaleString("ja-JP")}件のうち、`
    + `${pool.size.toLocaleString("ja-JP")}件を候補として見ています。`];
}

/**
 * 出発が早すぎるときの助言。
 *
 * 「朝は何時から」を4:00にすると、着いた先で何もできない時間が生まれます。
 * 神社や公園は「いつでも入れる」ので、以前はそこへ午前4時に立ち寄る
 * 旅程が出ていました。いまは7:00まで見学を置きませんが、**そのぶん
 * 待つ**ことに変わりはありません。黙って待たせるのではなく、
 * 何時に出れば無駄がないかを言います。
 */
function earlyStartNote(itin, trip) {
  const idle = itin?.morningIdleMin ?? 0;
  if (idle < 60) return [];
  const h = Math.floor(idle / 60);
  const m = idle % 60;
  const len = m ? `${h}時間${m}分` : `${h}時間`;
  const better = new Date(trip.departAt.getTime() + idle * 60000);
  const hhmm = `${better.getHours()}:`
    + String(better.getMinutes()).padStart(2, "0");
  return [`出発が早いため、最初の見学まで${len}あります。`
    + `${hhmm}ごろの出発にすると、待たずに回れます。`];
}

function aiNotes() {
  const { error } = aiStatus();
  if (!error) return [];
  return ["AIに聞けなかったため、収録データから機械的に選びました"
    + `（${error}）。行き先は選べていますが、希望文の読み取りと並べ方は`
    + "簡易なものです。"];
}

export function spotsNeededFor(days) {
  return Math.max(3, days * 4);
}

/**
 * 指定エリアだけでは日数を埋められないとき、近いエリアを足します。
 *
 * 箱根の収録は11件です。「箱根で」と書いて3泊4日にすると、4日で11か所
 * （1日2〜3か所）にしかなりません。実際に行く人も、その場合は小田原や
 * 熱海まで足を延ばします。指定を無視するのではなく、**足りないぶんだけ**
 * 隣を足します。足りているときは何もしません。
 *
 * 近さは、指定エリアの中心からの直線距離で見ます。遠いエリアを足すと
 * 「箱根と言ったのに京都が入る」ことになるので、上限を置きます。
 *
 * @param {{regionIds:Set<string>}} scope その場で書き換えます
 * @param {number} days
 * @returns {string[]} 足したエリア名
 */
export function widenScopeForDays(scope, kb, days, maxKm = 60) {
  if (!scope.regionIds?.size) return [];
  const need = spotsNeededFor(days);
  const have = [...scope.regionIds]
    .reduce((n, id) => n + (kb.spotsByRegion.get(id)?.length ?? 0), 0);
  if (have >= need) return [];

  const anchors = [...scope.regionIds]
    .map((id) => kb.regionsById.get(id)).filter(Boolean);
  if (!anchors.length) return [];

  const near = [];
  for (const r of kb.regions) {
    if (scope.regionIds.has(r.id)) continue;
    const km = Math.min(...anchors.map((a) => haversineKm(a, r)));
    if (km <= maxKm) near.push({ region: r, km });
  }
  near.sort((a, b) => a.km - b.km);

  const added = [];
  let total = have;
  for (const { region } of near) {
    if (total >= need) break;
    scope.regionIds.add(region.id);
    total += kb.spotsByRegion.get(region.id)?.length ?? 0;
    added.push(region.name);
  }
  return added;
}

function dedupeSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out.slice(0, 8);
}
