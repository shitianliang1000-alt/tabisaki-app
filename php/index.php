<?php
// トップ（/）。Anthropic・OpenAI のサイトを手本にした、動く紹介のページです。
// チャットの画面は /app（app.php）にあります。
//
// 開くたびに作るもの（inc/site.php の landing_view）:
//   ・日付・時刻の挨拶・季節のひとこと
//   ・今日のおすすめ（季節に合うエリアを日替わりで）。天気はブラウザが Open-Meteo から取ります
//   ・動く見本（旅さきのエンジンが実際に組んだモデルコースを、チャットの形で再生）
//   ・お知らせ（リポジトリの履歴から、使う人に関わる変更だけ）と、収録の数
//
// 見た目は inc/landing.html（Cloudflare 版の server/landing.js と同じひな形）です。
declare(strict_types=1);
require __DIR__ . '/inc/site.php';

// 前のトップ（チャットの画面）あてに送られた旅程のリンク（/?p=…）は、/app へ渡します。
if (isset($_GET['p'])) {
    header('Location: app?' . (string) ($_SERVER['QUERY_STRING'] ?? ''), true, 302);
    exit;
}

$tpl = @file_get_contents(__DIR__ . '/inc/landing.html');
if ($tpl === false) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'inc/landing.html が見つかりません。サイトのファイルを全部上げてください。';
    exit;
}
$view = landing_view(new DateTimeImmutable('now'), load_areas(), canonical_base(), 'PHP');

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: public, max-age=300');
header("Content-Security-Policy: " . LANDING_CSP);
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
echo render_tpl($tpl, $view);
