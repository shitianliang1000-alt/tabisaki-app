#!/usr/bin/env node
// 自前モデルに学ばせる「事実ではないこと」のデータセットを作ります（Issue #433）。
//
//   node tools/build_datasets.mjs            training/datasets/ に4つの JSONL を書く
//   node tools/build_datasets.mjs --check    書かずに、いまのファイルと形・件数を確かめる（CI）
//
// できるもの（どれも1行 = {"messages":[…], "meta":{dataset, task, id, split, …}}）
//   tabisaki_wisdom.jsonl        旅の知恵（混む時期・雨の日・山の天気・マナー・ペース…）。手で書いた seeds/wisdom.jsonl から
//   tabisaki_react.jsonl         道具を使う考えの流れ（ReAct）。行動は手本として決め、結果は本物の道具（tools.js）で取る
//   tabisaki_meta.jsonl          収録に無い・決めきれない・無理な要望への対応（最重要）。seeds/meta.jsonl と、収録から作る型
//   tabisaki_instructions.jsonl  上の3つと、収録から自動で作る指示（エリアの紹介・営業時間・料金…）から選んだ 500件
//
// 学習用と確かめ用は、行ごとの meta.split（"train" / "eval"）で分けます。同じ元（同じ seed・同じスポット・
// 同じエリア）から作った行は、必ず同じ側に入ります（言い換えで答えを覚えたのを、確かめで当てないように）。
//
// 守ること
// - 収録から作る行は、学習に使ってよい出典（export_training_data.mjs の DEFAULT_GROUPS）のスポットだけを使います。
//   ReAct の道具も、その範囲に絞った収録の上で動かします（結果に出る場所も、その範囲だけになります）
// - OpenStreetMap 由来の osmInfo（ODbL）は使いません
// - 天気・乗り換えの道具は、外に問い合わせない設定（off）で動かします。何度走らせても同じ中身になります
// - 事実を作りません。答えに書く場所の名前・数字は、収録か道具の結果にあるものだけです

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  clock, DEFAULT_GROUPS, isEval, licenseOf, loadKb, unit, verifyLevel,
} from "./export_training_data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "training", "datasets");
export const EVAL_RATE = 0.1;
export const INSTRUCTIONS = 500;
export const DATASETS = ["tabisaki_wisdom", "tabisaki_react", "tabisaki_meta", "tabisaki_instructions"];

const readJsonl = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const msg = (...pairs) => pairs.flatMap(([u, a]) => [{ role: "user", content: u }, { role: "assistant", content: a }]);
/** 同じ元の行は同じ側へ。スポットの行は、学習データの書き出し（spot_fact）と同じ分け方にします（確かめ用のスポットの事実が、学習に漏れないように）。 */
export const splitOf = (key) => {
  if (key.startsWith("spot:")) return isEval(key.slice(5)) ? "eval" : "train";
  return unit(`ds-split:${key}`) < EVAL_RATE ? "eval" : "train";
};
const pick = (key, list) => list[Math.floor(unit(key) * list.length)];
const row = (dataset, task, id, group, messages, extra = {}) =>
  ({ messages, meta: { dataset, task, id, split: splitOf(group), ...extra } });

// --- 旅の知恵 ------------------------------------------------------------------

export function wisdomRows(seeds) {
  return seeds.flatMap((s) => s.q.map((q, i) =>
    row("tabisaki_wisdom", "wisdom", `${s.id}#${i}`, `wisdom:${s.id}`, msg([q, s.a]), { tags: s.tags, source: "project" })));
}

// --- 未知の要望（手で書いたもの） ----------------------------------------------

export function metaSeedRows(seeds) {
  const out = [];
  for (const s of seeds) {
    const base = { kind: s.kind, source: "project" };
    out.push(row("tabisaki_meta", "meta", s.id, `meta:${s.id}`, msg(...s.turns), base));
    s.variants.forEach((v, i) => {
      out.push(row("tabisaki_meta", "meta", `${s.id}~${i}`, `meta:${s.id}`, msg([v, s.turns[0][1]], ...s.turns.slice(1)), base));
    });
  }
  return out;
}

// --- 収録の絞り込み -------------------------------------------------------------

/** 学習に使ってよい出典のスポットだけ。facts は裏取りの済んだものだけ（事実を答える行に使う）。 */
export function licensedKb(kb, groups = DEFAULT_GROUPS) {
  const allowed = new Set(groups);
  const ok = kb.spots.filter((s) => allowed.has(licenseOf(s).group));
  const facts = ok.filter((s) => verifyLevel(kb.verify.get(s.id)?.status) === "verified");
  return { ok, facts };
}

const haversineKm = (a, b) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// --- 未知の要望（収録から作るもの） ---------------------------------------------

