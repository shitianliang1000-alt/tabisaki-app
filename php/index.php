<?php
// トップ（/）は tour.html（映像で見る旅さき）です。静的なページなので、そのまま返します。
// 前のトップ（動く見本の紹介）は /landing（landing.php）に残しています。
// 前のトップ（チャットの画面）あての旅程のリンク（/?p=…）は /app へ渡します。
declare(strict_types=1);
if (isset($_GET['p'])) {
    header('Location: app?' . (string) ($_SERVER['QUERY_STRING'] ?? ''), true, 302);
    exit;
}
$page = __DIR__ . '/tour.html';
if (!is_file($page)) {
    require __DIR__ . '/landing.php';
    exit;
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
readfile($page);
