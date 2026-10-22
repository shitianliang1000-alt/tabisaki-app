<?php
// 紹介のページ（/about）。Anthropic のサイトのような、余白の広い読みものにします。
//
// 開くたびに PHP が作るもの:
//   ・今日の日付と、季節のひとこと
//   ・今日のおすすめ3つ（季節に合うエリアを、日替わりで）
//   ・入力欄の見本（季節の書きかたを、打っているように順に見せる）
//   ・収録の数（data/areas.json。サイトを組み立てたときの数）
declare(strict_types=1);
require __DIR__ . '/inc/site.php';

$now = new DateTimeImmutable('now');
$season = season($now);
$data = load_areas();
$areas = $data['areas'] ?? [];
$picks = todays_picks($areas, $season, 3, $now);
$base = site_base();
$spotCount = (int) ($data['spotCount'] ?? 0);
$prefCount = (int) ($data['prefCount'] ?? 47);
$areaCount = count($areas);
$typing = array_map(fn($e) => $e[1], $season['examples']);

$title = '旅さきとは｜行きたいことを書くだけで、旅程になるAI';
$desc = '「温泉と海をゆっくり」と書くだけで、行き先・まわる順・移動時間まで組んだ旅程が届く無料のウェブアプリ。'
    . "全国{$prefCount}都道府県・" . number_format($spotCount) . 'か所の観光地から組みます。';

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: public, max-age=600');
header("Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
?><!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title><?= h($title) ?></title>
<meta name="description" content="<?= h($desc) ?>">
<link rel="canonical" href="<?= h($base) ?>about">
<meta property="og:type" content="website">
<meta property="og:site_name" content="<?= h(SITE_NAME) ?>">
<meta property="og:title" content="<?= h($title) ?>">
<meta property="og:description" content="<?= h($desc) ?>">
<meta property="og:url" content="<?= h($base) ?>about">
<meta property="og:image" content="<?= h($base) ?>og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#faf9f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1f1e1d" media="(prefers-color-scheme: dark)">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="stylesheet" href="<?= asset('assets/editorial.css') ?>">
<script type="module" src="<?= asset('assets/editorial.js') ?>"></script>
</head>
<body>
<a class="skip" href="#main">本文へ</a>
<header class="nav" id="nav">
  <a class="brand" href="./" aria-label="旅さき トップへ">
    <img src="mark.svg" alt="" width="26" height="26"><span>旅さき</span>
  </a>
  <nav aria-label="このページの中">
    <a href="#how">使いかた</a>
    <a href="#today">今日のおすすめ</a>
    <a href="#principles">考えかた</a>
    <a href="#faq">よくある質問</a>
  </nav>
  <a class="btn btn-dark btn-sm" href="./">旅程をつくる</a>
</header>

<main id="main">
  <section class="hero">
    <p class="eyebrow reveal"><?= h(jp_date($now)) ?> ・ <?= h($season['name']) ?>の旅</p>
    <h1 class="display reveal">
      <span class="line">行きたい、を書くだけで。</span>
      <span class="line">そのまま行ける、<em>旅程</em>に。</span>
    </h1>
    <p class="lead reveal">旅さきは、ふだんのことばで行きたいことを書くと、行き先・まわる順・移動時間まで組んだ旅行プランを返す、無料のAIです。行き先が決まっていなくても始められます。</p>

    <form class="demo reveal" action="./" method="get" role="search" aria-label="旅の希望を書いて始める">
      <label for="demo-q" class="sr-only">やりたいこと</label>
      <input id="demo-q" name="q" type="text" maxlength="200" autocomplete="off"
             placeholder="<?= h($typing[0] ?? '温泉でゆっくりして、海も見たい') ?>"
             data-typing="<?= h(json_encode($typing, JSON_UNESCAPED_UNICODE)) ?>">
      <button class="btn btn-accent" type="submit">旅程をつくる <span aria-hidden="true">→</span></button>
    </form>
    <p class="fine reveal">登録は要りません。位置情報は端末の中だけで使い、どこにも送りません。</p>
  </section>

  <div class="ticker" aria-hidden="true">
    <div class="ticker-track">
      <?php for ($k = 0; $k < 2; $k++): foreach (array_slice($areas, 0, 24) as $a): ?>
        <span><?= h($a['name']) ?><small><?= h($a['prefecture']) ?></small></span>
      <?php endforeach; endfor; ?>
    </div>
  </div>

  <section class="band" id="how">
    <div class="band-head reveal">
      <p class="eyebrow">How it works</p>
      <h2 class="title">3つの手順で、1日の旅が決まります。</h2>
    </div>
    <ol class="steps">
      <li class="reveal"><span class="num">01</span><h3>行きたいことを書く</h3>
        <p>「子どもと海で遊びたい」「古い町並みを歩いて、夜は温泉」。ふだんのことばで大丈夫です。出発地と日時、こだわりは入力欄のまわりから足せます。</p></li>
      <li class="reveal"><span class="num">02</span><h3>旅さきが組む</h3>
        <p>全国の観光地から行き先を選び、営業時間・定休日と、駅や停留所のあいだの移動時間を照らし合わせて、無理のない順に並べます。</p></li>
      <li class="reveal"><span class="num">03</span><h3>話しかけて直す</h3>
        <p>「もっとゆっくり」「昼は海鮮で」と続けて書けば、その場で組み直します。気に入った旅程は、リンクやカレンダーで共有できます。</p></li>
    </ol>
  </section>

  <section class="band band-soft" id="today">
    <div class="band-head reveal">
      <p class="eyebrow">Today</p>
      <h2 class="title">今日のおすすめ</h2>
      <p class="sub"><?= h($season['line']) ?></p>
    </div>
    <div class="cards">
      <?php foreach ($picks as $i => $a): ?>
        <article class="card reveal">
          <p class="card-pref"><?= h($a['prefecture']) ?></p>
          <h3 class="card-name"><?= h($a['name']) ?></h3>
          <p class="card-tag"><?= h($a['tagline']) ?></p>
          <p class="card-desc"><?= h($a['description']) ?></p>
          <div class="card-foot">
            <a class="link-arrow" href="./?q=<?= rawurlencode($a['name'] . 'を、' . $season['name'] . 'らしく楽しみたい') ?>">この旅を組む</a>
            <?php if (!empty($a['page'])): ?>
              <a class="link-quiet" href="<?= h($a['page']) ?>">エリアのページ</a>
            <?php endif; ?>
          </div>
        </article>
      <?php endforeach; ?>
    </div>
  </section>

  <section class="band stats" aria-label="収録の数">
    <div class="stat reveal"><b data-count="<?= $prefCount ?>"><?= $prefCount ?></b><span>都道府県</span></div>
    <div class="stat reveal"><b data-count="<?= $spotCount ?>"><?= number_format($spotCount) ?></b><span>か所の観光地</span></div>
    <div class="stat reveal"><b data-count="<?= $areaCount ?>"><?= $areaCount ?></b><span>紹介できるエリア</span></div>
  </section>

  <section class="band" id="principles">
    <div class="band-head reveal">
      <p class="eyebrow">Principles</p>
      <h2 class="title">旅さきが、大事にしていること。</h2>
    </div>
    <div class="principles">
      <div class="principle reveal"><h3>着いたら閉まっていた、を減らす</h3>
        <p>営業時間と定休日、乗り換えと歩く時間を、組むたびに確かめます。確かめられなかったところは、そうと書きます。</p></div>
      <div class="principle reveal"><h3>定番だけでなく、穴場も</h3>
        <p>有名な場所と、知る人ぞ知る場所のまぜかたを選べます。混みやすい時間は、ずらして組みます。</p></div>
      <div class="principle reveal"><h3>あなたの情報は、あなたの端末に</h3>
        <p>現在地は、近い駅を探すためだけに端末の中で使います。AIのキーはブラウザに置かず、中継を通して呼びます。</p></div>
    </div>
  </section>

  <section class="band band-soft" id="faq">
    <div class="band-head reveal">
      <p class="eyebrow">FAQ</p>
      <h2 class="title">よくある質問</h2>
    </div>
    <div class="faq">
      <details class="reveal"><summary>無料で使えますか？</summary><p>はい。登録もいりません。ブラウザで開くだけで使えます。</p></details>
      <details class="reveal"><summary>どこまで正しいですか？</summary><p>AIは間違えることがあります。電車の時刻と営業時間は目安なので、出かける前に公式の情報も確かめてください。</p></details>
      <details class="reveal"><summary>行き先が決まっていなくても使えますか？</summary><p>使えます。「晴れているところ」「2時間以内で行ける温泉」のように書けば、出発地からの距離と天気を見て選びます。</p></details>
      <details class="reveal"><summary>実際に組んだ例はありますか？</summary><p><a href="about.html">組んだ例のページ</a>と、<a href="areas/index.html">都道府県ごとのモデルコース</a>で読めます。</p></details>
    </div>
  </section>

  <section class="cta-band">
    <h2 class="display reveal">さて、どこへ行きましょう。</h2>
    <p class="reveal"><a class="btn btn-light" href="./">旅さきをひらく <span aria-hidden="true">→</span></a></p>
  </section>
</main>

<footer class="foot">
  <p><a href="./">旅さき</a> ・ <a href="areas/index.html">都道府県別の観光地</a> ・ <a href="credits.html">著作権表記</a></p>
  <p class="fine">このページは開いたときに作っています（<?= h($now->format('Y-m-d H:i')) ?> 日本時間）。</p>
</footer>
</body>
</html>
