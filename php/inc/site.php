<?php
// 旅さき — PHP 版の共通の部品（InfinityFree などの PHP が動くサーバー向け）。
//
// サイトの本体（チャットの画面・js/・kb/）は、これまでと同じ静的ファイルです。
// PHP が受け持つのは「開いたときに中身が変わる」ところだけです。
//
//   index.php  … チャットの画面。挨拶と例を、いまの時刻と季節で差し替えて返す
//   about.php  … 紹介のページ（Anthropic のサイトのような読みもの）。
//                今日のおすすめ・季節のひとこと・収録の数を、開くたびに作る
//
// AI・経路・検索は、これまでどおり Cloudflare Worker（中継）が受けます。
// **キーはどこにも置きません**（ブラウザにも、この PHP にも）。
declare(strict_types=1);

const SITE_NAME = '旅さき';
/** AI の中継（js/config.js の PROXY_URL と同じもの）。 */
const PROXY_ORIGIN = 'https://tabisaki-github-io.shitianliang1000.workers.dev';
const TZ = 'Asia/Tokyo';

date_default_timezone_set(TZ);

/** HTML に書くときは、必ずこれを通します。 */
function h(?string $s): string
{
    return htmlspecialchars($s ?? '', ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** いま開いているサイトの根（https://〜/）。canonical や OGP に使います。 */
function site_base(): string
{
    $https = ($_SERVER['HTTPS'] ?? '') === 'on'
        || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'
        || ($_SERVER['SERVER_PORT'] ?? '') === '443';
    $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
    // Host は書き換えられるので、ホスト名に使える字だけを通します。
    if (!preg_match('/^[A-Za-z0-9.\-]+(:\d+)?$/', $host)) $host = 'localhost';
    $dir = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
    return ($https ? 'https' : 'http') . '://' . $host . $dir . '/';
}

/** 時刻の挨拶（js/shell.js の greeting と同じ区切り）。 */
function greeting(?DateTimeImmutable $now = null): string
{
    $h = (int) ($now ?? new DateTimeImmutable('now'))->format('G');
    if ($h >= 4 && $h < 10) return 'おはようございます';
    if ($h >= 10 && $h < 17) return 'こんにちは';
    return 'こんばんは';
}

/**
 * いまの季節と、その季節に向くもの。
 * genres は kb/regions.json の genres（onsen・nature・view・sea…）です。
 */
function season(?DateTimeImmutable $now = null): array
{
    $m = (int) ($now ?? new DateTimeImmutable('now'))->format('n');
    return match (true) {
        $m >= 3 && $m <= 5 => ['key' => 'spring', 'name' => '春', 'genres' => ['nature', 'history', 'view'],
            'line' => '桜と新緑の季節です。古い町並みや庭園を、歩いてめぐるのが気持ちいい頃です。',
            'examples' => [['桜と町歩き', '桜のきれいな古い町並みを歩きたい'], ['新緑の温泉', '新緑の中で、のんびり温泉に入りたい'], ['春の花畑', '春の花畑を見に、日帰りで出かけたい']]],
        $m >= 6 && $m <= 8 => ['key' => 'summer', 'name' => '夏', 'genres' => ['sea', 'nature', 'view'],
            'line' => '海と高原の季節です。朝早く出て、暑い昼は涼しいところで過ごす旅が向いています。',
            'examples' => [['子どもと海', '子どもと海で遊んで、夕方は花火も見たい'], ['涼しい高原', '涼しい高原で、湖のまわりを歩きたい'], ['暑い日の美術館', '暑い日でも楽しめる、屋内の美術館めぐり']]],
        $m >= 9 && $m <= 11 => ['key' => 'autumn', 'name' => '秋', 'genres' => ['nature', 'view', 'onsen', 'food'],
            'line' => '紅葉と味覚の季節です。色づいた山を見て、夜は温泉と土地のごはんで締めくくれます。',
            'examples' => [['紅葉と温泉', '紅葉を見て、夜は温泉でゆっくりしたい'], ['秋の食べ歩き', '秋の味覚を食べ歩きできる町へ行きたい'], ['穴場の紅葉', '人の少ない紅葉の名所を、穴場多めでまわりたい']]],
        default => ['key' => 'winter', 'name' => '冬', 'genres' => ['onsen', 'food', 'history'],
            'line' => '雪見の湯と冬の味覚の季節です。移動を短くして、温かいところで長く過ごす旅が向いています。',
            'examples' => [['雪見の温泉', '雪を見ながら温泉に入りたい'], ['冬の海鮮', '冬の海鮮を食べに、1泊2日で出かけたい'], ['駅近の町歩き', '寒い日でも楽しめる、駅から近い町歩き']]],
    };
}

/** 曜日つきの日付（10月22日（水））。 */
function jp_date(?DateTimeImmutable $now = null): string
{
    $now ??= new DateTimeImmutable('now');
    $w = ['日', '月', '火', '水', '木', '金', '土'][(int) $now->format('w')];
    return $now->format('n月j日') . "（{$w}）";
}

/** data/areas.json（tools/build_php_data.mjs が作る）を読みます。 */
function load_areas(): array
{
    static $cache = null;
    if ($cache !== null) return $cache;
    $file = __DIR__ . '/../data/areas.json';
    $raw = is_file($file) ? file_get_contents($file) : false;
    $json = $raw ? json_decode($raw, true) : null;
    return $cache = is_array($json) ? $json : ['areas' => [], 'prefCount' => 47, 'spotCount' => 0];
}

/**
 * 今日のおすすめ。季節に合うエリアを前に出し、日付で並びを変えます
 * （同じ日に開けば同じ3つ、次の日には別の3つ）。
 */
function todays_picks(array $areas, array $season, int $n = 3, ?DateTimeImmutable $now = null): array
{
    $now ??= new DateTimeImmutable('now');
    $seed = (int) $now->format('Ymd');
    $scored = [];
    foreach ($areas as $a) {
        $fit = count(array_intersect($a['genres'] ?? [], $season['genres']));
        // 日ごとに変わる、決まった揺らぎ（crc32 は PHP のどこでも同じ値です）。
        $jitter = (crc32($seed . ':' . ($a['id'] ?? '')) % 1000) / 1000;
        $scored[] = [$fit + $jitter * 1.6, $a];
    }
    usort($scored, fn($x, $y) => $y[0] <=> $x[0]);
    return array_map(fn($p) => $p[1], array_slice($scored, 0, $n));
}

/** 静的なファイルの版（更新した日時）。キャッシュを確実に入れ替えるために付けます。 */
function asset(string $path): string
{
    $file = __DIR__ . '/../' . $path;
    $v = is_file($file) ? (string) filemtime($file) : '0';
    return h($path . '?v=' . $v);
}
