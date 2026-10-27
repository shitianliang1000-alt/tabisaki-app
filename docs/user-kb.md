# 自分の知識ベース（ユーザーKB）

公式の収録（`kb/`）には手を入れずに、自分でスポットを足したり、説明や料金を直したり、行きたくない場所を外したりする仕組みです。

```sh
./tabisaki plan "高尾山で景色" --kb=mine     # ~/.tabisaki/kbs/mine/ の差分を重ねて組む
```

足す・直すコマンド（`tabisaki spot add` など）は Issue #355 で入ります。ここに書くのは、その下にある**データの形と決まり**です。コードは [`packages/core/userkb.mjs`](../packages/core/userkb.mjs)、試験は [`tests/userkb.test.js`](../tests/userkb.test.js) です。

## 考えかた

| | 公式の収録（`kb/`） | ユーザーKB |
|---|---|---|
| 置き場 | リポジトリの `kb/` | `~/.tabisaki/kbs/<名前>/overlay.json` |
| 書く人 | 収録を作り直す道具（`tools/`）だけ | 利用者 |
| 旅さきからは | **読むだけ** | 読む・書く |
| 中身 | スポットの全部 | 公式との**差分**だけ |

旅程を組むときは、公式の収録を読んでから、ユーザーKBの差分を上から重ねます（オーバーレイ）。重ねた結果はメモリの中にだけあり、`kb/` にもユーザーKBにも書き戻しません。

公式の収録が新しくなっても、差分はそのまま残ります。全部を写して持つと、公式の直しが届かなくなるためです。

## 識別子

| もの | 形 | 例 |
|---|---|---|
| 公式のスポット | 収録の id（`:` を含みません） | `takao-1`・`n0063-12` |
| 足したスポット | `u:` ＋ 時刻（36進）＋ 乱数8字 | `u:mh8k2x1c9f3a7b20` |
| ユーザーKB | 英小文字・数字・`-`・`_` で40字まで（先頭は英数字） | `mine`・`family-2026` |

足したスポットの id は `u:` で始まるので、公式の id とぶつかりません。時刻と乱数でできているので、別の端末で作ったものどうしもぶつかりません（#358 の統合で使います）。

## overlay.json の形

```json
{
  "schema": "tabisaki.user-kb/1",
  "name": "mine",
  "title": "自分の旅",
  "base": { "kind": "official", "stamp": "/1371/54101" },
  "created": "2026-10-27T04:40:00.000Z",
  "updated": "2026-10-27T05:12:00.000Z",
  "spots": {
    "u:mh8k2x1c9f3a7b20": {
      "op": "add",
      "spot": { "name": "裏高尾の湧き水", "lat": 35.64, "lng": 139.25, "genres": ["nature"], "dwell": 20 },
      "at": "2026-10-27T04:41:00.000Z"
    },
    "takao-1": {
      "op": "patch",
      "set": { "description": "朝いちばんが静か", "fee": 300 },
      "unset": [],
      "was": { "description": "山腹に開かれた修験の寺。…", "fee": 0 },
      "anchor": { "name": "高尾山薬王院", "lat": 35.6256, "lng": 139.2472 },
      "at": "2026-10-27T04:50:00.000Z"
    },
    "takao-2": {
      "op": "remove",
      "reason": "混みすぎる",
      "anchor": { "name": "高尾山山頂", "lat": 35.6252, "lng": 139.2434 },
      "at": "2026-10-27T05:12:00.000Z"
    }
  }
}
```

差分は**スポットの id ごとに1件**です。同じスポットを何度直しても1件にまとまるので、並び順で結果が変わることがありません。

| op | 意味 | 持つもの |
|---|---|---|
| `add` | スポットを足す（id は `u:` で始まる） | `spot`（中身の全部） |
| `patch` | 公式のスポットを直す | `set`（変える項目）・`unset`（外す項目）・`was`（直す前の公式の値）・`anchor` |
| `remove` | 消す。**印を付けるだけ**で、ファイルからは消しません | `reason`・`anchor`（足したスポットなら `spot` も） |

`remove` を取り消すと、消す前（`add` や `patch`）に戻ります。足したスポットを直すときは、`add` の中身をそのまま書き換えます。

### 書ける項目

| 項目 | 形 | 決まり |
|---|---|---|
| `name` | 文字 | **必須**。120字まで |
| `lat`・`lng` | 数 | **必須**。−90〜90・−180〜180 |
| `category` | 文字 | 40字まで（寺院・展望台…） |
| `genres` | 一覧 | `nature` `history` `view` `food` `art` `city` `sea` `onsen` から8個まで |
| `regionId` | 文字 | 収録のエリアの id。書かなければ、いちばん近いエリアに入ります |
| `description` | 文字 | 2,000字まで |
| `address`・`wikipedia`・`tel` | 文字 | 200・200・30字まで |
| `url` | URL | `http(s)://` だけ。利用者名・パスワード入りは断ります |
| `fame_tier` | 文字 | `major` / `known` / `hidden`（既定 `hidden`） |
| `dwell` | 整数 | 滞在の目安（分）。5〜720 |
| `open`・`close` | 数 | 時刻（8.5 = 8:30）。`close` は `open` より後 |
| `fee` | 整数 | 料金（円） |

