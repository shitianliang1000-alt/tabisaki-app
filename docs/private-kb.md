# 非商用データを Cloudflare の R2 に置く

国土数値情報のうち、**非商用**のデータ（P11 バス停・P12 観光資源・P27 文化施設）は、
複製物の再配布ができません（[kokudo-licenses.md](kokudo-licenses.md)）。
そこで次のように分けます（2026-11-11 持ち主の方針）。

| 置き場所 | 中身 |
|---|---|
| GitHub（このリポジトリ） | コードと**パラメータだけ**（学習済みの重み・集計値など）。元データは置きません |
| Cloudflare R2（バケット `tabisaki-private`） | 非商用の元データ。**中継（Worker）の中の判定だけ**に使います |
| 手元（`kb-private/`・`.private-kb/`） | 同じ元データ。どちらも `.gitignore` 済み。手元での学習・確かめ用 |

## 中継が外に返すもの

元データ（名前・座標・件数・距離）は返しません。返すのは **true / false だけ**です
（`server/private-kb.js`。`tests/private-kb.test.js` が、答えに元データが混ざらないことを見ます）。

| 入口 | 送るもの | 返すもの | 使いみち |
|---|---|---|---|
| `POST /stops/near` | `{lat, lng, km}` | `{available, within}` | 山のスポットで「歩ける距離にバス停があるか」。あれば、その場所の位置のまま乗り換え検索に聞きます（`packages/core/src/routes.js` の `accessFor`） |
| `POST /spots/check` | `{name, lat, lng}` | `{available, listed}` | その名前の観光資源・文化施設が 2km 以内に載っているか（名前の裏取り）。画面側の窓口は `packages/core/src/private-hint.js` の `spotListed` |

* `km` は 0.5 / 1 / 1.5 / 2 / 3 / 5 のどれかに丸めます。画面は座標を 100m 単位に丸めて送ります
* R2 がつながっていない・中身がまだ無いときは `available: false`。画面は「無い」と見て、これまでどおり進みます
* どちらも無料の枠（`free`）で数えます。外のサービスは呼びません
* `/status` の `privateKb` で、R2 がつながっているかだけ分かります

## 入れかた A: Cloudflare のサイトから（コマンドを使わない）

認証は Cloudflare のサイトにログインするだけです。リポジトリには何も書きません。

1. **上げるファイルを用意します。** プロジェクトの共有フォルダ（非公開）の `kb-private/r2-upload.zip` を落として
   展開します。中身は次の形です（`node tools/upload_private_kb.mjs --pack-only` が作る `.private-kb/` と同じ）

   ```
   manifest.json          … 目次（いちばん最後に上げます）
   bus/24_123.json …      … バス停（67件）
   spots/24_123.json …    … 観光資源・文化施設（92件）
   ```

2. <https://dash.cloudflare.com/> にログインし、左の **R2 Object Storage** を開きます
   （初めてなら、無料プランの R2 を有効にする画面が出ます。カードの登録を求められることがあります）
3. **Create bucket** を押し、名前に `tabisaki-private` と入れて作ります。場所（Location）は自動のままで構いません。
   **Public access（公開）は有効にしないでください**
4. できたバケットを開き、**Upload** から、展開した `bus` フォルダと `spots` フォルダをそのまま落とします。
   オブジェクト名が `bus/24_123.json` のように**フォルダ名付き**になっていることを確かめます
   （フォルダごと落とせないときは、先に **Create folder** で `bus` を作って開き、その中に `bus` の中身を落とします。`spots` も同じ）
5. 最後に `manifest.json` を、バケットの一番上（フォルダの外）に落とします
6. 下の「入れかた B」の 5〜6（`wrangler.jsonc` の `//` を外して出し直す・確かめる）をします。
   出し直しも Cloudflare のサイトからできます: **Workers & Pages** → `tabisaki-github-io` → **Settings** →
   **Bindings** → **Add** → **R2 bucket** で、変数名 `PRIVATE_KB`・バケット `tabisaki-private` を選んで保存します。
   ただし、次に GitHub から出し直すと `wrangler.jsonc` の設定で上書きされるので、`wrangler.jsonc` の `//` も外してください

アプリの中に「上げる画面」は作っていません。管理画面（`admin/`）は合言葉しか守りが無く、非商用の元データを受け取る
入口をそこに足すと、合言葉が漏れたときに中身を書き換えられたり、上げた元データを取り出されたりするためです。
Cloudflare のサイトなら、ログインと二段階認証で守られています。

