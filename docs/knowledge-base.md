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

## 自分の差分を重ねる（ユーザーKB）

`kb/` は書き換えずに、自分で足したスポットや直した説明を `~/.tabisaki/kbs/` に持って、旅程を組むときに上から重ねられます。形と決まりは [ユーザーKB](./user-kb.md) にあります。