ここに無い項目（`src`・`osm`・`geo` など、公式の収録の出どころを表すもの）は書けません。黙って捨てずに、理由を返して断ります。`name`・`lat`・`lng` は外せません（外すと旅程に置けなくなります）。

タグ・評価・メモ・行った記録（#356）、スポットどうしの関係やルート（#357）は、`spots` とは別の欄として `tabisaki.user-kb/1` に足していきます（知らない欄は読み飛ばします）。

## 公式の収録が変わったとき

重ねるたびに、次のことを調べて報告します（`createCore().overlayReport`）。報告するだけで、**ファイルは書き換えません**。直すかどうかは利用者が決めます。

| 起きたこと | 見分けかた | 扱い |
|---|---|---|
| 直した項目を、公式の側も変えた | `was` と今の公式の値が違う | **利用者の値を使い**、`conflicts` に「直す前・今の公式・利用者」の3つを出す |
| 公式の側が、利用者の値と同じになった | 今の公式の値 ＝ `set` の値 | 使い続けてよい。`redundant`（消してよい差分）に出す |
| 公式の id が変わった | id が見つからず、`anchor` の名前と300m以内で**1件だけ**当たる | 当たったスポットに重ねる。`moved` に出す |
| 公式から消えた | id も `anchor` も当たらない（2件以上当たったときも） | 重ねない。`orphans` に出し、差分はファイルに残す |
| 公式の収録の版が変わった | `base.stamp` が今の版と違う | `baseChanged` を立てる |

名前が同じかは、収録のまとめ（`js/dedupe.js` の `sameThing`）と同じ決まりで見ます。

## 移し替え・控え・戻しかた

**形の版。** `schema` を見て、古い形なら読み込むときに今の形へ直します（`migrateOverlay`）。旅さきより**新しい版で書かれたファイルは開きません**（`newer_schema`）。知らない欄を落として書き戻すと、こわしてしまうためです。

**控え。** 書くたびに、書く前の `overlay.json` を `backups/<日時>.json` に写します。30個を超えたら古いものから消します。控えから戻すときも、戻す前の中身を控えに残します。

**消すとき。** ユーザーKBを消しても、フォルダは `~/.tabisaki/trash/` へ動かすだけです。

```text
~/.tabisaki/
├── kbs/
│   └── mine/
│       ├── overlay.json
│       └── backups/
│           ├── 20261027T044100000Z.json
│           └── 20261027T051200000Z.json
└── trash/
```

まるごと持ち出すときは、このフォルダを写せば足ります（中身はただの JSON です）。差分の書き出し・取り込み（CSV・GeoJSON など）は #355、別の端末との統合は #358、git での履歴は #360 で入ります。

## 安全のための決まり

| 心配 | 決まり |
|---|---|
| 名前に `../` を入れて、置き場の外に書く | 名前は `^[a-z0-9][a-z0-9_-]{0,39}$` だけ。解決した場所が `kbs/` の直下かも確かめる |
| シンボリックリンクで、ほかのファイルを読ませる・書かせる | フォルダと `overlay.json`・控えは `lstat` で、リンクなら断る |
| 書いている途中で落ちて、半端なファイルが残る | 隣の一時ファイルに書いて `fsync` してから `rename` で差し替える |
| 2つの処理が同時に書く | `.lock` を `O_EXCL` で作る。30秒より古い鍵は落ちた処理の残りとみなす |
| ほかの利用者に読まれる | フォルダは `0700`、ファイルは `0600` |
| 大きすぎるファイル・多すぎる差分 | ファイルは20MB、差分は5万件まで |
| `__proto__` 入りの JSON | 読むときに `__proto__`・`constructor`・`prototype` の鍵を捨てる |
| 手で壊した `overlay.json` | おかしい差分だけを使わず（`invalid`）、残りは重ねる。書き戻すときは断る |
| 文字に制御文字・`javascript:` の URL | 制御文字は外す。URL は `http(s)` だけ |

置き場の根は、環境変数 `TABISAKI_HOME` で変えられます（既定は `~/.tabisaki`）。

## Node.js から

```js
import { createCore, userkb } from "./packages/core/index.mjs";

const store = userkb.openStore();
await store.create("mine", { title: "自分の旅" });

const official = await createCore();
const doc = await store.load("mine");
userkb.addSpot(doc, { name: "裏高尾の湧き水", lat: 35.64, lng: 139.25, genres: ["nature"] });
userkb.patchSpot(doc, official.kb.spotsById.get("takao-1"), "takao-1", { set: { fee: 300 } });
await store.save("mine", doc, { kb: official.kb });

const core = await createCore({ userKb: "mine" });
console.log(core.overlayReport);
```

`applyOverlay(kb, doc)` は、渡した知識ベースもその中のスポットも書き換えません。直したスポットは写しを作り、一覧と索引は作り直して返します。
