# 設定（データの取り方・AI）

旅さきは CUI（`tabisaki`）と携帯アプリ（`mobile/`。Capacitor）に絞ります。どちらも同じ設定を持ちます
（中身の決まりは `packages/core/src/app-settings.js`）。

| どこで | 変えかた | 置き場 |
| --- | --- | --- |
| CUI | `tabisaki settings …` | `~/.tabisaki/settings.json`（`TABISAKI_HOME` で変えられます） |
| アプリ | 旅の一覧の下の「設定」 | その端末の localStorage（`tabisaki.app-settings`） |

鍵はどちらにも置きません。AI Studio・自前のモデルの入口の鍵は、いままでどおり中継（Cloudflare Worker）の secret です。

## データの取り方

| 値 | 中身 | 既定 |
| --- | --- | --- |
| `api` | 乗り換え・天気・地図は公式の API、スポットは収録データ（出典つき）だけを使う | **既定** |
| `scrape` | 上に加えて、スポットの公式サイトなどの公開ページを**利用者の端末から**直接読む | 非推奨・自己責任 |

```sh
tabisaki settings                       # いまの設定
tabisaki settings data-source scrape    # 注意書きを出し、y で有効（端末でないときは --yes が要る）
tabisaki settings data-source api       # 戻す（同意の記録も消えます）
```

### スクレイピングの決まり（`packages/core/src/scrape.js`）

* 有効にする前に注意書き（`SCRAPE_CONSENT_TEXT`）を必ず見せ、同意した版と日時を残します。注意書きを
  書き換えたら `SCRAPE_CONSENT_VERSION` を上げます。古い版の同意は効かず、`api` に戻ります。
* 読むのは利用者の端末です。中継からは読みません。
  * CUI: `tabisaki plan` の後に、旅程の場所の公式サイト（収録の `url`、無ければ OpenStreetMap の `website`）を読み、
    旅程の下に「公式サイトから読んだこと（未確認・自己責任）」として分けて付けます（`--output=json` なら `scraped`）。
  * アプリ: スポットの「この場所のくわしいこと」に「公式サイトから営業時間を読む（未確認）」が出ます。押したときだけ読みます。
    読むのは Capacitor の CapacitorHttp で、全体の fetch は差し替えません（中継への頼みは、いままでどおり）。
    ブラウザでは相手に断られる（CORS）うえ、サイト版はやめるので、ブラウザの設定画面では選べません。
* robots.txt で断られたパスは読みません（robots.txt が 401/403 なら、そのサイトは読みません）。
* 同じホストへは 3 秒あけ、1回に読むのは 8 ページまで。1ページ 1MB・10 秒で打ち切ります。
* `User-Agent` は `tabisaki-scraper/1 (+リポジトリの URL)`。ブラウザのふりはしません。
* localhost・社内向けのアドレス・http(s) 以外・ID 入りの URL は読みません。
* 拾うのはページが機械向けに書いた schema.org の JSON-LD（`openingHours`・`openingHoursSpecification`・
  `telephone`・`address`）だけです。画面の文を推し量って読むことはしません。
* 読んだことは収録のデータに書き戻しません。

## AI

| 値 | 中身 |
| --- | --- |
| `own`（既定） | 持ち主が学習した Gemma 4。アプリは中継経由（`OWN_MODEL_URL`）、CUI は手元の Ollama など（`--local`・`--hybrid`） |
| `studio` | Google AI Studio の Gemma 4（中継に置いた鍵で呼ぶ。予備） |

```sh
tabisaki settings ai own --model=tabisaki-gemma --base=gemma-4-26b-a4b
tabisaki settings ai studio
```

### 自前のモデルの名前と大きさについての読み

持ち主の言葉は「Gemma 4 E26B だか（確か MoE のため）」でした。Gemma 4 に「E26B」という版はありません
（E2B・E4B は端末向けの小さい版です）。26B で MoE なのは **Gemma 4 26B A4B**（全体 26B・1語あたり動くのは約 4B）
なので、そう読んで既定にしました。

* 既定の名前 `tabisaki-gemma` は `training/pipeline.sh` の `NAME` と同じです。26B A4B で学習するときは
  `BASE=unsloth/gemma-4-26B-A4B-it` を付けます（docs/training.md）。
* 違っていたら、名前は `--model`、元の大きさは `--base`（アプリは「設定」の欄）で差し替えるだけです。
  中継側の名前は `OWN_MODEL_NAME` で変えます。

### どこで効くか

* **アプリ**: 中継へ頼むとき、本文に `aiSource`（`own`/`studio`）と `ownModel`（名前）を添えます。
  中継（`server/own-model.js` の `pickSource`）が投げ先を決め、どちらの上流にもこの2つは渡しません。
  * `own` で `OWN_MODEL_URL` があれば自前のモデルへ。答えなければ AI Studio へ（`OWN_MODEL_FALLBACK=off` で止められます）
  * `studio` なら自前のモデルを飛ばして AI Studio だけ
  * 画面から名指しされた名前は、中継の `OWN_MODEL_NAME` か `OWN_MODEL_NAMES`（カンマ区切り）にあるものだけ使います。
    無い名前なら `OWN_MODEL_NAME` を使います（入口に入っている別のモデルを、外から勝手に呼ばせないため）
* **CUI**: `--local`・`--hybrid` のモデルは、`--model=` → 設定の自前のモデル → （自前のモデルがまだ入っていなければ）
  配布の `gemma4:e2b` の順に決まります。落としたときは、そう書きます。
