# 知識ベース（Knowledge Base）

旅程の候補を探すための収録データ（`kb/`）の中身と、作り直しかたです。

`kb/` には、旅程候補を検索するための公開知識ベースが入っています。

現在の `kb/index.json`（`counts`）では、次の規模になっています。件数はここが唯一の出どころで、エリアのページもアプリもここから引きます（この表と README の件数は tests/kb-counts.test.js が `counts` と照らし合わせます）。

| 項目 | 件数 |
|---|---:|
| エリア | **1,371** |
| スポット | **54,100** |

主なデータソースは以下です。

| データソース | 内容 |
|---|---|
| 国土数値情報「観光資源」 | 国土交通省 |
| 国土数値情報「文化施設」 | 国土交通省 |
| 収録済みサンプルデータ | 手作業で確認したデータ |
| Wikidata | CC0。名前・座標・分類 |
| Wikipedia | CC BY-SA。日本語版の一覧記事71本（各地の温泉地・古墳・山・川・寺院・島・史跡…と、47都道府県の観光地）から、記事名・座標・冒頭の説明。画面の出典は「Wikipedia」にまとめています |
| 各都道府県の公式観光サイト | 観光地の名前の一覧（xlsx）の出どころ。**「観光地として挙がっている」ことの確認にだけ**使い、名前・座標・説明は写していません（`tools/import_tourism_list.py`） |
| OpenStreetMap | **ODbL 1.0**。座標が引けなかった観光地の名前に、名前と県の一致で付けた座標（4,312件。`tools/import_osm_tourlist.py`）。[ライセンスと外部データ](./data-licenses.md#openstreetmap-由来の座標)を読んでください |
| Overture Maps | **CDLA Permissive 2.0 / Apache 2.0 / CC0**（出どころごと。1件ずつ `license` に持たせています）。座標が引けなかった観光地の名前に、名前と県の一致で付けた座標（1,515件。`tools/import_overture_places.py`）。**飲食店・宿・店は入れていません**（営業の状態がほぼ空で、閉業を見分けられないため）。表示は「Overture Maps Foundation, overturemaps.org」。共有の義務はありません |
| 座標つきの観光地一覧（いただいたもの） | 各都道府県の公式観光サイトの名前に、Yahoo!ローカルサーチ・コンテンツジオコーダ、国土地理院（住所検索API）、Wikipedia・Wikidata、Photon・Nominatim・Overpass API（OSM）で座標を付けた一覧から10,653件（`tools/import_tourism_coords.py`。`src="tourlist-geocoded"`、取得元は1件ずつ `geo`）。[ライセンスと外部データ](./data-licenses.md#座標つきの観光地一覧)を読んでください |

再配布の条件がはっきりしているものだけを収録する方針です。
観光資源台帳（日本観光振興協会）は、条件が曖昧なため収録していません
（`tools/drop_daicho.py`）。各都道府県の公式観光サイトの利用条件は確かめて
いないため、**その一覧から写しているものはありません**（名前が観光地として
挙がっているかの確認にだけ使っています）。

大きなデータを1つのJavaScriptファイルにまとめず、`spots-*.json` に分割して読み込む構成です。

## 知識ベースを作り直す

主な生成処理は `tools/build_kb.py` です。

```bash
python3 tools/build_kb.py <P12を展開したディレクトリ> <doc.kml> [出力先]
```

不要なデータの除去や文化施設データの追加には、次のツールがあります。

```bash
python3 tools/clean_kb.py ...
python3 tools/import_p27.py ...
```

## スポットが実在するかの確認

`kb/verification-*.json`（都道府県ごと）に、スポット1件ずつの確認結果を持っています。手で調べた記録は `kb/verification.json` にもまとめています。

| 段 | ツール | 照らし合わせる先 | 付く status |
|---|---|---|---|
| 1 | `tools/verify_spots.mjs --stage a` | Wikipedia の記事（`wikipedia` 欄） | `verified` |
| 2 | `tools/verify_spots.mjs --stage b` | Wikipedia の名前検索 | `name_match_high` / `medium` / `low` |
| 3 | `tools/verify_spots_osm.mjs` | OpenStreetMap（Nominatim）・Wikidata・Web | `verified_osm` / `verified_wikidata` / `verified_web` / `not_found_web` |
| 4 | `tools/verify_spots_recheck.mjs` | 国土地理院 地名検索・Wikidata の周辺検索・Nominatim | `verified_gsi` / `verified_wikidata` / `verified_osm` |
| 手 | 人が調べる | 自治体・観光協会などのページ | `verified_manual`（`source` 必須） |

第4段は、第3段までで `not_found_web`（出典が見つからない）と `name_match_low`（Wikipedia の名前検索であいまいな記事に当たっただけ）に残ったスポットが対象です。どれも座標を持っているので、**名前が一致し、かつ 2km 以内にある**ものだけを確認済みにします。地名だけが重なる名前（「鹿追町」と「鹿追町コミュニティセンター郷土資料室」）や、収録元と同じ OSM ノード・Wikidata 項目との一致は採りません。

```bash
W=~/workspace/tabisaki-recheck
for k in 0 1 2; do
  node tools/verify_spots_recheck.mjs --source gsi --part $k/3 --out $W &
  node tools/verify_spots_recheck.mjs --source wd  --part $k/3 --out $W &
done
node tools/verify_spots_recheck.mjs --source osm --out $W   # Nominatim は1本・1秒以上の間隔で
node tools/verify_spots_recheck.mjs --apply --out $W        # kb/verification-*.json へ反映
```

3つとも当たらなかったスポットには `recheckedAt` が付きます。次に人が調べる対象はこの印で絞れます。

2026-11-03 の実行では、対象 9,530件のうち 2,472件を確認済みにしました（国土地理院 754・OpenStreetMap 1,365・Wikidata 353。確度 high 2,051・medium 421）。残りは 7,055件（`not_found_web` 1,579・`name_match_low` 5,476）で、多くは座標つき観光地一覧と国土数値情報から来た小さな施設や、ゴルフ場・行事など地図に載りにくいものです。

## 自分の差分を重ねる（ユーザーKB）

`kb/` は書き換えずに、自分で足したスポットや直した説明を `~/.tabisaki/kbs/` に持って、旅程を組むときに上から重ねられます。形と決まりは [ユーザーKB](./user-kb.md) にあります。
