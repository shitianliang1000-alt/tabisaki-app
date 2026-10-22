<?php
// チャットの画面（/app。中身は index.html）を、開いたときの時刻と季節に合わせて返します。
//
// 中身は静的な index.html と同じです。PHP が差し替えるのは次のものだけで、
// JavaScript が動く前から正しい字が出ます（あとから字が変わるちらつきが無い）。
//
//   ・挨拶（おはようございます／こんにちは／こんばんは）
//   ・書きかたの見本の札（4つのうち、うしろの2つを季節のものに）
//   ・canonical と OGP の URL（いま開いているホストに合わせる）
//   ・紹介のページへのリンク（トップの index.php へ）
declare(strict_types=1);
require __DIR__ . '/inc/site.php';

$html = @file_get_contents(__DIR__ . '/index.html');
if ($html === false) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'index.html が見つかりません。サイトのファイルを全部上げてください。';
    exit;
}

$now = new DateTimeImmutable('now');
$season = season($now);
$base = site_base();

// 挨拶
$html = str_replace('<span id="hero-greet">こんにちは</span>',
    '<span id="hero-greet">' . h(greeting($now)) . '</span>', $html);

// 書きかたの見本: 3つ目と4つ目を、季節のものに替えます。
$chips = '';
foreach (array_slice($season['examples'], 0, 2) as [$label, $text]) {
    $chips .= '<button type="button" class="md-chip md-chip--assist md-state" data-example="'
        . h($text) . '">' . h($label) . '</button>';
}
$html = preg_replace_callback(
    '#(<div class="chip-set note-examples"[^>]*>)(.*?)(</div>)#s',
    function (array $m) use ($chips): string {
        preg_match_all('#<button\b.*?</button>#s', $m[2], $btn);
        $keep = implode('', array_slice($btn[0], 0, 2));
        return $m[1] . $keep . $chips . $m[3];
    },
    $html,
    1
) ?? $html;

// 紹介のページは、PHP 版ではトップ（index.php）です。
$html = str_replace('href="about.html">旅さきについて（使いかたと組んだ例）', 'href="./">旅さきについて（使いかたと組んだ例）', $html);

// URL は、いま開いているホストのものにします（引っ越しても直さずに済みます）。
$html = str_replace(PROXY_ORIGIN . '/og.png', $base . 'og.png', $html);
$html = preg_replace('#(<link rel="canonical" href=")[^"]*(")#', '${1}' . h($base) . 'app${2}', $html, 1) ?? $html;
$html = preg_replace('#(<meta property="og:url" content=")[^"]*(")#', '${1}' . h($base) . 'app${2}', $html, 1) ?? $html;

header('Content-Type: text/html; charset=utf-8');
// 挨拶が時刻で変わるので、長くは持たせません。
header('Cache-Control: public, max-age=300');
echo $html;
