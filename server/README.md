# APIキーをブラウザに置かない

`js/config.js` にキーを書くと、**ページを開いた人から見えます**。
ブラウザから直接 Google を呼ぶ以上、避けられません。

個人利用や localhost ならそのままで構いません。公開サイトにするなら、
自分のバックエンドを1枚挟んでください。

```
ブラウザ（キーを持たない）
   ↓  POST {PROXY_URL}/gemini/generate
   ↓  POST {PROXY_URL}/gemini/embed
   ↓  POST {PROXY_URL}/routes
自分のサーバー（キーはここだけ）
   ↓
Gemini / Routes API
```

## 使いかた

1. `worker.js`（Cloudflare Worker）か `node-proxy.mjs`（Node）を置く
2. キーを環境変数／シークレットで渡す
3. `js/config.js` の `PROXY_URL` にその入口を書く

```js
export const PROXY_URL = "https://tabisaki-api.example.workers.dev";
export const GEMINI_API_KEY = "";   // ← 空のままにします
export const MAPS_API_KEY   = "";   // ← 空のままにします
```

これだけで、`js/endpoints.js` が行き先を切り替え、**キーをヘッダーに
載せなくなります**。アプリ側のコードはほかに何も変わりません。

### Cloudflare Worker

設定はリポジトリの一番上の `wrangler.jsonc` です（`main` が
`server/worker.js` を指しています）。**server/ の中には置きません。**
Cloudflare の Workers Builds はリポジトリの一番上で `wrangler` を
走らせるので、そこに設定が無いと
「Missing entry-point to Worker script」で止まります。

公開先のアドレスは変数で渡します（カンマ区切りで複数書けます）。
コードを書き換える必要はありません。

```bash
npx wrangler secret put ALLOW_ORIGIN
# https://example.github.io,http://localhost:8000
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MAPS_API_KEY
# 任意: チャットのネット検索をウェブ全体にする（無ければ Wikipedia だけ）
npx wrangler secret put TAVILY_API_KEY
npx wrangler deploy
```

### Node

```bash
GEMINI_API_KEY=xxx MAPS_API_KEY=yyy \
ALLOW_ORIGIN=https://example.com \
node server/node-proxy.mjs
```

本番では前に TLS を置いてください（Nginx / Caddy など）。
`PROXY_URL` は **https しか受け付けません**。http だと通信の中身が
途中で読まれ、キーを隠した意味がなくなるためです。

## AIは、この中継の中で動かせます（キー不要）

Cloudflare の Workers AI に Gemma 4 があります。`wrangler.jsonc` の

```jsonc
"ai": { "binding": "AI" }
```

を入れて配備すると、`POST /cf/generate` が使えます。**Googleのキーは
要りません。**アプリ側は `js/config.js` の

```js
export const MODEL_PROVIDER = "cloudflare";   // 既定
export const CF_MODEL = "@cf/google/gemma-4-26b-a4b-it";
```

で、こちらを使います。料金は Cloudflare のアカウント側（無料枠あり）。
Google AI Studio のキーを使いたい場合は `MODEL_PROVIDER = "gemini"` に
戻し、`GEMINI_API_KEY` を置いてください。

## 鍵が入っているかを確かめる

```bash
curl -X POST https://<worker>/status \
  -H "Origin: https://<自分のサイト>" -H "Content-Type: application/json" -d '{}'
```

```json
{"ok":true,"secrets":{"MAPS_API_KEY":true,"GEMINI_API_KEY":false}}
```

**値は返しません。**入っているかどうかだけです。入っていない鍵を上流へ
投げると、Googleから「API key not valid」が返ります。読んだ人は自分の
入力を疑いますが、直す場所は中継です。中継はその手前で止めて、そう言います。

なお、電車・バス（Yahoo!路線情報）に鍵は要りません。Routes API の鍵が
無くても、公共交通の旅程は組めます。

## 必ずやること

| 設定 | なぜ |
|---|---|
| `ALLOW_ORIGIN` を自分のサイトに絞る | `*` のままだと誰のページからでも呼べ、キーを隠した意味がなくなります |
| 公開先が増えたら `ALLOW_ORIGIN` に足す | 許していない出どころからは、ブラウザに「Load failed」としか出ません |
| 呼べるモデルを絞る（`ALLOWED_MODELS`） | 高いモデルを勝手に呼ばれるのを防ぎます |
| Google 側でもキーを制限する | 万一漏れたときの被害を小さくします |

