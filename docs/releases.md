# 版の付けかた（リリース）

旅さきは Web のサービスなので、`main` にマージしたものが（試験が通れば）そのまま公開されます。
版は「どの時点の公開か」をあとで指せるようにするための印です。

## 番号の決まり

[Semantic Versioning](https://semver.org/lang/ja/) に近い `0.X.Y` を使います（1.0 までは作り途中の扱いです）。

| 上げる所 | いつ | 例 |
|---|---|---|
| `X`（まん中） | 画面の流れが変わる・データを大きく入れ替える・URL が変わる | 公開先を変えた、設定の画面をなくした |
| `Y`（右） | 不具合の修正・小さな改善・データの追加 | スポットを直した、文言を直した |

CLI や API（[docs/roadmap.md](./roadmap.md)）ができたら、その使いかた（コマンドの引数・API の形）を変えるときにも `X` を上げます。

## 版を出す手順

1. [CHANGELOG.md](../CHANGELOG.md) の「まだ版にしていない変更」を、`## 0.X.Y — YYYY-MM-DD` に書き換える PR を出してマージする
2. そのマージのコミットにタグを付けて送る

   ```sh
   git switch main && git pull
   git tag -a v0.X.Y -m "旅さき 0.X.Y"
   git push origin v0.X.Y
   ```

3. GitHub の **Releases → Draft a new release** でタグ `v0.X.Y` を選び、本文に CHANGELOG のその版の部分を貼って公開する
   （「Generate release notes」を押すと、PR の一覧も付けられます）

## 公開との対応

- Cloudflare 版: Workers Builds が `main` の push ごとに上げます。ダッシュボードの Deployments に、どのコミットか出ます
- PHP 版: `./tabisaki php --zip` で作った zip を手で上げます。上げた日の版を CHANGELOG に書いておくと、後で食い違いに気づけます
- 公開した後で問題が見つかったときは、直す PR を出して `Y` を上げます（タグは付け直しません）
