# AI と API キー

AI を使う・使わないの違い、キーの置き場所、外部サービスをまとめます。キーはブラウザに置きません。

## AIを使う場合 / 使わない場合

AI用APIキーを設定しなくても、アプリ自体は動作します。

### APIキーなし

- 語句検索ベースで候補を選びます
- 同梱されている範囲のデータを中心に旅程を作ります
- Google Routes APIがなければ、移動時間は距離から推定します

### キーを置く場所（2通り）

| 場所 | 向いている人 |
|---|---|
| **Cloudflare Worker の secret**（`PROXY_URL` の中継） | 公開サイト。キーはサーバー側にだけあり、ブラウザには届きません（このリポジトリの公開サイトはこの構成です） |
| **`packages/core/src/config.js`** | 自分で clone して手元だけで動かす人。**公開すると誰からも見えるので、公開サイトの `config.js` には書かないでください** |

（2026-10-23 までは画面の ⚙ 設定からキーを入れられましたが、設定の画面ごと無くしました。）

### Geminiを設定

`packages/core/src/config.js` でモデルを設定すると、希望文の理解・候補選定・必要に応じた追加調査などをAIに任せられます。

現在の設定ファイルでは、主モデルとフォールバックモデルが指定されています。

```js
export const MODEL_PROVIDER = "gemini";
export const MODEL = "gemma-4-e2b-it";
export const FALLBACK_MODELS = [
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
];
```

### ローカルモデル

`MODEL_PROVIDER = "local"` にすると、Ollama / vLLM / llama.cpp serverなど、OpenAI互換APIを持つローカルモデルを利用できます。

ただし、ローカルモデルではGoogle検索による追加調査やGeminiの構造化出力など、いくつかの機能が利用できません。

## APIキーと公開サイトの注意

**公開サイトの `packages/core/src/config.js` にAPIキーを直書きしないでください。** そこへキーを書くとブラウザを開いた利用者から確認できます。

公開サイトでキーを使う方法は2つです。

1. **自分のキーをサーバー側に置く** — `server/` のプロキシ実装（Cloudflare Worker）を利用して以下の構成にする（このリポジトリの公開サイトはこの構成です）
2. **キーを使わない** — `config.js` も `PROXY_URL` も空のまま公開する。行き先は収録データから、移動時間は距離から推定します

```text
ブラウザ
  ↓
PROXY_URL
  ↓
自分のバックエンド
  ├─ Gemini API
  └─ Google Routes API
```

詳しくは **[API_KEYS.md](../API_KEYS.md)** と **[server/README.md](../server/README.md)** を参照してください。

### 最低限確認したい設定

- `PROXY_URL`：公開時はHTTPSのバックエンドを指定
- `ALLOW_ORIGIN`：自分のサイトだけに制限
- `ALLOWED_MODELS`：利用可能なモデルを制限
- Google側のAPIキー制限
- サーバー側のレート制限

## 外部サービス

| サービス | 用途 | なくても動く？ |
|---|---|---|
| OpenStreetMap | 地図タイル | 地図表示を使う場合に必要 |
| Leaflet | 地図UI | 地図表示に必要 |
| Google Gemini | AIによる理解・選定・調査 | ✅ |
| Google Routes API | 実際の経路・移動時間 | ✅（距離推定にフォールバック） |
| Open-Meteo | 天気 | ✅ |
| Wikipedia | スポット写真の取得 | ✅ |
