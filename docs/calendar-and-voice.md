# カレンダー連携と声での入力

組んだ旅程を自分のカレンダーへ入れることと、声で希望を伝えることのしくみと決まりです（Issue #363）。

| | Web 版 | 端末（CLI） |
|---|---|---|
| カレンダーへ | `.ics` を保存して取り込む（Google・Apple・Outlook） | `--output=ics`、または `tabisaki sync` で CalDAV に直接書く |
| 声で | 入力欄のマイク（ブラウザの音声認識） | `tabisaki voice-plan`（手元の whisper.cpp） |

どちらも、**人が確かめてから**反映します。カレンダーへは中身を見せて「よいですか」と聞いてから書き、声は聞き取った文を見せて直せるようにしてから旅程にします。

## カレンダー

### .ics（いまある形）

Web 版の旅程の「カレンダーに入れる」と、`tabisaki plan … --output=ics` は同じ中身です（`js/ical.js`）。

- 予定ごとに通知（移動10分前・食事15分前・立ち寄り20分前・宿60分前）と、出発の前夜20時の「明日から」を入れます
- 時刻は浮動時間（日本の時刻のまま）、場所には座標（`GEO`）も入れます
- 同じ旅を2度取り込んでも予定が増えないよう、UID は旅の条件から決めます（CLI は希望・出発地・日数・出発の時刻の要約）
- ファイルを作るのは端末の中だけで、どこにも送りません

### CalDAV に直接書く（tabisaki sync）

```sh
export TABISAKI_CALDAV_USER=ryo
export TABISAKI_CALDAV_PASSWORD_CMD='pass show calendar/app-password'   # または TABISAKI_CALDAV_PASSWORD
./tabisaki sync "温泉と海をゆっくり" --days=2 --date=2026-11-07 \
  --caldav-url=https://dav.example.com/remote.php/dav/calendars/ryo/travel/
```

書く前に、書き込む予定の一覧を出して `よいですか [y/N]` と聞きます。`--dry-run` は一覧を出すだけで何も送らず、cron などの端末でないところでは、確かめたうえで `--yes` を付けたときだけ書きます。

| カレンダー | 使えるか | `--caldav-url` の例 |
|---|---|---|
| Nextcloud | ✅ | `https://<host>/remote.php/dav/calendars/<user>/<calendar>/` |
| Fastmail | ✅ アプリ用パスワード | `https://caldav.fastmail.com/dav/calendars/user/<mail>/<id>/` |
| iCloud | ✅ アプリ用パスワード | カレンダーごとの URL（`https://pNN-caldav.icloud.com/<id>/calendars/<cal>/`）。探しかたは段階 2 |
| Radicale・Baïkal（自分のサーバー） | ✅ | `http://127.0.0.1:5232/<user>/<calendar>/` も可 |
| Google カレンダー | ❌（OAuth が要る） | `.ics` を取り込んでください |
| Outlook（Microsoft 365） | ❌（CalDAV が無い） | `.ics` を取り込んでください |

#### 書く範囲と、重複しないしくみ

- **書くのは旅さきが作った予定だけです。** 予定1つを `tabisaki-<UID の要約>.ics` という1つのファイルとして `PUT` します。カレンダーのほかの予定は、読みも消しもしません
- 同じ条件の旅をもう一度送ると、同じファイルに上書きします（予定は増えません）
- 前に送って今回は無くなった予定（組み直して減った立ち寄りなど）は、消します
- どれを送ったかは `~/.local/state/tabisaki/caldav-sync.json`（`XDG_STATE_HOME` があればその下）に残します。中身はカレンダーの URL とファイル名だけで、自分だけが読める権限（600）で書きます
- 途中で失敗したときは、そこまでに書けた分も一覧に残すので、次の `sync` か `--remove` で片付けられます

#### 合言葉の扱い

- 渡しかたは環境変数（`TABISAKI_CALDAV_USER`・`TABISAKI_CALDAV_PASSWORD`）か、合言葉を出すコマンド（`TABISAKI_CALDAV_PASSWORD_CMD`。`pass`・1Password CLI の `op read`・macOS の `security find-generic-password -w` など）です。シェルの履歴に残したくないときは後者を使ってください
- `--caldav-url` に `user:pass@` を書くのは断ります（履歴と送った一覧に残るため）
- ファイル（送った一覧・設定）には書きません。ログにも出しません
- 暗号化していない `http://` には送りません（手元の `127.0.0.1`・`localhost` は別）
- iCloud・Fastmail などは、ふだんの合言葉ではなく**アプリ用パスワード**を作って使ってください。要らなくなったら、そのサービスの画面から取り消せます

#### 消す

