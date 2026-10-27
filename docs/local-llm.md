# 手元の LLM で旅程を組む

旅さきの CLI は、手元で動かす LLM（Ollama など）に、希望文の読み取りと行き先の選定をさせられます。
希望の文も旅程も、その端末の外へは出ません。ネットが要るのは、はじめにモデルを取るときだけです。

```bash
./tabisaki local setup --pull          # つながるか・モデルがあるかを確かめ、無ければ取る
./tabisaki plan "温泉と海をゆっくり" --local
```

この文書は Issue #352 で決めたことをまとめています。

## 目次

* [何が変わるか](#何が変わるか)
* [対応する実行環境](#対応する実行環境)
* [要るもの](#要るもの)
* [セットアップ](#セットアップ)
* [使いかた](#使いかた)
* [モデル](#モデル)
* [うまくいかないとき](#うまくいかないとき)
* [しくみ](#しくみ)
* [まだやらないこと](#まだやらないこと)

## 何が変わるか

| | `--local` なし | `--local` あり |
|---|---|---|
| 希望文の読み取り | 語句から | LLM が読む（「海が見える」「子ども連れ」などの言い回しを拾う） |
| 行き先とスポットの選定 | 点数の高い順 | LLM が候補の中から選ぶ |
| 時刻・移動・営業時間の判定 | プログラム | プログラム（LLM には判定させません） |
| 通信 | なし | 手元の LLM へだけ |
| かかる時間 | 数秒 | 1本あたり30秒〜数分（モデルと機械しだい） |

LLM が返したスポットの番号は、候補の一覧と必ず照らし合わせます。収録に無い場所を作られても、旅程には入りません。
途中で LLM が答えなかったときは、収録データだけで組み直し、そのことを旅程の頭に書きます（`AI: … に聞けなかったため…`）。

## 対応する実行環境

OpenAI 互換の `POST /v1/chat/completions` を受けるものなら使えます。

| 実行環境 | 対応 OS | 確かめかた | モデルの取得（`--pull`） |
|---|---|---|---|
| [Ollama](https://ollama.com/download)（勧めます） | macOS・Windows・Linux（版の条件は Ollama の配布ページ） | `/api/tags` | ○ |
| LM Studio のサーバー | macOS・Windows・Linux | `/v1/models` | ×（LM Studio の画面で取る） |
| llama.cpp の `llama-server` | macOS・Windows・Linux | `/v1/models` | ×（GGUF を自分で置く） |

Node.js 22 以上が要ります（CLI そのもの）。

## 要るもの

| | 目安 |
|---|---|
| メモリ | 既定の `gemma4:e2b` で **8GB 以上**（ほかのアプリと合わせて）。下の [モデル](#モデル) の表も見てください |
| ディスク | モデル1つで **5〜8GB**。Ollama は `~/.ollama/models` に置きます |
| GPU | 無くても動きます（CPU だと1本に数分かかります）。Apple シリコンか、VRAM 6GB 以上の GPU があると速くなります |
| ネット | モデルを取るときだけ。取ったあとは切れていても組めます |
| モデルのライセンス | Gemma 4 は Apache License 2.0。ほかのモデルを使うときは、そのモデルの条件を確かめてください |

## セットアップ

1. Ollama を入れて、動かします

   ```bash
   # macOS・Windows: https://ollama.com/download から入れると、自動で動きます
   # Linux:
   curl -fsSL https://ollama.com/install.sh | sh
   ollama serve        # 別の端末で動かしたままにします
   ```

2. 確かめて、モデルを取ります

   ```bash
   ./tabisaki local setup --pull
   ```

   次の3つを順に確かめます。

   1. 手元の LLM につながるか
   2. モデルがあるか（`--pull` を付けると、無ければ取ります。数GBあります）
   3. 実際に答えるか（はじめての読み込みは1分ほどかかります）

   `ollama pull gemma4:e2b` で先に取っておいても同じです。

## 使いかた

```bash
./tabisaki plan "京都で紅葉の寺をゆっくり" --local
./tabisaki plan "子どもと水族館" --local --model=gemma4:e4b --output=json
./tabisaki plan "温泉" --local --llm-url=http://192.168.1.20:11434   # 別の機械で動かしているとき
```

| オプション | 中身 |
|---|---|
| `--local` | 手元の LLM を使う |
| `--model=<名前>` | 使うモデル（既定: `gemma4:e2b`） |
| `--llm-url=<URL>` | 行き先（既定: `http://127.0.0.1:11434`）。環境変数 `TABISAKI_LLM_URL`、`OLLAMA_HOST` でも決められます（この順に見ます） |

`--output=json` のときは、使ったモデルと、実際に使えたかが `ai` に入ります。

```json
"ai": { "provider": "local", "model": "gemma4:e2b", "used": true, "error": null }
```

ほかの機械の LLM を指すときは、その間の通信は暗号化されません。家の中の LAN か、SSH の転送（`ssh -L 11434:127.0.0.1:11434 …`）で使ってください。

## モデル

```bash
./tabisaki local models
```

| モデル | 取得の大きさ | メモリ | ライセンス | |
|---|---|---|---|---|
| `gemma4:e2b` | 4.6〜7.5GB | 8GB 以上 | Apache-2.0 | 既定。ノート PC でも動く |
| `gemma4:e4b` | 6.6〜9.5GB | 12GB 以上 | Apache-2.0 | 少し賢い。選定の当たりが良くなる |
| `gemma4:26b` | 16〜19GB | 24GB 以上 | Apache-2.0 | GPU か大きいメモリがあるとき |

大きさは Ollama のライブラリの表示（2026年10月）です。ほかのモデルも `--model=` で使えますが、指示（「JSON だけで返す」「候補の中から選ぶ」）を守る力が弱いと、選定の当たりが下がります。Web 版が使う Gemma と同じ系統なので、Gemma 4 を勧めます。

## うまくいかないとき

| 出る文 | 直しかた |
|---|---|
| `手元の LLM（…）につながりません` | Ollama を入れて `ollama serve` を動かす。別の場所なら `--llm-url=` |
| `モデル「…」がありません` | `ollama pull <名前>` か `./tabisaki local setup --pull`。LM Studio などはその画面で読み込む |
| `… が 120 秒で答えませんでした` | はじめての読み込みは遅いので、もう一度。続くなら小さいモデルにする |
| `AI: … に聞けなかったため、収録データから選びました` | 旅程は組めています。`TABISAKI_DEBUG=1` を付けると、何が起きたかを stderr に出します |
| `--model と --llm-url は --local といっしょに使います` | `--local` を足す |

終了コードは `plan` と同じです（0 = 組めた、1 = 組めなかった・つながらない、2 = 使いかたのまちがい）。

## しくみ

* つなぎかたの確かめ・モデルの取得は `packages/core/local.mjs` です
* 旅程を組むときは、`packages/core/src/ai.js` の `useLocalModel()` で、設定ファイル（`config.js`）を書き換えずに手元のモデルへ切り替えます。Web 版の動きは変わりません
* `createCore({ local: { model, baseUrl } })` のときだけ、`fetch` はその行き先へ通します。それ以外（中継・地図・天気）は今までどおり通しません
* 試験（`tests/local-llm.test.js`）は、Ollama と同じ形で答える小さなサーバーを立てて行います。本物のモデルは CI では動かしません

## まだやらないこと

* API サーバー（`packages/server`）と TUI からの `--local`
* Web 版から手元の LLM を呼ぶこと（ブラウザから `localhost` へは、Ollama 側で `OLLAMA_ORIGINS` を開ける必要があります）
* 埋め込み（ベクトル）を手元で作ること。似たスポットの検索は言葉の重みで行っています（[kb-extract.md](./kb-extract.md)）