// 海外の行き先と、近い雰囲気の国内の行き先の種類（場所の名前は出しません）
const OVERSEAS = [
  ["ハワイ", "南の島の海", ["沖縄の海辺", "離島", "暖かい地方の海沿いの温泉"]],
  ["グアム", "南の島の海", ["沖縄の海辺", "離島"]],
  ["パリ", "芸術と街歩き", ["美術館の多い街", "古い町並み", "おしゃれな港町"]],
  ["ロンドン", "歴史ある街並み", ["城下町", "レンガ造りの建物が残る港町", "博物館の多い街"]],
  ["ソウル", "食べ歩き", ["屋台や市場のある街", "中華街", "名物料理の街"]],
  ["台湾", "食べ歩きと夜市", ["中華街", "屋台のある街", "温泉街"]],
  ["バンコク", "寺院めぐり", ["古い寺の多い街", "仏像を見られる寺"]],
  ["スイス", "山と湖", ["高原のリゾート", "山の湖", "ロープウェイで上がる展望の場所"]],
  ["イタリア", "古い街と食", ["古い町並み", "港町", "ワインの産地"]],
  ["ニューヨーク", "大都会の夜景", ["都会の展望台", "港の夜景", "美術館の多い街"]],
  ["バリ島", "リゾートと寺院", ["沖縄の海辺", "古い寺の多い街"]],
  ["カナダ", "大自然と紅葉", ["紅葉の名所の渓谷", "高原", "湖のまわりの自然"]],
];
const OVERSEAS_ASK = [(p) => `${p}旅行の計画を立てて。`, (p) => `${p}に行きたい。`, (p) => `${p}で3日間遊びたい。`];

const FAKE_TAILS = ["ほしぞら岬", "七色の滝", "月見ヶ原高原", "竜神洞窟", "虹の大橋公園", "風見城跡", "白鷺の湯", "天空の棚田"];
const FAKE_ASK = [(n) => `「${n}」に行きたい。`, (n) => `「${n}」ってどんなところ？`, (n) => `${n}への行き方を教えて。`];

// 開く・閉まるのない場所（山・滝・海辺・公園など）には、営業時間を聞く問いを作りません
const NO_HOURS_CATEGORY = /ダム|山|岳|峠|滝|海|浜|岬|湖|川|渓|島|公園|自然|高原|峡|橋|道/;

export function metaKbRows(kb, lic) {
  const out = [];
  const regions = [...kb.regions.values()].filter((r) => r.name && Number.isFinite(r.lat));
  const names = new Set(kb.spots.map((s) => s.name));

  // 1) 海外（範囲の外）
  OVERSEAS.forEach(([place, mood, alts], i) => {
    OVERSEAS_ASK.forEach((ask, j) => {
      if (unit(`ov:${place}:${j}`) > 0.67) return;
      const a = `ごめんなさい、旅さきは日本の国内だけを扱っているので、${place}の旅程は組めません。`
        + `${mood}が目当てなら、国内では次のような行き先があります。\n${alts.map((x) => `・${x}`).join("\n")}\n`
        + "気になるものがあれば、出発地と日数を教えてください。収録から探して組みます。";
      out.push(row("tabisaki_meta", "meta_overseas", `ov:${i}:${j}`, `ov:${place}`, msg([ask(place), a]), { kind: "範囲の外（海外）", source: "generated" }));
    });
  });

  // 2) 収録に無い名前（エリアの名前＋ありそうな名前）
  for (const r of regions) {
    if (unit(`fk:${r.id}`) > 0.05) continue;
    const n = `${r.name}${pick(`fkt:${r.id}`, FAKE_TAILS)}`;
    if (names.has(n)) continue;
    const ask = pick(`fka:${r.id}`, FAKE_ASK)(n);
    const a = `「${n}」は、旅さきの収録には見つかりませんでした。確かめられない場所を、あるものとして案内することはしません。\n`
      + "・正しい名前や漢字が分かれば教えてください\n"
      + `・${r.name}（${r.prefecture}）のあたりで、似た種類の場所を探すこともできます`;
    out.push(row("tabisaki_meta", "meta_unknown_name", `fk:${r.id}`, `fk:${r.id}`, msg([ask, a]), { kind: "収録に無い名前", source: "generated", regionId: r.id }));
  }

  // 3) 遠すぎる日帰り（エリアの代表点どうしの直線距離が 800km 以上）
  const far = [];
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i], b = regions[j];
      if (a.prefecture === b.prefecture) continue;
      const km = haversineKm(a, b);
      if (km >= 800 && unit(`far:${a.id}:${b.id}`) < 0.0025) far.push({ a, b, km });
    }
  }
  for (const { a, b, km } of far.slice(0, 40)) {
    const ask = `日帰りで${a.name}と${b.name}の両方を観光したい。`;
    const ans = `${a.name}（${a.prefecture}）と${b.name}（${b.prefecture}）は、直線でもおよそ${Math.round(km / 10) * 10}kmあり、`
      + "移動だけで1日のほとんどを使ってしまうので、日帰りで両方を観光するのは難しいです。\n"
      + `・${a.name}だけにしぼる\n・${b.name}だけにしぼる\n・両方を回るなら、2泊以上にして間に移動の日を入れる\nどれがよいですか。`;
    out.push(row("tabisaki_meta", "meta_impossible", `far:${a.id}:${b.id}`, `far:${a.id}:${b.id}`, msg([ask, ans]), { kind: "無理な条件", source: "generated", km: Math.round(km) }));
  }

  // 4) 収録に無い情報（営業時間・料金が載っていないスポット）
  for (const s of lic.ok) {
    if (unit(`gap:${s.id}`) > 0.004 || NO_HOURS_CATEGORY.test(s.category ?? "")) continue;
    const noHours = !Number.isFinite(s.open) || !Number.isFinite(s.close);
    const noFee = !Number.isFinite(s.fee);
    if (!noHours && !noFee) continue;
    const [ask, what] = noHours
      ? [`${s.name}は何時まで開いてる？`, "営業時間"]
      : [`${s.name}の入場料はいくら？`, "料金"];
    const a = `旅さきの収録には、${s.name}（${s.prefecture}）の${what}が載っていません。作って答えることはしないので、`
      + `施設の公式の案内か電話で確かめてください。${noHours ? "旅程では、閉まる時刻が分からない場所は、夕方より前に回るようにしています。" : ""}`;
    out.push(row("tabisaki_meta", "meta_kb_gap", `gap:${s.id}`, `spot:${s.id}`, msg([ask, a]), { kind: "収録に無い情報", source: "generated", spotIds: [s.id], licenses: [licenseOf(s).license] }));
  }
  return out;
}

