# スポットに情報を足す（別名・営業時間・季節・写真・エリア）

収録（`kb/`）に無い情報を、**値ごとに出典と確認の状態を付けて**手元に足します。
足した情報は手元のファイルにだけ入り、公式の `kb/` にも Git にも入りません。

```sh
./tabisaki spot hours set 雲場池 9:00-17:00 --closed=水 --last-entry=16:30 --source=公式サイト --url=https://…
./tabisaki spot enrich 雲場池          # Wikidata・Commons から別名と写真（未確認で入る）
./tabisaki spot show 雲場池            # 収録の値と足した値を、出典・確認日と並べる
./tabisaki spot verify 雲場池          # 人が確かめた印を付ける
```

## Features

* **出典と取った日**を、値ごとに必ず持ちます（出典名・URL・ライセンス・取った日）
* **自動で取った値・AI の値は「未確認」**で入り、人が `spot verify` するまで旅程の計算に使いません
* **鮮度**を出します。確認から日がたった値には「古いかもしれません」と出します（営業時間は180日、季節は1年、別名・写真は3年）
* 確認済みの営業時間・定休日・休業期間は、`tabisaki plan`・`tui`・手元の API の旅程にそのまま効きます
* 写真は**ライセンスと撮った人が無いと入りません**。外の写真は URL で指すだけで、ファイルは保存しません
* エリアを自分で決められます（中心と半径、またはスポットの並び）

## コマンド

| コマンド | すること |
|---|---|
| `spot show <スポット>` | 収録の値と足した値を、出典・確認の状態・鮮度と並べて出す（`--output=json` も） |
| `spot alias add\|rm <スポット> <別名>` | 別名を足す・消す。足した別名でも `spot show` などで探せます |
| `spot hours set <スポット> <9:00-17:00\|24h> --source=…` | 営業時間。`--closed=月,火`（定休日）・`--last-entry=16:30`・`--closed-season=12-29..01-03` |
| `spot hours rm <スポット>` | 足した営業時間を消す（収録の値に戻ります） |
| `spot seasonal add <スポット> <催し> --from=MM-DD --to=MM-DD --source=…` | 季節の催し（桜・紅葉・ライトアップなど）。`--note=…` |
| `spot photo add <スポット> (--url=… \| --file=…) --license=… --author=…` | 写真。`--file` は手元の写真を `photos/` に写して指します |
| `spot enrich <スポット> [--dry-run]` | Wikidata の日本語の別名と、Commons の代表写真を補う（未確認） |
| `spot verify <スポット> [aliases\|hours\|seasonal\|photos\|all]` | 人が確かめた印（確認日）を付ける |
| `spot generate <エリア> [--count=5]` | AI に見どころの候補を出させる（未確認。旅程には使いません） |
| `spot candidates` | AI の候補の一覧と、収録にあるかどうか |
| `spot check` | ファイルの形・収録との食いちがい・古い値・未確認の数を確かめる（まちがいがあれば終了コード 1） |
| `area define <id> --name=… (--center=緯度,経度 --radius=km \| --spots=…)` | エリアを決める |
| `area ls [--custom-only]` | エリアの一覧（`*` が自分で決めたもの） |
| `area rm <id>` | 自分で決めたエリアを消す |

`<スポット>` は名前・別名・元の名前・id のどれでも書けます。同じ名前がいくつもあるときは、候補の id を出して止まるので、id で選び直します。

終了コードは `0` = できた、`1` = できなかった（通信・ファイル・`spot check` のまちがい）、`2` = 使いかたのまちがい です。

## 置き場

| | 場所 |
|---|---|
| 足した情報 | `$TABISAKI_HOME/spots.json`（無ければ `~/.tabisaki/spots.json`） |
| 手元の写真 | `$TABISAKI_HOME/photos/` |

- 書く前に形を確かめ、別名で書いてから入れ替えます（途中で止まっても前のファイルが残ります）
- 旅程に重ねたくないときは `TABISAKI_NO_USER_DATA=1` を付けます
- [ユーザーKB](./user-kb.md)（`kbs/<名前>/overlay.json`）は、スポットそのものを足す・直す・消すためのものです。
  ここ（`spots.json`）は、収録にあるスポットに**出典つきの情報を足す**ためのもので、ユーザーKBの上に重なります

