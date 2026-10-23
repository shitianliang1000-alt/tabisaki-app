<?php
// 旅さき — PHP 版の共通の部品（InfinityFree などの PHP が動くサーバー向け）。
//
// サイトの本体（チャットの画面・js/・kb/）は、これまでと同じ静的ファイルです。
// PHP が受け持つのは「開いたときに中身が変わる」ところだけです。
//
//   index.php  … トップ（/）。inc/landing.html に、今日の中身を入れて返す
//   app.php    … チャットの画面（/app）。挨拶と例を、いまの時刻と季節で差し替えて返す
//
// Cloudflare 版は、同じことを server/landing.js（JavaScript）でしています。
// 中身を作る手順（landing_view）と、ひな形の読みかた（render_tpl）は、
// 両方で同じ結果になるようにしてあります（tests/landing.test.js が比べます）。
//
// AI・経路・検索は、これまでどおり Cloudflare Worker（中継）が受けます。
// **キーはどこにも置きません**（ブラウザにも、この PHP にも）。
declare(strict_types=1);

const SITE_NAME = '旅さき';
/** AI の中継（js/config.js の PROXY_URL と同じもの）。 */
const PROXY_ORIGIN = 'https://tabisaki-github-io.shitianliang1000.workers.dev';
/**
 * 検索エンジンに載せる正式なアドレス（canonical・OGP・構造化データ）。
 * 同じサイトを Cloudflare（workers.dev）でも配っていますが、評価が2つに
 * 割れないよう、どちらのホストで開いてもここを名乗ります（2026-10-22 に決定）。
 * server/landing.js の SITE_ORIGIN と同じにしてください。
 */
const SITE_ORIGIN = 'https://tabisaki.site.je';
const TZ = 'Asia/Tokyo';
/** トップの CSP（server/landing.js の LANDING_CSP と同じ）。天気だけ外へ取りに行きます。 */
const LANDING_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' https://api.open-meteo.com; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";

date_default_timezone_set(TZ);

