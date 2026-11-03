# 開発者向けに AI の動きを見る（tabisaki trace）

旅程ができるまでの工程を、端末で追えるようにする道具です。品質の問題が出たとき、どの工程で起きたかを早く切り分けるために使います（Issue #444）。

```bash
./tabisaki trace "京都で歴史を感じたい" --from=新大阪駅
./tabisaki trace "夏目友人帳の舞台をめぐりたい" --from=博多駅 --research \
    --search-file=examples/dev-trace/natsume-search.json
./tabisaki trace "温泉と海" --output=json > report.json   # 保存して
./tabisaki trace --input=report.json                       # あとで読み直す
```

> **利用者の画面には出しません。** Web 版（`js/`）・アプリ・公開する `dist/` からは読みません。CLI と、Node.js から `packages/core` を使う人だけのものです。`admin/` にも置きません（鍵が無く、公開しない約束のため）。`tests/devtrace.test.js` がこのことを確かめます。

## 目次

* [出すもの](#出すもの)
* [工程](#工程)
* [見立て](#見立て)
* [オプション](#オプション)
* [Node.js から使う](#nodejs-から使う)
* [まだやらないこと](#まだやらないこと)

## 出すもの

| 出し先 | 中身 |
|---|---|
| stderr（流して出す） | 起きた順に1行ずつ。Research Agent の「考え → 道具 → 結果」と、組み立ての段の進み |
| stdout（終わってから） | 工程ごとのかかった時間、Agent の記録、旅程の行ごとの根拠、裏取りの結果、見立て |

旅程の行ごとの根拠は次のとおりです。

* **立ち寄り先**: 収録（`kb/`）のスポットID（`lm-24`・`wd-Q587371` など）、分類、裏取りの結果（確認済み・結び直し）、営業時間が収録の実データか分類ごとの目安か
* **移動**: 分・km、経路を引いたか距離からの目安か、答えた取り口（`grounding.source`。Transitous〈OpenTripPlanner 系〉・駅すぱあと・Yahoo!路線情報・時刻表・目安）
* **裏取り**（[grounding.js](../packages/core/src/grounding.js)）: 確かめた数、外した場所、結び直した場所、外した列車名、書き直した AI の文

## 工程

| 工程 | どこ | 流れる合図 |
|---|---|---|
| 調べもの（Research Agent） | `research.js` | `onStep`（`--research` のときだけ） |
| 希望の読み取り | `pipeline.js` 段0 | `onProgress(0)` |
| 候補地さがし | 段1 | `onProgress(1)` |
| 旅程の案づくり | 段2 | `onProgress(2)`（候補の数） |
| 営業時間・移動の照合 | 段3 | `onProgress(3)` |
| 照合をもとにした作り直し | 段4 | `onProgress(4)`（作り直しの回数、採用した順） |
| 経路と時刻 | 段5 | `onProgress(5)` |
| 裏取り | `grounding.js` | 旅程の `grounding` |

段の番号は Web 版の進み具合の表示（`js/ui.js` の `STEPS`）と同じです。

## 見立て

旅程・Agent の記録・AI の様子から、気になる点を工程ごとに `✗`（問題）・`!`（注意）・`・`（参考）で挙げます。並びは処理の順で、**いちばん先の工程のいちばん重いもの**を「先に見る工程」として出します。

| 工程 | 見ること |
|---|---|
| 調べもの | 対応できなかった（`out_of_scope`）、道具の失敗 |
| 希望の読み取り | AI が答えられず収録データだけで組み直した、手元の LLM の確信度が低くクラウドへ回した |
| 候補地さがし | 希望に合う収録が少ない（`coverage`）、立ち寄り先が無い |
| 旅程の案づくり | 収録で確かめられない場所が案に入っていた（裏取りで外した）、AI の文に収録に無い固有名があった |
| 営業時間・移動の照合 | 営業時間の注意、目安の営業時間の数 |
| 作り直し | 時間が足りず立ち寄りを外した、作り直しの回数 |
| 経路と時刻 | 目安の区間の数、時刻表に無い列車名、帰りの余裕が15分未満 |
| 裏取り | 裏取りを通っていない旅程 |

経路の取り口を使っていない（CLI の既定）ときの目安の区間や、AI を頼んでいないときの機械的な選定は「参考」にとどめます。

## オプション

`tabisaki plan` と同じオプション（`--from`・`--days`・`--date`・`--local`・`--hybrid` など）が使えます。ほかに次のものがあります。

| オプション | すること |
|---|---|
| `--research` | 先に Research Agent を通す（収録に無い要望を調べてから組む） |
| `--search-file=<json>` | Agent のネット検索の答えを手元のファイルにする。`[{title, url, snippet}]` ならどの語でも同じ答え、`{"語": [...], "*": [...]}` なら語ごとの答え。ネットへは出ないので、問題の起きた答えをそのまま再現できます |
| `--output=text\|json` | 記録の形（既定: text） |
| `--input=<file>` | `--output=json` で保存した記録か、`{itinerary}` を持つ JSON を読み直す |

`--search-file` を付けない `--research` では、ネットで調べません（`createCore` は外へ通信しません）。

## Node.js から使う

```js
import { createCore } from "./packages/core/index.mjs";
import { createTraceRecorder, explain, formatExplain } from "./packages/core/devtrace.mjs";

const core = await createCore();
const rec = createTraceRecorder({ write: (line) => process.stderr.write(line + "\n") });
const r = await core.research({ wish: "夏目友人帳の舞台をめぐりたい", from: "博多駅" },
  { search, onStep: rec.onStep, onProgress: rec.onProgress });
rec.finish();
const report = explain(r, rec.events);   // report.diagnosis.cause が先に見る工程
process.stdout.write(formatExplain(report));
```

`core.plan(request, { onProgress })` と `core.research(request, { onStep, onProgress })`、`runResearch({ …, onStep })` は、見る側が投げても止まりません。

## まだやらないこと

* Web 版の画面に開発者向けの表示を足すこと。足すときも、通常の利用者には出さない作り（手元の開発用の build だけ、など）にします
* AI のモデルの中の考え（トークンの流れ）を流すこと。いま流しているのは、Agent の状態機械の考えと道具の結果です