## ファイルの形（version 1）

```json
{
  "version": 1,
  "spots": {
    "karuizawa-2": {
      "aliases": [ { "value": "白鳥湖", "origin": "wikidata", "status": "unverified",
                     "source": { "name": "Wikidata", "url": "https://www.wikidata.org/wiki/Q…", "license": "CC0 1.0", "retrievedAt": "2026-10-27" } } ],
      "hours": { "value": { "open": 9, "close": 17, "lastEntry": 16.5, "closedDays": [3], "closedSeasons": ["12-29..01-03"] },
                 "origin": "manual", "status": "verified", "checkedAt": "2026-10-27",
                 "source": { "name": "公式サイト", "url": "https://…", "retrievedAt": "2026-10-27" } },
      "seasonal": [ { "value": { "name": "紅葉", "from": "10-20", "to": "11-10" }, "…": "…" } ],
      "photos": [ { "value": { "url": "https://upload.wikimedia.org/…", "page": "https://commons.wikimedia.org/wiki/File:…", "author": "…" },
                    "source": { "name": "Wikimedia Commons", "license": "CC BY-SA 4.0", "retrievedAt": "2026-10-27" }, "…": "…" } ]
    }
  },
  "areas": {
    "my-pond": { "name": "軽井沢の池", "center": { "lat": 36.35, "lng": 138.63 }, "radiusKm": 3, "createdAt": "2026-10-27" }
  },
  "candidates": [ { "value": { "name": "…", "category": "…", "why": "…", "area": "軽井沢" }, "origin": "llm", "status": "unverified", "…": "…" } ]
}
```

どの値も同じ封筒（`value`・`origin`・`status`・`source`・`checkedAt`）に入ります。

| 項目 | 決まり |
|---|---|
| `origin` | `manual`（手で入れた）・`wikipedia`・`wikidata`・`commons`・`llm`（AI） |
| `status` | `manual` は `verified` で入り、それ以外は `unverified` で入ります。自動の値を `verified` にするには `checkedAt` が要ります |
| `source.name`・`source.retrievedAt` | 必ず要ります（出典と取った日） |
| `source.license` | 写真では必ず要ります |
| `hours.value` | `packages/core/src/hours.js` の `spot.hours` と同じ形（時は 16.5 = 16:30。`closedDays` は 0 = 日曜 … 6 = 土曜） |
| `candidates` | AI の候補は `verified` にできません。収録に足すのは、人が確かめて手で行います |

形の決まりは `packages/core/spotinfo.mjs` の `validateStore` にあり、`spot check` と書き込みのたびに確かめます。

## 外のデータとライセンス

| 取り口 | 取るもの | 条件 |
|---|---|---|
| Wikidata | 日本語の別名・代表写真のファイル名（P18） | CC0 1.0 |
| Wikimedia Commons | 写真の URL・作者・ライセンス | 写真ごと（CC BY-SA など）。表示するときは作者とライセンスを添えます |
| AI（`spot generate`） | 候補の名前・種類・理由 | 出典なし。実在するかは確かめていません |

- Yahoo! JAPAN のデータ・API は使いません（[data-licenses.md](./data-licenses.md)）
- 営業時間と季節の催しは、自由に使える信頼できる取り口が無いので、**公式を見て手で入れます**
- `spot enrich` と `spot generate` だけが外へ通信します。ほかのコマンドは通信しません

## AI の候補（spot generate）

OpenAI 互換の `/v1/chat/completions` を持つもの（Ollama・LM Studio など）に聞きます。

```sh
export TABISAKI_LLM_URL=http://127.0.0.1:11434
export TABISAKI_LLM_MODEL=gemma3
./tabisaki spot generate 軽井沢 --count=5
```

外のサービスを使うときは `TABISAKI_LLM_KEY` に鍵を入れます（ファイルやリポジトリには書きません）。
