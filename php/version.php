<?php
// 上げた版の確かめ（https://<アドレス>/version.php）。
// 「新しい zip を上げたのに古い画面が出る」ときに、サーバーの上に何があるかを見せます。
//   ・manifest.json（zip を作ったときの各ファイルの指紋）と、いまサーバーにあるものを比べ、
//     違うファイルを「古い」と出します（展開で上書きされなかったもの）。
//   ・サーバーの時刻（日本時間）。画面の日付がここと違えば、画面は取っておかれたものです。
// 秘密は出しません（ファイル名・指紋・時刻だけ）。
declare(strict_types=1);
header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');

$root = __DIR__;
$tz = new DateTimeZone('Asia/Tokyo');
echo "サーバーの時刻（日本時間）: " . (new DateTimeImmutable('now', $tz))->format('Y-m-d H:i:s') . "\n";
echo "PHP: " . PHP_VERSION . "\n";
$m = is_file("$root/manifest.json") ? json_decode((string) file_get_contents("$root/manifest.json"), true) : null;
if (!is_array($m)) {
    echo "manifest.json が無い → 古い版の zip の中身がそのまま残っています。zip を展開し直してください。\n";
    exit;
}
echo "zip を作った時刻: " . ($m['built'] ?? '?') . "\n\n";
$stale = 0;
foreach (($m['files'] ?? []) as $f => $sha) {
    $p = "$root/$f";
    $ok = is_file($p) && sha1_file($p) === $sha;
    if (!$ok) $stale++;
    echo ($ok ? 'OK    ' : (is_file($p) ? '古い  ' : '無い  ')) . $f
        . (is_file($p) ? '  （' . date('Y-m-d H:i', (int) filemtime($p)) . '）' : '') . "\n";
}
echo "\n";
foreach (['about.php', 'index2.html', 'kb/stops-bus', 'admin'] as $left) {
    if (file_exists("$root/$left")) echo "消してください: $left\n";
}
echo $stale === 0
    ? "→ サーバーの上のファイルは、この zip と同じです。画面が古いなら、取っておかれたもの（ブラウザ）です。\n"
    : "→ {$stale} 個のファイルが zip と違います。htdocs の中身を全部消してから、zip を展開し直してください。\n";
