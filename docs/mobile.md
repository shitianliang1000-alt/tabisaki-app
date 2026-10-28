# 携帯アプリ（Android・iOS）

Web 版をそのまま携帯アプリの殻（[Capacitor](https://capacitorjs.com/)）に入れて、Android の apk を作れるようにしました。
画面・旅程を組むエンジン・収録（`kb/`）はアプリの中に入るので、**圏外でも開けて、旅程も組めます**。AI・電車・バスだけは今までどおり中継（`packages/core/src/config.js` の `PROXY_URL`）を通ります。

> アプリの組み立て結果（apk・ipa）と `mobile/android/`・`mobile/ios/` はリポジトリに入れません。毎回 `mobile/build.sh` が作り直します。

## 作りかた

Android（JDK 21 と Android SDK の platform 36 が要ります）:

```sh
cd mobile && npm ci && cd ..
ANDROID_HOME=~/Android/Sdk sh mobile/build.sh android
# → mobile/out/tabisaki-<日付>-debug.apk
```

できた apk は、端末の「提供元不明のアプリ」を許して入れます（試験用の鍵で署名しています）。

iOS（macOS と Xcode が要ります）:

```sh
sh mobile/build.sh ios     # mobile/ios/ を作って Xcode を開く
```

Xcode で Product → Archive すると `.ipa` になります。Linux では `ios/` を作るところまでです。

## どの作りかたにしたか

| | PWA（今まで） | **Capacitor（選んだもの）** | React Native | Flutter |
|---|---|---|---|---|
| Web 版と同じコード | 全部 | **全部**（`dist/` をそのまま入れる） | エンジン（`js/`）だけ。画面は作り直し | なし（Dart で作り直し） |
| 保守するもの | 1つ | 1つ ＋ 殻の設定（`mobile/`） | 2つの画面 | 2つの画面と2つのエンジン |
| 圏外で開く | Service Worker の控え（初回はつながっている必要あり） | **入れた時点で全部入り** | 作れば可 | 作れば可 |
| ストアに出す | できない（iOS） | できる | できる | できる |
| 位置情報・通知 | ブラウザの範囲 | ブラウザの範囲 ＋ 必要ならプラグイン | ネイティブ | ネイティブ |
| アプリの大きさ | — | 約 11MB（うち収録 約 7MB） | 20MB〜 | 20MB〜 |
| 地図（Leaflet） | そのまま | **そのまま** | 作り直し | 作り直し |

決め手は「**エンジンと画面を2つ持たないこと**」です。旅さきの中身はほぼ全部が素の HTML と ES modules で、組み立ての道具（bundler）もありません。React Native や Flutter に移すと、画面を全部作り直したうえで、Web 版と同じ直しを毎回2か所に入れることになります。Capacitor なら、Web 版を直せばアプリも同じものになります。

PWA は今後も残します（ホーム画面に置けば、ほぼ同じに使えます）。アプリにする利点は、**入れた瞬間から圏外で使える**ことと、ストアから見つけてもらえることです。

## 最初に出す範囲（最小実用版）

入れるもの（Web 版と同じ）:

* 希望文からの旅程づくり、地図、旅程の保存（`localStorage`）、前につくった旅
* 圏外での旅程づくり（収録とエンジンはアプリの中。移動時間は距離からの目安）
* 「近くから」（位置は端末の中だけで使う）
* エリア別のページ（`areas/`）

まだ入れないもの:

| 項目 | 理由 | 次の手 |
|---|---|---|
| 通知（終電・出発の知らせ） | Android の WebView には Web の通知（`Notification`）がありません。画面には「この端末では通知を使えません」と出ます | `@capacitor/local-notifications` を足す |
| 共有ボタンの共有シート | WebView には `navigator.share` が無いことがあり、文の写しになります | `@capacitor/share` を足す |
| ストアへの公開 | 公開用の鍵・アプリ名の登録・審査が要ります。収録の一部に再配布の条件を確かめていないもの（[data-licenses.md](data-licenses.md)）があり、先に片づける必要があります | 下の「ストアに出す前に」 |
| 背景での位置・定期の更新 | 使いません（電池と、位置を集めないため） | — |

## 位置情報と権限

位置は「**近くから**」を押したときにだけ、そのとき1回だけ使います（`js/app.js`）。送りません。

| | Android | iOS |
|---|---|---|
| 求める権限 | `ACCESS_COARSE_LOCATION` と `ACCESS_FINE_LOCATION`（Android 12 からは、利用者が「おおよそ」を選べます） | `NSLocationWhenInUseUsageDescription`（使っているあいだだけ） |
| 求めないもの | 背景の位置（`ACCESS_BACKGROUND_LOCATION`）・連絡先・写真・カメラ・マイク | 常に（Always） |
| 尋ねる時 | 「近くから」を押したとき（起動したときには聞きません） | 同じ |

通信は `INTERNET` だけです。中継へ送るのは、今の Web 版と同じもの（希望文・候補の名前・区間）です。

## 電池と通信

* 起動時に通信しなくても画面が出ます。収録は県ごとに分かれていて、要る県だけを読みます。
* 位置は1回取ったら止めます（見張りつづけません）。
* 地図のタイル・写真（Wikipedia）・天気はつながっているときだけ取ります。圏外では出ないだけで、旅程は組めます。
* Service Worker はアプリでは登録しません（中身がはじめから入っているので不要で、更新後に古い控えが出るのを防ぐため）。

## Web 版との違い

* 画面の出どころは `https://app.tabisaki`（Android）・`capacitor://app.tabisaki`（iOS）です。中継（`server/worker.js`）はこの2つを `ALLOW_ORIGIN` に書かなくても通します。**中継をデプロイし直すまで、アプリから AI・電車・バスは使えません**（そのあいだは、圏外と同じ目安の旅程になります）。
* トップ（`/`）と紹介ページは入れていません。アプリはチャットの画面から始まります。
* 検索エンジン向けのファイル（`robots.txt`・`sitemap.xml`）は抜いています。

## 試したこと

* `mobile/build.sh android` で apk ができること（パッケージ `jp.tabisaki.app`、Android 7.0 以上、権限は通信と位置だけ）
* apk の中身（`www/`）を、Pixel 7 の画面の大きさ・外への通信をすべて止めた状態で開き、画面が出て「京都で寺をゆっくり回りたい」から旅程が組めること、Service Worker が登録されないこと
* 実機・エミュレーターでの確認は、まだです（作った環境にエミュレーターを動かす仕組みがありませんでした）

## ストアに出す前に

1. アプリの ID（`mobile/capacitor.config.json` の `appId`）を決める。**ストアに出したあとは変えられません。**
2. 公開用の鍵を作って、`assembleRelease`（Google Play は `bundleRelease` の `.aab`）で組む。鍵はリポジトリに入れない。
3. 収録の再配布の条件（[data-licenses.md](data-licenses.md)）を片づける。アプリは収録をまるごと配るので、Web より条件が厳しくなります。
4. プライバシーポリシー（位置は端末の中だけ、の一文を含む）をストアに書く。
