#!/bin/sh
# 旅さきの携帯アプリを組み立てます（Capacitor）。
#
#     sh mobile/build.sh android    … mobile/out/tabisaki-<版>-debug.apk
#     sh mobile/build.sh ios        … mobile/ios/ を作る（あとは Xcode で）
#
# 中身は Web 版の dist/ そのものです（tools/build_site.sh）。画面・エンジン・
# 収録（kb/）をアプリの中に入れるので、圏外でも開けて、旅程も組めます。
# AI・電車・バスだけは今までどおり中継（packages/core/src/config.js の PROXY_URL）を通ります。
#
# android/・ios/・www/・できたアプリは、毎回ここで作り直します。
# リポジトリには入れません（mobile/.gitignore）。
#
# 要るもの
#   android … JDK 21、Android SDK（ANDROID_HOME）の platform 36 と build-tools
#   ios     … macOS と Xcode（Linux では ios/ を作るところまで）
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
target="${1:-android}"

cd "$here"
[ -d node_modules/@capacitor/cli ] || npm ci

# 1. 中身（www/）。公開用の dist/ と同じものから、検索エンジン向けの
#    ファイルだけ抜きます（アプリの中では誰も読みません）。
rm -rf www
(cd "$root" && sh tools/build_site.sh "$here/www")
rm -f www/robots.txt www/sitemap.xml www/google*.html www/.nojekyll

# 版の名前は、いちばん新しい変更の日付（例 2026.10.27）。
version=$(cd "$root" && git log -1 --format=%cd --date=format:%Y.%m.%d 2>/dev/null || date +%Y.%m.%d)
# 版の番号（上がっていく整数）は、変更の数。
build=$(cd "$root" && git rev-list --count HEAD 2>/dev/null || echo 1)

case "$target" in
android)
  [ -d android ] || npx cap add android
  npx cap sync android

  # 2. 位置情報の許可。「近くから」を押したときにだけ尋ねます（js/app.js）。
  #    おおよその位置（COARSE）で足ります。Android 12 からは、FINE を一緒に
  #    書いておくと、利用者が「おおよそ」「正確」を選べます。
  #    バックグラウンドの位置は求めません。
  manifest=android/app/src/main/AndroidManifest.xml
  if ! grep -q ACCESS_COARSE_LOCATION "$manifest"; then
    sed -i.bak 's#<uses-permission android:name="android.permission.INTERNET" />#&\n    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />\n    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />\n    <uses-feature android:name="android.hardware.location" android:required="false" />#' "$manifest"
    rm -f "$manifest.bak"
  fi

  # 3. アイコン（res/android/ … icon-maskable-512.png から作ったもの）
  cp -R res/android/. android/app/src/main/res/
  printf '%s\n' '<?xml version="1.0" encoding="utf-8"?>' \
    '<resources><color name="ic_launcher_background">#F4F1EB</color></resources>' \
    > android/app/src/main/res/values/ic_launcher_background.xml

  # 4. 版
  sed -i.bak -e "s/versionCode [0-9]*/versionCode $build/" \
             -e "s/versionName \"[^\"]*\"/versionName \"$version\"/" android/app/build.gradle
  rm -f android/app/build.gradle.bak

  # 5. 組み立て（署名は Android の試験用の鍵。ストアに出すときは別の鍵で）
  (cd android && ./gradlew --no-daemon -q assembleDebug)
  mkdir -p out
  cp android/app/build/outputs/apk/debug/app-debug.apk "out/tabisaki-$version-debug.apk"
  echo "できました: mobile/out/tabisaki-$version-debug.apk"
  ;;
ios)
  [ -d ios ] || npx cap add ios
  npx cap sync ios
  plist=ios/App/App/Info.plist
  if [ -f "$plist" ] && ! grep -q NSLocationWhenInUseUsageDescription "$plist"; then
    # 位置情報を尋ねるときの説明。使うあいだだけ（WhenInUse）で、常に（Always）は求めません。
    sed -i.bak 's#<dict>#<dict>\n\t<key>NSLocationWhenInUseUsageDescription</key>\n\t<string>「近くから」旅程をつくるときに、いまいる場所を使います。位置はこの端末の中だけで使い、送りません。</string>#' "$plist"
    rm -f "$plist.bak"
  fi
  if [ "$(uname)" = Darwin ]; then
    echo "Xcode で開きます。Product → Archive で .ipa を作れます。"
    npx cap open ios
  else
    echo "ios/ を作りました。.ipa は macOS の Xcode でしか作れません。"
  fi
  ;;
*)
  echo "使いかた: sh mobile/build.sh android|ios" >&2
  exit 2
  ;;
esac
