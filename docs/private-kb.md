# 非商用データを Cloudflare の Workers KV に置く

国土数値情報のうち、**非商用**のデータ（P11 バス停・P12 観光資源・P27 文化施設）は、
複製物の再配布ができません（[kokudo-licenses.md](kokudo-licenses.md)）。
そこで次のように分けます（2026-11-11 持ち主の方針）。

| 置き場所 | 中身 |
|---|---|
| GitHub（このリポジトリ） | コードと**パラメータだけ**（学習済みの重み・集計値など）。元データは置きません |
| Cloudflare Workers KV（入れ物 `tabisaki-private`） | 非商用の元データ。**中継（Worker）の中の判定だけ**に使います |
| 手元（`kb-private/`・`.private-kb/`） | 同じ元データ。どちらも `.gitignore` 済み。手元での学習・確かめ用 |

## 中継が外に返すもの

元データ（名前・座標・件数・距離）は返しません。返すのは **true / false だけ**です
（`server/private-kb.js`。`tests/private-kb.test.js` が、答えに元データが混ざらないことを見ます）。

| 入口 | 送るもの | 返すもの | 使いみち |
|---|---|---|---|
| `POST /stops/near` | `{lat, lng, km}` | `{available, within}` | 山のスポットで「歩ける距離にバス停があるか」。あれば、その場所の位置のまま乗り換え検索に聞きます（`packages/core/src/routes.js` の `accessFor`） |
| `POST /spots/check` | `{name, lat, lng}` | `{available, listed}` | その名前の観光資源・文化施設が 2km 以内に載っているか（名前の裏取り）。画面側の窓口は `packages/core/src/private-hint.js` の `spotListed` |

* `km` は 0.5 / 1 / 1.5 / 2 / 3 / 5 のどれかに丸めます。画面は座標を 100m 単位に丸めて送ります
* KV がつながっていない・中身がまだ無いときは `available: false`。画面は「無い」と見て、これまでどおり進みます
* どちらも無料の枠（`free`）で数えます。外のサービスは呼びません
* `/status` の `privateKb` で、KV がつながっているかだけ分かります

## お金について

**お金はかかりません。カードの登録も要りません。** Workers KV は、いま中継に使っている Workers の
無料プランに入っています（[公式の上限](https://developers.cloudflare.com/kv/platform/limits/)、2026-11-11 に確認）。

| 無料プランの上限 | 旅さきで使う量 |
|---|---|
| 保存 1GB | 3.4MB（約160件） |
| 1件の大きさ 25MiB | いちばん大きい件で 0.2MB |
| 書き込み 1日1,000回 | 入れるときに約160回（入れ直しても1日に6回までなら収まります） |
| 読み出し 1日10万回 | 中継の中で覚えるので、聞かれた場所1か所につき最初の1回だけ |

上限を超えても請求は来ません。その日の残りは読み書きが止まり、中継は「無い」と答えて、アプリはこれまでどおり動きます。
（R2 は無料枠でもカードの登録が要るので、使うのをやめました。）

## 入れかた A: 管理画面から（コマンドを使わない）

1. **入れ物を作ります。** <https://dash.cloudflare.com/> にログインし、左の **Storage & Databases** → **Workers KV** →
   **Create**（Create instance）で、名前を `tabisaki-private` にして作ります。一覧に出る **ID**（英数字32文字）を控えます
2. **中継につなぎます。** `wrangler.jsonc` の「非商用データの入れ物（Workers KV）」の3行の `//` を外し、
   `"ここに ID"` を控えた ID に置き換え、上の `migrations` の `]` のあとに `,` を足します。GitHub のサイトで
   このファイルを直して main に入れれば、いつもどおり出し直されます（ID は秘密ではありません）
3. 管理画面（`/admin`、合言葉つき）を開き、上の **「非商用データを入れる」** を押します。「つながっています」と出れば準備できています
4. 共有フォルダ（非公開）の `kb-private/kv-upload.zip` を落として展開し、画面の「ファイルを選択」で
   展開したフォルダ（`manifest.json`・`bus`・`spots` が入っているもの）を選びます
5. **入れる** を押します。約160件を順に入れ、目次（`manifest.json`）を最後に入れます。途中で止まったら、もう一度押してください（上書きされます）

この画面は**入れるだけ**で、中身を見せる口はありません。決まった名前（`manifest.json`・`bus/緯度_経度.json`・
`spots/緯度_経度.json`）と決まった形の JSON だけを受け付けます（`server/private-kb.js` の `checkUpload`）。

## 入れかた B: コマンドで

認証情報（Cloudflare のログイン・トークン）は、持ち主が手元で入れます。リポジトリには書きません。

1. 共有フォルダの `kb-private/` を、リポジトリの一番上に写します（`.gitignore` 済み）
2. `npx wrangler login`（ブラウザが開きます）。使えないときは、Workers KV の編集ができる API トークンを
   `export CLOUDFLARE_API_TOKEN=...` で入れます
3. 入れ物を作り、ID を控えます: `npx wrangler kv namespace create tabisaki-private`
4. 入れます（一度の呼び出しで全部入ります）

   ```sh
   node tools/upload_private_kb.mjs --dry-run --namespace-id <ID>   # 何を入れるかだけ見る
   node tools/upload_private_kb.mjs --namespace-id <ID>
   ```

5. 入れかた A の 2 と同じく、`wrangler.jsonc` に ID を書いて出し直します

## 確かめる

富士山の山頂から 3km 以内には五合目のバス停があるので `within: true` になります。

```sh
curl -s -X POST https://tabisaki-github-io.shitianliang1000.workers.dev/stops/near \
  -H 'Origin: https://tabisaki-github-io.shitianliang1000.workers.dev' \
  -H 'Content-Type: application/json' -d '{"lat":35.3606,"lng":138.7274,"km":3}'
```

## 手元で試す

```sh
node tools/upload_private_kb.mjs --pack-only   # .private-kb/ を作る（入れない）
node server/node-proxy.mjs                      # .private-kb/ を読む（PRIVATE_KB_DIR で場所を変えられます）
```

## 中身を入れ替えるとき・消すとき

* 入れ替え: 管理画面からもう一度入れる（上書きされます）
* 消す: ダッシュボードの Workers KV → `tabisaki-private` → 削除。そのあと `wrangler.jsonc` の
  `kv_namespaces` を `//` に戻して出し直します（戻さないとデプロイが失敗します）

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
* **KV の中身は Cloudflare のアカウントに置かれます。** アカウントに入れる人なら誰でも読めます。二段階認証をかけてください
* **管理画面の合言葉が漏れると、中身を書き換えられます。** 読み出す口は作っていないので持ち出しはされませんが、
  間違った答え（バス停が無いのに「ある」）を返させることはできます。合言葉は長くし、漏れたら
  `npx wrangler secret put ADMIN_PASSWORD` かダッシュボードで変えてください。入れ終わったら合言葉を変えておくのも手です
* **過去に配ったものは、これでは消えません。** Git の履歴・古い公開サイト・2026-10-27 の APK には元データが
  残っています（[kokudo-licenses.md](kokudo-licenses.md) の「まだ残っているところ」）。履歴の書き換えは 持ち主の決定待ちです
