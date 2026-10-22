<?php
// 手元の PHP（php -S）で、.htaccess と同じ道をつけます（./tabisaki serve php）。
// InfinityFree などの Apache では使いません（.htaccess が受け持ちます）。
$p = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if ($p === '/app' || $p === '/app/') { $_SERVER['SCRIPT_NAME'] = '/app.php'; require __DIR__ . '/../.php-site/app.php'; return true; }
if ($p === '/about' || $p === '/about/') { header('Location: /', true, 301); return true; }
if (str_starts_with($p, '/inc/') || $p === '/inc') { http_response_code(403); return true; }
return false;
