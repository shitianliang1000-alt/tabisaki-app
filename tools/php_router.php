<?php
// 手元の PHP（php -S）で、.htaccess と同じ道をつけます（./tabisaki serve php）。
// InfinityFree などの Apache では使いません（.htaccess が受け持ちます）。
$p = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if ($p === '/app/') { $q = $_SERVER['QUERY_STRING'] ?? ''; header('Location: /app' . ($q !== '' ? '?' . $q : ''), true, 301); return true; }
if ($p === '/app' || $p === '/index.html') { $_SERVER['SCRIPT_NAME'] = '/app.php'; require __DIR__ . '/../.php-site/app.php'; return true; }
if ($p === '/about' || $p === '/about/') { header('Location: /', true, 301); return true; }
if (str_starts_with($p, '/inc/') || $p === '/inc') { http_response_code(403); return true; }
// 無いファイルは、.htaccess の ErrorDocument と同じく 404.html を出します。
$file = __DIR__ . '/../.php-site' . rawurldecode($p);
if ($p !== '/' && !is_file($file) && !is_dir($file) && is_file(__DIR__ . '/../.php-site/404.html')) {
    http_response_code(404);
    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/../.php-site/404.html');
    return true;
}
return false;