// --- 収録から作る指示 -----------------------------------------------------------

const CAT_ASK = [(r, c) => `${r}の${c}を教えて。`, (r, c) => `${r}で行ける${c}は？`];

export function kbInstructionRows(kb, lic) {
  const out = [];
  // 1) エリアの紹介（regions.json の紹介文は旅さきで書いたもの）
  for (const r of kb.regions.values()) {
    if (!r.name || !r.description) continue;
    const ask = pick(`ri:${r.id}`, [`${r.name}ってどんなところ？`, `${r.name}の魅力を教えて。`, `${r.name}に行くと何が楽しめる？`]);
    const a = `${r.name}（${r.prefecture}）は、${r.tagline ? `ひとことで言うと「${r.tagline}」。` : ""}${r.description}`
      + (r.station ? `最寄りの駅の目安は${r.station}です。` : "");
    out.push(row("tabisaki_kb", "kb_region", `ri:${r.id}`, `region:${r.id}`, msg([ask, a]), { source: "project", regionId: r.id }));
  }
  // 2) スポットの見どころ（旅さきで書いた説明文だけ。Wikipedia 由来は使わない）
  for (const s of lic.facts) {
    if (licenseOf(s).group !== "project" || !s.description) continue;
    const a = `${s.name}は、${s.prefecture}の${s.region ? `「${s.region}」エリアにある` : ""}${s.category ?? "観光地"}です。${s.description}`;
    out.push(row("tabisaki_kb", "kb_spot", `sd:${s.id}`, `spot:${s.id}`, msg([`${s.name}の見どころは？`, a]), { source: "project", spotIds: [s.id], licenses: [licenseOf(s).license] }));
  }
  // 3) 営業時間・料金（収録にある値だけ）
  for (const s of lic.facts) {
    if (Number.isFinite(s.open) && Number.isFinite(s.close) && !(s.open === 0 && s.close === 24) && unit(`hr:${s.id}`) < 0.5) {
      const a = `${s.name}の開いている時間の目安は${clock(s.open)}〜${clock(s.close)}です。季節や曜日で変わることがあるので、出かける前に公式の案内で確かめてください。`;
      out.push(row("tabisaki_kb", "kb_hours", `hr:${s.id}`, `spot:${s.id}`, msg([`${s.name}は何時から何時まで開いてる？`, a]), { source: licenseOf(s).source, spotIds: [s.id], licenses: [licenseOf(s).license] }));
    }
    if (Number.isFinite(s.fee) && unit(`fe:${s.id}`) < 0.5) {
      const a = s.fee === 0
        ? `${s.name}は、入るのにお金はかからない（目安）と収録にあります。変わることがあるので、公式の案内で確かめてください。`
        : `${s.name}の入場料の目安は${s.fee}円です。年齢や時期で変わることがあるので、公式の案内で確かめてください。`;
      out.push(row("tabisaki_kb", "kb_fee", `fe:${s.id}`, `spot:${s.id}`, msg([`${s.name}の入場料は？`, a]), { source: licenseOf(s).source, spotIds: [s.id], licenses: [licenseOf(s).license] }));
    }
  }
  // 4) エリア×種類の一覧（3件以上あるものだけ。有名な順に6件まで）
  const TIER = { major: 0, known: 1, local: 2 };
  const groups = new Map();
  for (const s of lic.facts) {
    // 確かめ用のスポット（spot_fact の評価に回るもの）は、一覧にも入れません
    if (!s.regionId || !s.category || isEval(s.id)) continue;
    const k = `${s.regionId}|${s.category}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  for (const [k, list] of groups) {
    const [rid, cat] = k.split("|");
    const region = kb.regions.get(rid);
    if (!region?.name || list.length < 3 || unit(`rc:${k}`) > 0.6) continue;
    const top = [...list].sort((a, b) => (TIER[a.fame_tier] ?? 3) - (TIER[b.fame_tier] ?? 3) || a.id.localeCompare(b.id)).slice(0, 6);
    const a = `旅さきの収録にある、${region.name}（${region.prefecture}）の${cat}です。\n${top.map((s) => `・${s.name}`).join("\n")}\n営業時間や行き方は、出かける前に確かめてください。`;
    out.push(row("tabisaki_kb", "kb_category", `rc:${k}`, `region:${rid}`, msg([pick(`rca:${k}`, CAT_ASK)(region.name, cat), a]), { source: "kb", regionId: rid, spotIds: top.map((s) => s.id), licenses: [...new Set(top.map((s) => licenseOf(s).license))] }));
  }
  return out;
}

// --- ReAct（道具を使う考えの流れ） ---------------------------------------------

/** 道具の結果を、次の一手を決めるのに要る分だけにします。 */
export function observation(tool, res) {
  if (!res.ok) return { ok: false, error: res.error };
  const d = res.data ?? {};
  if (tool === "search_spots") {
    return { ok: true, total: d.total, spots: (d.spots ?? []).slice(0, 5).map((s) => ({ id: s.id, name: s.name, prefecture: s.prefecture, region: s.region, category: s.category })) };
  }
  if (tool === "calculate_route") return { ok: true, order: (d.order ?? []).map((s) => ({ id: s.id, name: s.name })), totalMinutes: d.totalMinutes, totalKm: d.totalKm };
  if (tool === "search_special_journey" && d.journey) return { ok: true, found: true, journey: { ...d.journey, along: (d.journey.along ?? []).slice(0, 20) }, special: d.special };
  if (tool === "search_historical_route" && d.along) return { ok: true, ...d, along: d.along.slice(0, 20) };
  return { ok: true, ...d };
}

const THEMES = [
  ["温泉", "温泉に入りたい"], ["城", "お城を見たい"], ["神社", "神社をめぐりたい"], ["寺", "お寺をめぐりたい"],
  ["美術館", "美術館に行きたい"], ["博物館", "博物館で学びたい"], ["公園", "公園を散歩したい"], ["滝", "滝を見に行きたい"],
  ["展望台", "景色のいい展望台に行きたい"], ["水族館", "水族館に行きたい"], ["庭園", "日本庭園をながめたい"], ["海", "海を見に行きたい"],
];
const SPECIAL_WISHES = ["最長片道切符で旅したい", "日本一周をしたい", "青春18きっぷで旅したい", "寝台列車に乗る旅がしたい",
  "世界遺産を全部回りたい", "秘境駅をめぐりたい", "県庁所在地をぜんぶ回りたい", "日本の東西南北の端に行きたい",
  "廃線跡をたどる旅がしたい", "船旅がしたい", "日本縦断の旅に出たい", "最長往復切符で旅したい"];
const HISTORICAL_WISHES = [["東海道五十三次を歩いてたどりたい", "東海道五十三次"], ["中山道の宿場町をめぐりたい", "中山道"],
  ["国道1号線を走りたい", "国道1号"], ["国道58号を走りたい", "国道58号"], ["旧東海道を歩きたい", "東海道"]];
const OVERSEAS_REACT = [["ハワイみたいな海に行きたい。ハワイ旅行の計画を立てて。", "ハワイ", ["沖縄", "海"]],
  ["パリで美術館めぐりがしたい。", "パリ", ["美術館"]], ["台湾で温泉に入りたい。", "台湾", ["温泉"]],
  ["スイスみたいな山と湖を見たい。スイスに行く計画を。", "スイス", ["湖", "高原"]]];

/** 1つの場面を道具で動かし、会話の形にします。steps は (obs) => 次の一手 を返す関数の並び。 */
async function runScenario({ registry, names, toolCallBody, wish, plan }) {
  const head = toolCallBody({ wish, registry, names, mode: "schema" }).messages;
  const messages = [...head];
  const used = [];
  let last = null;
  for (const step of plan.steps) {
    const act = step(last, used);
    if (!act) break;
    if (act.final) {
      messages.push({ role: "assistant", content: JSON.stringify({ thought: act.thought, final: true }) });
      break;
    }
    messages.push({ role: "assistant", content: JSON.stringify({ thought: act.thought, tool: act.tool, args: act.args }) });
    const res = await registry.call(act.tool, act.args);
    last = { tool: act.tool, args: act.args, obs: observation(act.tool, res) };
    used.push(last);
    messages.push({ role: "user", content: `結果: ${JSON.stringify(last.obs)}\n\n次の一手を、同じ形の JSON だけで答えてください。` });
    if (act.tool === "ask_user") {
      messages.push({ role: "assistant", content: JSON.stringify({ thought: "利用者の答えを待つ", final: true }) });
      break;
    }
  }
  const answer = plan.answer(used);
  if (!answer) return null;
  messages.push({ role: "user", content: "利用者への答えを、道具の結果にあることだけで書いてください。" }, { role: "assistant", content: answer });
  return { messages, tools: used.map((u) => u.tool) };
}

const names5 = (spots) => spots.map((s, i) => `${i + 1}. ${s.name}（${s.category || "観光地"}）`).join("\n");

export async function reactRows(kb, lic, { createDefaultTools, toolCallBody, useProvider }) {
  useProvider("routing", "off");
  useProvider("weather", "off");
  const okIds = new Set(lic.ok.map((s) => s.id));
  const filtered = { ...kb.core, spots: kb.core.spots.filter((s) => okIds.has(s.id)) };
  const plain = createDefaultTools({ kb: filtered });
  const withSearch = createDefaultTools({ kb: filtered, search: async () => [] });
  const out = [];
  const push = async (id, group, type, wish, plan, registry = plain) => {
    const names = registry.available();
    const r = await runScenario({ registry, names, toolCallBody, wish, plan });
    if (r) out.push(row("tabisaki_react", `react_${type}`, id, group, r.messages, { source: "tools", tools: r.tools }));
  };

  // 1) エリア×テーマ: 探す → 回る順 → 答える
  const regions = [...kb.regions.values()].filter((r) => r.name && r.prefecture);
  for (const r of regions) {
    if (unit(`rt:${r.id}`) > 0.15) continue;
    const [kw, wishTail] = pick(`rtt:${r.id}`, THEMES);
    const wish = `${r.name}で${wishTail}。`;
    let inRegion = [];
    await push(`rt:${r.id}`, `region:${r.id}`, "region_theme", wish, {
      steps: [
        () => ({ thought: `「${r.name}」の「${kw}」を、${r.prefecture}にしぼって収録から探す`, tool: "search_spots", args: { keywords: [r.name, kw], prefecture: r.prefecture, limit: 10 } }),
        (last) => {
          inRegion = (last.obs.spots ?? []).filter((s) => s.region === r.name);
          if (inRegion.length >= 2) return { thought: `${r.name}の中に${inRegion.length}か所あったので、回る順を決める`, tool: "calculate_route", args: { spotIds: inRegion.slice(0, 4).map((s) => s.id) } };
          if (inRegion.length === 1) return { thought: `${r.name}の中は1か所だけなので、それを答える`, final: true };
          return { thought: `${r.name}の中には見つからなかった。どうしたいかを利用者に聞く`, tool: "ask_user", args: { question: `${r.name}の中には「${kw}」が収録に見つかりませんでした。${r.prefecture}のほかの場所でもよいですか。`, choices: [`${r.prefecture}のほかの場所でよい`, "別のテーマにする"] } };
        },
        (last) => (last?.tool === "calculate_route" ? { thought: "回る順と移動の目安が出たので答える", final: true } : null),
      ],
      answer: (used) => {
        const route = used.find((u) => u.tool === "calculate_route")?.obs;
        if (route?.ok) {
          return `${r.name}で${kw}なら、収録にある次の${route.order.length}か所を、移動の短い順に回るのがおすすめです。\n${names5(route.order.map((o) => inRegion.find((s) => s.id === o.id) ?? o))}\n`
            + `場所どうしの移動は、あわせて約${route.totalMinutes}分（距離からの目安）です。営業時間と行き方は、出かける前に確かめてください。`;
        }
        if (inRegion.length === 1) return `${r.name}で${kw}なら、収録にあるのは「${inRegion[0].name}」です。1か所だけなので、まわりの別の種類の場所と組み合わせることもできます。営業時間は出かける前に確かめてください。`;
        return `${r.name}の中には、「${kw}」に当たる場所が収録に見つかりませんでした。${r.prefecture}のほかの場所でもよいか、別のテーマにするかを教えてください。`;
      },
    });
  }

  // 2) 名のある旅・特殊な旅
  for (const [i, wish] of SPECIAL_WISHES.entries()) {
    await push(`sp:${i}`, `sp:${i}`, "special", wish, {
      steps: [
        () => ({ thought: "名のある旅のしかたかを確かめる", tool: "search_special_journey", args: { text: wish } }),
        (last) => ({ thought: last.obs.found ? "旅の形が分かったので答える" : "専用の組みかたには無かったので、くわしく聞く", final: true }),
      ],
      answer: (used) => {
        const o = used[0]?.obs;
        if (!o?.ok || !o.found) return "その旅の形は、旅さきの専用の組みかたには見つかりませんでした。どんな旅にしたいかを、もう少しくわしく教えてください。";
        const name = o.journey?.name ?? o.special?.name;
        const meaning = o.journey?.meaning ? `${o.journey.meaning}です。` : "";
        const along = o.journey?.along?.length ? `通るところは、${o.journey.along.slice(0, 8).join("・")}${o.journey.along.length > 8 ? "…" : ""}です。` : "";
        return `「${name}」の旅として、専用の組みかたで組みます。${meaning}${along}出発地と、使える日数を教えてください。乗る便や料金は、出かける前に確かめてください。`;
      },
    });
  }

  // 3) 旧街道・国道
  for (const [i, [wish, name]] of HISTORICAL_WISHES.entries()) {
    await push(`hr:${i}`, `hr:${i}`, "historical", wish, {
      steps: [
        () => ({ thought: "旧街道・国道の沿う町を調べる", tool: "search_historical_route", args: { name } }),
        (last) => ({ thought: last.obs.found ? "沿う町が分かったので答える" : "収録に無かったので、収録にある街道を伝える", final: true }),
      ],
      answer: (used) => {
        const o = used[0]?.obs;
        if (!o?.ok || !o.found) return `「${name}」は、旅さきの収録にある街道・国道には見つかりませんでした。収録にあるのは${(o?.known ?? []).join("・")}です。`;
        return `「${o.name}」は、${o.meaning}をたどる道です。収録では、${o.along.join("・")}を通ります。全部を一度に回ると長いので、何日かに分けて区切るのがおすすめです。何日で、どこからどこまで行きたいですか。`;
      },
    });
  }

  // 4) 収録に無い名前（ネットで調べられないとき・調べても無いとき）
  const fakeRegions = regions.filter((r) => unit(`rf:${r.id}`) < 0.03);
  for (const r of fakeRegions) {
    const n = `${r.name}${pick(`rft:${r.id}`, FAKE_TAILS)}`;
    const online = unit(`rfo:${r.id}`) < 0.5;
    const wish = `「${n}」に行ってみたい。`;
    await push(`uk:${r.id}`, `fk:${r.id}`, online ? "unknown_web" : "unknown", wish, {
      steps: [
        () => ({ thought: `「${n}」が収録にあるか探す`, tool: "search_spots", args: { keywords: [n], limit: 5 } }),
        (last) => (last.obs.total
          ? { thought: "似た名前が出たが、同じ場所かは分からないので、利用者に聞く", tool: "ask_user", args: { question: `「${n}」は収録にそのままの名前ではありませんでした。正しい名前か、近くの駅を教えてください。` } }
          : online
            ? { thought: "収録に無いので、ネットで1回だけ調べる", tool: "web_search", args: { query: `${n} 場所` } }
            : { thought: "収録に無く、ネットで調べる道具も無いので、利用者に聞く", tool: "ask_user", args: { question: `「${n}」の都道府県か、近くの駅の名前を教えてください。` } }),
        (last) => (last?.tool === "web_search"
          ? { thought: "調べても出てこなかった。作らずに、利用者に聞く", tool: "ask_user", args: { question: `「${n}」は調べても見つかりませんでした。正しい名前か、近くの駅を教えてください。` } }
          : null),
      ],
      answer: (used) => {
        const web = used.some((u) => u.tool === "web_search");
        return `「${n}」は、旅さきの収録${web ? "にも、ネットで調べた結果にも" : "には"}見つかりませんでした。確かめられない場所を、あるものとして案内することはしません。`
          + "正しい名前か、都道府県・近くの駅の名前が分かれば、そこから組み直します。";
      },
    }, online ? withSearch : plain);
  }

  // 5) 海外 → 範囲の外。似た雰囲気を国内の収録から
  for (const [i, [wish, place, kws]] of OVERSEAS_REACT.entries()) {
    await push(`ov:${i}`, `ov:${place}`, "overseas", wish, {
      steps: [
        () => ({ thought: `${place}は日本の外なので組めない。似た雰囲気の国内の場所を探す`, tool: "search_spots", args: { keywords: kws, limit: 5 } }),
        () => ({ thought: "国内の代わりの候補が出たので答える", final: true }),
      ],
      answer: (used) => {
        const spots = used[0]?.obs?.spots ?? [];
        const alt = spots.length ? `似た雰囲気の国内の場所なら、収録に次のような所があります。\n${spots.slice(0, 3).map((s) => `・${s.name}（${s.prefecture}）`).join("\n")}\n` : "";
        return `ごめんなさい、旅さきは日本の国内だけを扱っているので、${place}の旅程は組めません。${alt}気になる場所があれば、出発地と日数を教えてください。`;
      },
    });
  }

  // 6) 天気を調べる道具が無いとき（雨に備えて屋内を中心に）
  for (const r of regions) {
    if (unit(`rw:${r.id}`) > 0.08) continue;
    const wish = `明日${r.name}に行きます。雨なら屋内の場所にして。`;
    await push(`rw:${r.id}`, `region:${r.id}`, "no_weather", wish, {
      steps: [
        () => ({ thought: "天気を調べる道具が使えないので、雨でも困らない屋内の場所を探す", tool: "search_spots", args: { keywords: [r.name, "美術館", "博物館"], prefecture: r.prefecture, limit: 10 } }),
        () => ({ thought: "屋内の候補が出たので答える", final: true }),
      ],
      answer: (used) => {
        const spots = (used[0]?.obs?.spots ?? []).filter((s) => s.region === r.name).slice(0, 4);
        // 屋内の場所が1つも無いエリアは、少しだけ残します（「無い」と正直に言う手本）
        if (!spots.length && unit(`rwk:${r.id}`) > 0.25) return null;
        const list = spots.length ? `雨でも困らないよう、屋内の場所を中心にします。収録にある${r.name}の候補です。\n${spots.map((s) => `・${s.name}（${s.category || "観光地"}）`).join("\n")}\n` : `${r.name}の中には、屋内の場所が収録に見つかりませんでした。`;
        return `いま天気を調べる手段が使えないので、明日の天気は確かめられませんでした。${list}出かける前に、天気予報を確かめてください。`;
      },
    });
  }

  // 7) 2か所のあいだの時間（乗り換え検索を使えないので、距離からの目安）
  const pool = lic.facts.filter((s) => s.prefecture && Number.isFinite(s.lat) && unit(`tp:${s.id}`) < 0.08);
  let pairs = 0;
  for (let i = 0; i + 1 < pool.length && pairs < 24; i += 2) {
    const a = pool[i];
    const b = pool.slice(i + 1).find((x) => x.prefecture === a.prefecture && x.name !== a.name && haversineKm(a, x) >= 5 && haversineKm(a, x) <= 60);
    if (!b) continue;
    pairs++;
    const wish = `${a.name}から${b.name}まで、どれくらいかかる？`;
    await push(`tr:${a.id}:${b.id}`, `spot:${a.id}`, "transit", wish, {
      steps: [
        () => ({ thought: "2か所のあいだの公共交通の時間を調べる", tool: "search_transit", args: { from: { name: a.name }, to: { name: b.name } } }),
        () => ({ thought: "時間が出たので答える。目安なので、そう書く", final: true }),
      ],
      answer: (used) => {
        const o = used[0]?.obs;
        if (!o?.ok) return `${a.name}か${b.name}の場所が分からず、時間を調べられませんでした。`;
        return o.estimated
          ? `${a.name}から${b.name}までは、距離からの目安で約${o.minutes}分です。実際の電車やバスの時刻では、待ち時間でもっとかかることがあるので、乗る便は乗り換え案内で確かめてください。`
          : `${a.name}から${b.name}までは、約${o.minutes}分です（${o.summary}）。`;
      },
    });
  }
  return out;
}

// --- 500件を選ぶ ----------------------------------------------------------------

/** 種類ごとに順番に1件ずつ取る（偏らないように）。 */
function roundRobin(rows, n, key) {
  const by = new Map();
  for (const r of [...rows].sort((a, b) => unit(`pk:${a.meta.id}`) - unit(`pk:${b.meta.id}`))) {
    const k = key(r);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const lists = [...by.values()];
  const out = [];
  while (out.length < n && lists.some((l) => l.length)) for (const l of lists) if (l.length && out.length < n) out.push(l.shift());
  return out;
}

export function chooseInstructions({ wisdom, react, meta, kbRows }, total = INSTRUCTIONS) {
  const seedMeta = meta.filter((r) => r.meta.source === "project");
  const genMeta = meta.filter((r) => r.meta.source !== "project");
  const take = [
    ...wisdom,
    ...seedMeta,
    ...roundRobin(genMeta, Math.max(0, 170 - seedMeta.length), (r) => r.meta.task),
    ...roundRobin(react, 110, (r) => r.meta.task),
  ];
  take.push(...roundRobin(kbRows, Math.max(0, total - take.length), (r) => r.meta.task));
  return take.slice(0, total).map((r) => ({ ...r, meta: { ...r.meta, from: r.meta.dataset, dataset: "tabisaki_instructions" } }));
}

// --- 本体 -----------------------------------------------------------------------

export async function buildAll() {
  const kb = loadKb();
  const { createCore } = await import(pathToFileURL(path.join(ROOT, "packages", "core", "index.mjs")).href);
  const core = await createCore();
  kb.core = core.kb;
  const lic = licensedKb(kb);
  const { createDefaultTools } = await import(pathToFileURL(path.join(ROOT, "packages", "core", "src", "tools.js")).href);
  const { toolCallBody } = await import(pathToFileURL(path.join(ROOT, "packages", "core", "src", "guided.js")).href);
  const { useProvider } = await import(pathToFileURL(path.join(ROOT, "packages", "core", "src", "providers.js")).href);
  const wisdom = wisdomRows(readJsonl(path.join(DIR, "seeds", "wisdom.jsonl")));
  const meta = [...metaSeedRows(readJsonl(path.join(DIR, "seeds", "meta.jsonl"))), ...metaKbRows(kb, lic)];
  const react = await reactRows(kb, lic, { createDefaultTools, toolCallBody, useProvider });
  const kbRows = kbInstructionRows(kb, lic);
  const instructions = chooseInstructions({ wisdom, react, meta, kbRows });
  return { tabisaki_wisdom: wisdom, tabisaki_react: react, tabisaki_meta: meta, tabisaki_instructions: instructions, kbRows, kbHash: kb.kbHash };
}

/** 形の点検（CI でも使います）。問題のリストを返します。 */
export function checkRows(name, rows) {
  const errs = [];
  const ids = new Set();
  for (const [i, r] of rows.entries()) {
    const where = `${name}:${i + 1}`;
    const m = r.messages;
    if (!Array.isArray(m) || m.length < 2) { errs.push(`${where} messages がありません`); continue; }
    if (m.at(-1).role !== "assistant") errs.push(`${where} 最後が答えではありません`);
    if (m.some((x) => !["system", "user", "assistant"].includes(x.role) || typeof x.content !== "string" || !x.content.trim())) errs.push(`${where} 空の発言か、知らない役`);
    if (!["train", "eval"].includes(r.meta?.split)) errs.push(`${where} split がありません`);
    if (ids.has(r.meta?.id)) errs.push(`${where} id が重なっています: ${r.meta?.id}`);
    ids.add(r.meta?.id);
    if (name === "tabisaki_react") {
      for (const x of m.filter((x) => x.role === "assistant").slice(0, -1)) {
        try { const a = JSON.parse(x.content); if (!a.final && !a.tool) errs.push(`${where} 一手の形が違います`); } catch { errs.push(`${where} 一手が JSON ではありません`); }
      }
    }
  }
  if (name === "tabisaki_instructions" && rows.length !== INSTRUCTIONS) errs.push(`${name} は ${INSTRUCTIONS}件のはずが ${rows.length}件`);
  return errs;
}

const toJsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--check")) {
    let bad = 0;
    for (const name of DATASETS) {
      const rows = readJsonl(path.join(DIR, `${name}.jsonl`));
      const errs = checkRows(name, rows);
      const ev = rows.filter((r) => r.meta.split === "eval").length;
      console.log(`${name}: ${rows.length}件（学習 ${rows.length - ev}・確かめ ${ev}）${errs.length ? ` 問題 ${errs.length}` : ""}`);
      for (const e of errs.slice(0, 10)) console.error(`  ${e}`);
      bad += errs.length;
    }
    process.exit(bad ? 1 : 0);
  }
  const all = await buildAll();
  for (const name of DATASETS) {
    writeFileSync(path.join(DIR, `${name}.jsonl`), toJsonl(all[name]));
    const ev = all[name].filter((r) => r.meta.split === "eval").length;
    const byTask = all[name].reduce((m, r) => ({ ...m, [r.meta.task]: (m[r.meta.task] ?? 0) + 1 }), {});
    console.log(`${name}: ${all[name].length}件（学習 ${all[name].length - ev}・確かめ ${ev}）`, JSON.stringify(byTask));
  }
  console.log(`収録から作る指示（全体）: ${all.kbRows.length}件。うち ${all.tabisaki_instructions.filter((r) => r.meta.from === "tabisaki_kb").length}件を 500件に入れました`);
}
