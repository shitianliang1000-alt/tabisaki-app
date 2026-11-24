<?php
// トップ（/）は tour.html（旅さきの紹介）です。静的なページなので、そのまま返します。
// 2026-11-24: ブラウザで使う Web 版はやめました。前のトップ（チャットの画面）あての
// 旅程のリンク（/?p=…）は、クエリを外したトップへ移します。
declare(strict_types=1);
if (isset($_GET['p'])) {
    header('Location: ./', true, 301);
    exit;
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
readfile(__DIR__ . '/tour.html');
