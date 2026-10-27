## 何を変えたか

<!-- 1〜3行で。利用者から見て何が変わるか -->

Fixes #

## なぜ

## 確かめたこと

- [ ] `node --test tests/*.test.js` が通る
- [ ] 画面を変えたら、携帯の幅と暗い配色でも見た
- [ ] Cloudflare 版と PHP 版（`php/`）の両方に入れた（画面を変えたとき）
- [ ] 文を足したら `locales/ja.json` に置き、`node tools/i18n_check.mjs` が通る（翻訳の決まりは `docs/i18n.md`）
- [ ] `kb/` を変えたら `node tools/kb_check.mjs` が通り、出典を `kb/index.json` と `credits.html` に書いた
- [ ] 利用者から見える変更なら、`CHANGELOG.md` に1行足した

## 守ること

- [ ] APIキーをブラウザ・公開ファイルに置いていない
- [ ] 管理画面（`admin/`）を公開する変更ではない
- [ ] 位置情報を端末の外へ送っていない

## 画面の写真（あれば）