## 入れかた B: コマンドで（持ち主が一度だけ）

認証情報（Cloudflare のログイン・トークン）は、持ち主が手元で入れます。リポジトリには書きません。

1. プロジェクトの共有フォルダの `kb-private/` を、リポジトリの一番上に写します（`.gitignore` 済み）
2. Cloudflare にログインします（ブラウザが開きます）

   ```sh
   npx wrangler login
   ```

   ブラウザを使えない場所では、R2 の編集ができる API トークンを作り、
   `export CLOUDFLARE_API_TOKEN=...` としてから次へ進みます。

3. まず、何を上げるかを見ます（何も上げません）

   ```sh
   node tools/upload_private_kb.mjs --dry-run
   ```

4. 上げます。バケット `tabisaki-private` を作り、約160件（3.4MB）を1件ずつ上げます。10分ほどかかります

   ```sh
   node tools/upload_private_kb.mjs
   ```

   途中で止まったら、もう一度走らせてください（上書きされます）。`manifest.json` を最後に上げるので、
   途中のあいだ中継は「まだ無い」（`available: false`）と答えるだけです。

5. `wrangler.jsonc` の「非商用データの入れ物（R2）」の `r2_buckets` の `//` を外し、
   その上の `migrations` の `]` のあとに `,` を足して、出し直します

   ```sh
   npx wrangler deploy
   ```

   **バケットを作る前に `//` を外すと、デプロイが失敗します。** 4 が終わってから外してください。

6. 確かめます。富士山の山頂から 3km 以内には五合目のバス停があるので `within: true` になります

   ```sh
   curl -s -X POST https://tabisaki-github-io.shitianliang1000.workers.dev/stops/near \
     -H 'Origin: https://tabisaki-github-io.shitianliang1000.workers.dev' \
     -H 'Content-Type: application/json' -d '{"lat":35.3606,"lng":138.7274,"km":3}'
   ```

R2 の無料枠（保存 10GB・読み出し月1,000万回）の中に収まります。

## 手元で試す

```sh
node tools/upload_private_kb.mjs --pack-only   # .private-kb/ を作る（上げない）
node server/node-proxy.mjs                      # .private-kb/ を読む（PRIVATE_KB_DIR で場所を変えられます）
```

`wrangler dev` で試すときは `node tools/upload_private_kb.mjs --local` で手元の R2 に入れます。

## 中身を入れ替えるとき・消すとき

* 入れ替え: `kb-private/` を直して、もう一度 `node tools/upload_private_kb.mjs`
* 消す: Cloudflare のダッシュボードの R2 → `tabisaki-private` → 削除。そのあと `wrangler.jsonc` の
  `r2_buckets` を `//` に戻して出し直します（戻さないとデプロイが失敗します）

## 残る危うさ

* **再配布にあたるかどうかは、はっきりしません。** 元データを外に返さず、判定の答えだけを返す作りにしましたが、
  「非商用のデータを、公開しているサービスの判定に使う」こと自体が約款の「非商用の利用」に収まるかは、
  事務局に聞かない方針（2026-11-03）なので確かめていません。旅さきが広告や有料の機能を持つと、非商用の前提が崩れます
* **聞き続ければ、位置はある程度割り出せます。** `/stops/near` の true/false を細かい格子で何万回も聞けば、
  バス停のおおよその位置は推し量れます。半径の丸め・座標の丸め（画面側）・IP ごとの回数の上限で手間を増やして
  いますが、ゼロにはできません。気になるなら `/stops/near` の枠を `paid` に移すか、中継の外からの呼び出しを
  止めてください
* **`/spots/check` も同じで、名前を当てずっぽうに聞けば、載っているかどうかは分かります。** 返るのは1件ずつの
  はい／いいえで、一覧は取れません
* **R2 の中身は Cloudflare のアカウントに置かれます。** アカウントに入れる人なら誰でも読めます。公開バケット
  （r2.dev のアドレス）には**しないでください**
* **過去に配ったものは、これでは消えません。** Git の履歴・古い公開サイト・2026-10-27 の APK には元データが
  残っています（[kokudo-licenses.md](kokudo-licenses.md) の「まだ残っているところ」）。履歴の書き換えは 持ち主の決定待ちです