/** HTML に書くときは、必ずこれを通します。 */
function h(?string $s): string
{
    return htmlspecialchars($s ?? '', ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** 正式なアドレスの根（https://tabisaki.site.je/）。canonical や OGP に使います。 */
function canonical_base(): string
{
    return SITE_ORIGIN . '/';
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

/** PHP の rawurlencode と同じ（JS 側は server/landing.js の rawurl）。 */
function q(string $s): string
{
    return rawurlencode($s);
}

/** 見出しの文を、句読点ごとに span で包みます（1句ずつ出すため）。 */
function words(string $s): string
{
    $parts = preg_split('/(?<=[、。])/u', $s, -1, PREG_SPLIT_NO_EMPTY) ?: [$s];
    $out = '';
    foreach ($parts as $i => $p) $out .= '<span class="w" data-i="' . $i . '">' . h($p) . '</span>';
    return $out;
}

/**
 * トップ（inc/landing.html）に入れる中身を、すべて作ります。
 * 並び・字・URL の書きかたは server/landing.js の landingView と同じです。
 */
function landing_view(DateTimeImmutable $now, array $data, string $base, string $madeBy): array
{
    $now = $now->setTimezone(new DateTimeZone(TZ));
    $season = season($now);
    $areas = $data['areas'] ?? [];
    $news = $data['news'] ?? [];
    $picks = todays_picks($areas, $season, 8, $now);
    $spotCount = (int) ($data['spotCount'] ?? 0);
    $prefCount = (int) ($data['prefCount'] ?? 47);
    $ex = $season['examples'];

    // 動く見本に使う3つ（モデルコースのあるもの）。
    $demo = [];
    foreach ($picks as $a) {
        if (empty($a['course'])) continue;
        $spots = count(array_filter($a['course'], fn($c) => ($c['kind'] ?? '') === 'spot'));
        $demo[] = [
            'name' => $a['name'], 'pref' => $a['prefecture'], 'station' => $a['station'],
            'prompt' => $a['name'] . 'で、' . $ex[count($demo) % count($ex)][1],
            'lead' => $a['name'] . '（' . $a['prefecture'] . '）への日帰りの旅を組みました。立ち寄りは' . $spots . 'か所です。',
            'items' => array_slice($a['course'], 0, 12),
        ];
        if (count($demo) >= 3) break;
    }
    $json = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $typing = array_map(fn($e) => $e[1], $ex);
    $newsItem = fn($n) => ['tag' => $n['tag'], 'date' => $n['date'], 'title' => $n['title'],
        'label' => (int) substr($n['date'], 5, 2) . '月' . (int) substr($n['date'], 8, 2) . '日'];

    return [
        'title' => '旅さき｜行きたいことを書くだけで、旅程になるAI',
        'desc' => '「温泉と海をゆっくり」と書くだけで、行き先・まわる順・移動時間まで組んだ旅程が届く無料のAI。'
            . "全国{$prefCount}都道府県・" . number_format($spotCount) . 'か所の観光地から組みます。',
        'base' => $base,
        'build' => (string) ($data['build'] ?? '0'),
        'hour' => (int) $now->format('G'),
        'greeting' => greeting($now),
        'date' => jp_date($now),
        'year' => $now->format('Y'),
        'stamp' => $now->format('Y-m-d H:i'),
        'madeBy' => $madeBy,
        'seasonName' => $season['name'],
        'seasonLine' => $season['line'],
        'headB' => words('行きたいことを書くだけで、旅程になる。'),
        'headS' => words('旅さきは、全国' . number_format($spotCount) . 'か所の観光地から、営業時間と移動時間を確かめて、無理のない1日を組むAIです。'),
        'demoJson' => $json($demo),
        'demo0' => $demo[0] ?? null,
        'typing0' => $typing[0] ?? '',
        'typingJson' => $json($typing),
        'examples' => array_map(fn($e) => ['label' => $e[0], 'q' => q($e[1])], $ex),
        'rainQ' => q('雨でも楽しめるところをまわりたい'),
        'pickCount' => count($picks),
        'picks' => array_map(fn($a) => [
            'lat' => (string) ($a['lat'] ?? ''), 'lng' => (string) ($a['lng'] ?? ''),
            'image' => $a['image'] ?? null, 'page' => $a['page'] ?? null,
            'prefecture' => $a['prefecture'], 'station' => $a['station'], 'name' => $a['name'],
            'tagline' => $a['tagline'] ?? '',
            'q' => q($a['name'] . 'を、' . $season['name'] . 'らしく楽しみたい'),
        ], $picks),
        'prefCount' => $prefCount,
        'spotCount' => $spotCount,
        'spotCountFmt' => number_format($spotCount),
        'areaCount' => count($areas),
        'hasNews' => count($news) > 0,
        'news3' => array_map($newsItem, array_slice($news, 0, 3)),
        'newsRest' => count($news) > 3 ? ['items' => array_map($newsItem, array_slice($news, 3))] : null,
        'footAreas' => array_values(array_map(fn($a) => ['page' => $a['page'], 'name' => $a['name']],
            array_filter(array_slice($picks, 0, 4), fn($a) => !empty($a['page'])))),
    ];
}

/** ひな形の「空」。null・false・''・[] だけが空です（0 や '0' は空ではありません）。 */
function tpl_empty(mixed $v): bool
{
    return $v === null || $v === false || $v === '' || $v === [];
}

/**
 * ひな形（inc/landing.html）に中身を入れます。書きかたはひな形の先頭にあります。
 * server/landing.js の renderTpl と、同じ入力なら同じ字を返します。
 */
function render_tpl(string $tpl, array $view, array $stack = []): string
{
    $stack = $stack ?: [$view];
    $look = function (string $k) use ($stack) {
        for ($i = count($stack) - 1; $i >= 0; $i--) {
            if (is_array($stack[$i]) && array_key_exists($k, $stack[$i])) return $stack[$i][$k];
        }
        return null;
    };
    $str = fn($v) => is_bool($v) ? ($v ? 'true' : '') : (string) $v;
    return preg_replace_callback(
        '/\{\{([#^])(\w+)\}\}(.*?)\{\{\/\2\}\}|\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/s',
        function (array $m) use ($look, $stack, $view, $str): string {
            if ($m[1] !== '') {
                $v = $look($m[2]);
                if ($m[1] === '^') return tpl_empty($v) ? render_tpl($m[3], $view, $stack) : '';
                if (tpl_empty($v)) return '';
                if (is_array($v) && array_is_list($v)) {
                    $out = '';
                    foreach ($v as $item) $out .= render_tpl($m[3], $view, [...$stack, $item]);
                    return $out;
                }
                return render_tpl($m[3], $view, is_array($v) ? [...$stack, $v] : $stack);
            }
            if (isset($m[4]) && $m[4] !== '') return $str($look($m[4]) ?? '');
            return h($str($look($m[5]) ?? ''));
        },
        $tpl
    ) ?? '';
}