```sh
./tabisaki sync --remove --caldav-url=<URL>                       # そのカレンダーに旅さきが書いた予定をすべて
./tabisaki sync --remove --caldav-url=<URL> "温泉と海をゆっくり" --days=2 --date=2026-11-07   # その旅だけ
```

`--remove` も、消す件数を見せて確かめてから消します。送った一覧に無い予定（自分で入れた予定）は消しません。

## 声での入力

### Web 版（入力欄のマイク）

ブラウザの音声認識（Web Speech API）が使えるとき（Chrome・Edge・Safari）だけ、入力欄の送るボタンの左にマイクが出ます。Firefox など使えないブラウザでは出ません。

- 聞き取った文は**入力欄に入れるだけ**で、送りません。読んで直してから、人が送ります
- 旅さきのサーバーには、声も文字も送りません
- ただし Chrome・Safari の多くは、**ブラウザの会社の音声認識サーバー（Google・Apple）に声を送って文字にします。** なので、はじめてマイクを押したときはそう書いた案内を出し、もう一度押したときに聞き始めます。この「わかった」は端末の中（`localStorage` の `tabisaki.voice.cloudOk`）にだけ覚えます
- マイクを使うため、`Permissions-Policy` を `microphone=(self)` にしました（このサイトの中だけ。ほかのサイトを埋め込んでも使えません）

### 端末（tabisaki voice-plan）

```sh
ffmpeg -i wish.m4a -ar 16000 -ac 1 wish.wav          # whisper.cpp は 16kHz の WAV を読みます
export TABISAKI_WHISPER_MODEL=~/models/ggml-small.bin  # 日本語なら small 以上を勧めます
./tabisaki voice-plan wish.wav --days=2
```

聞き取った文を出し、`Enter` でそのまま組む・書き直して `Enter` で直した文で組む・`n` でやめる、を選べます。端末でないところでは `--yes` を付けたときだけ組みます。

- 文字起こしは手元の [whisper.cpp](https://github.com/ggml-org/whisper.cpp) で行い、録音はこの端末から出ません
- コマンドの名前が `whisper-cli` でないときは `TABISAKI_WHISPER` で指定します
- 録音ファイルは読むだけで、コピーも保存もしません。要らなくなったら自分で消してください

### 音声認識の選択肢

| | 声が出ていく先 | 日本語 | 費用 | 旅さきでの扱い |
|---|---|---|---|---|
| whisper.cpp（手元） | どこにも出ない | ◎（small 以上） | 無料・CPU で数秒〜十数秒 | CLI で使う |
| Web Speech API | ブラウザの会社（Google・Apple） | ◎ | 無料 | Web 版で、案内のあとに使う |
| Web Speech API の端末内処理（Chrome の `processLocally`） | どこにも出ない | ○（言語パックが要る） | 無料 | まだ使わない（段階 3） |
| クラウドの API（OpenAI・Google Cloud・Azure など） | その会社 | ◎ | 有料・キーが要る | 使わない（ブラウザにキーを置かない決まりと、費用のため） |

## データと消しかた

| 何を | どこに | 消しかた |
|---|---|---|
| カレンダーに書いた予定 | 自分のカレンダー | `tabisaki sync --remove`、またはカレンダーの画面から |
| 送った一覧 | `~/.local/state/tabisaki/caldav-sync.json` | ファイルを消す（消すと `--remove` で片付けられなくなります） |
| CalDAV の合言葉 | 環境変数・自分の合言葉の道具 | 環境変数を消す・アプリ用パスワードを取り消す |
| Web 版の声の案内への同意 | ブラウザの `localStorage` | サイトのデータを消す |
| 録音 | 自分で作ったファイル | 自分で消す（旅さきは保存しません） |

## 段階の計画

| 段階 | 中身 | 状態 |
|---|---|---|
| 1 | `.ics` の書き出し（Web 版） | ✅ |
| 2 | `--output=ics`、`tabisaki sync`（CalDAV に PUT・上書き・減った分を消す・`--remove`）、`tabisaki voice-plan`（whisper.cpp）、Web 版のマイク | ✅ この版 |
| 3 | CalDAV の URL を探す（`PROPFIND` で `current-user-principal` → `calendar-home-set`。iCloud で要ります）、`ETag` を見て人が直した予定は上書きしない | 📝 |
| 4 | Web 版の端末内の音声認識（`processLocally`。落ちないことを確かめてから） | 📝 |
| 5 | カレンダーの空きを読んで日程を決める（読み取りの許可が要るので、別に同意を取る） | 📝 |
| — | Google カレンダーの API（OAuth のクライアント・審査が要る） | 判断待ち |
