# 速さの基準（Performance）

Web・CLI・知識ベース（`kb/`）の速さとメモリを、決まった手順で測ります。
機能を足したあとも遅くなっていないかを、数字で比べるためのものです。
旅程の中身の良し悪しは [benchmarks.md](./benchmarks.md) が受け持ちます。

```sh
node tools/perf_bench.mjs                   # CLI と kb/ を測る（約15秒）
node tools/perf_bench.mjs --check           # 上限を超えたら終了コード 1（CI と同じ）
node tools/perf_bench.mjs --write-baseline  # 今の値を基準にする

sh tools/build_site.sh dist
(cd dist && python3 -m http.server 8000 --bind 127.0.0.1 &)
BASE_URL=http://127.0.0.1:8000 node tools/perf_web.mjs   # Web の LCP・INP・CLS（Playwright が要ります）
```

どれも外へは通信しません。CLI と kb/ は、毎回新しい node を立ち上げて測り、中央値を取ります（読み込み済みのものを使い回すと、2回目から速く見えるため）。Web は画面ごとに3回開いて中央値を取ります。

## 測るもの

| 項目 | 測りかた | 上限 |
|---|---|---:|
| CLI の起動 | `tabisaki --version` の終わりまで | 300ms |
| CLI で旅程を組む | 2・3・4日の3通りを `--output=json` で組み、いちばん遅いもの | 4,000ms |
| CLI の最大メモリ | 旅程を組んだ node の最大 RSS（`tools/perf_rss.mjs`） | 400MB |
| KB の索引 | `index.json` と `regions.json` を読む | 100ms |
| KB を全部読む | アプリと同じ読み込み（索引づくり・場所でない記事の除外を含む） | 2,000ms |
| KB のシャード1枚 | いちばん遅いシャードを読んで JSON にする | 150ms |
| KB を読んだあとのメモリ | heap | 250MB |
| Web の LCP | いちばん大きな中身が出るまで | 2,500ms |
| Web の INP | 打つ・押す・開く・閉じるのうち、次に描かれるまでがいちばん遅いもの | 200ms |
| Web の CLS | 読み込みと操作のあいだに画面がずれた量 | 0.1 |

Web は、チャットの画面（`index.html`）・紹介（`about.html`）・エリアのページ（`areas/kyoto/`）を、携帯（幅 390・CPU を 4 倍遅く）とパソコン（幅 1280）で測ります。Web の上限は Google の「良い」の線です。

上限は [bench/perf-budget.json](../bench/perf-budget.json) にあります。CI の機械は手元より遅いので、CLI と kb/ の上限は手元の値の2〜3倍にしています。

## 回帰の見つけかた

CI（`test.yml`）は PR ごとに、`bench` ジョブで CLI と kb/ を、`e2e` ジョブで Web を測ります。

- **上限を超えたら失敗**にします。
- 基準（[bench/perf-baseline.json](../bench/perf-baseline.json)）より **1.5 倍を超えて遅い**ものは、実行のまとめ欄（Summary）に「気になる点」として出します。機械が違うと時間も変わるので、これは失敗にしません。

速くするための変更は、変更の前と後で `node tools/perf_bench.mjs`（と `tools/perf_web.mjs`）を走らせ、PR に両方の数字を書いてください。良くなったら `--write-baseline` で基準を作り直し、同じ PR に入れます。上限を変えるときは、理由も PR に書きます。

## 最初の基準（2026-10-28）

手元（Linux x64・4 コア・Node.js 22）で測った値です。

| 項目 | 値 |
|---|---:|
| CLI の起動 | 37ms |
| CLI で旅程を組む（2日 / 3日 / 4日） | 897ms / 1,321ms / 1,504ms |
| CLI の最大メモリ | 175MB |
| KB の索引 | 7ms |
| KB を全部読む（47 シャード・11.5MB） | 528ms |
| KB のシャード1枚（いちばん遅いもの） | 8ms |
| KB を読んだあとのメモリ | 78MB |

| 画面 | LCP | INP | CLS |
|---|---:|---:|---:|
| チャット（携帯） | 388ms | 112ms | 0 |
| チャット（パソコン） | 280ms | 64ms | 0 |
| 紹介（携帯 / パソコン） | 360ms / 144ms | 16ms / 16ms | 0 |
| エリアのページ（携帯 / パソコン） | 320ms / 128ms | 16ms / 16ms | 0 |

どれも上限の内側です。時間がかかっているのは「旅程を組む」（1〜1.5秒）で、そのほとんどは kb/ を読む時間ではなく、行き先と順番を選ぶ処理です。Web の数字は手元から配ったときのもので、回線の遅さは入っていません。実際の利用者の値は、管理画面の「旅程の結果」（かかった時間）で見ます。