## レート制限

IPごとに **20回/分・200回/時**（既定）で切ります。

### Cloudflare は Durable Object を使ってください

一番上の `wrangler.jsonc` に、次が入っています。

```jsonc
"durable_objects": {
  "bindings": [{ "name": "RATE", "class_name": "RateLimiter" }]
},
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["RateLimiter"] }]
```

**KV ではいけません。** KV で「読む → +1 → 書く」をすると、
同時に来た2本が同じ値を読み、同じ値を書きます。

```
A: 20 を読む
B: 20 を読む      ← A はまだ書いていない
A: 21 を書く
B: 21 を書く      ← 2回通ったのに 1 しか増えていない
```

上限20のつもりが、束ねて投げれば何回でも通ります。従量課金の API を
後ろに置いている以上、「だいたい20回」では制限になりません。
Durable Object なら、1つのIPにつき1つの実体が1本ずつ処理します。

バインドを忘れると**制限なしで通します**（設定し忘れで旅程が作れなく
なるより動くほうを選んでいます）。そのことはログに出ます。

### 二重にかける

上の制限は「Worker に届いてから」効きます。届く前に落としたいなら、
ダッシュボードの Security → WAF → Rate limiting rules でも同じパスに
上限をかけてください。二重にして損はありません。

## Origin だけでは足りない

Origin が無いリクエストは弾きます。ブラウザはクロスオリジンの POST に
必ず Origin を付けるので、付いていないものはブラウザから来ていません。

ただし **これは認証ではありません。** Origin は名乗りにすぎず、直に
叩く側は好きな値を書けます。素通りを1段減らすだけのものです。

## 使われかたの件数（/metrics）

画面は「旅程ができた」「組めなかった（圏外・通信・その他）」「圏外の帯が出た」
「1か所を外した」「別の候補を出した」を、**件数だけ** `/metrics` に送ります
（`js/metrics.js`）。入力した文・地名・旅程・位置・IP・端末の識別子は送らず、
中継も残しません。設定の「使われかたの集計に協力する」を外した人と、
ブラウザが Global Privacy Control / Do Not Track を出している人の分は送りません。

件数は Workers Analytics Engine のデータセット `tabisaki_metrics` に入ります
（`wrangler.jsonc` の `analytics_engine_datasets`）。無料枠の範囲で使えます。

**最初はバインディングを外してあります。** アカウントで Analytics Engine を
有効にしていないと、Worker のデプロイそのものが失敗するためです。使うときは、
ダッシュボードの Workers & Pages → Analytics Engine → Set up を一度押してから、
`wrangler.jsonc` の該当行のコメントを外してください。
`blob1` が出来事、`blob2` が補足（移動手段や組めなかった理由）です。

見るときは、Cloudflare の API トークン（Account Analytics: Read）で SQL API を叩きます。

```sh
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" \
  -d "SELECT blob1 AS event, blob2 AS detail, SUM(_sample_interval) AS n
      FROM tabisaki_metrics
      WHERE timestamp > NOW() - INTERVAL '7' DAY
      GROUP BY event, detail ORDER BY n DESC"
```

`METRICS` のバインディングが無い Worker は、受け取って 204 を返すだけで何も
残しません。手元の Node 版（`node-proxy.mjs`）には `/metrics` がなく、送っても
数えられずに捨てられます（画面は返事を待たないので、困ることはありません）。

## まだやっていないこと

公開の規模によっては、次が要ります。

| | なぜ |
|---|---|
| Turnstile（またはトークン発行） | 「このAPIを叩いているのは誰か」を、名乗り以外で確かめるため |
| 利用者ごとの上限 | IPは共有されます（社内・キャリアNAT・VPN） |
| 使用量の記録 | 誰の何が高いのかは、記録が無いと分かりません |
| Google 側のキー制限 | 万一漏れたときの被害を小さくします |

アプリ側の使用量ゲート（`js/quota.js`、50件ごとの確認）は
**その端末の中でしか数えていません**。サーバー側の上限の代わりには
なりません。
