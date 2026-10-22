// 画面が動かないとき、理由を画面に出します（ふつうの script。module ではありません）。
//
// 旅さきの画面は ES モジュールでできています。次のときは1つも動かず、
// 「設定」も「＋」も押せないまま、見た目だけが出ます。
//   ・zip の中の index.html をダブルクリックで開いた（file:// ではモジュールが読めない）
//   ・js/ のファイルが欠けている・古いものと混ざっている（上げ忘れ・キャッシュ）
//   ・ブラウザが古くて、書きかたを読めない
// js/app.js が読めたら <html data-booted="1"> になります。ならなければ案内を出します。
(function () {
  var shown = false;
  function show(title, body) {
    if (shown || document.documentElement.getAttribute("data-booted")) return;
    shown = true;
    var box = document.createElement("div");
    box.className = "boot-fail";
    box.setAttribute("role", "alert");
    var h = document.createElement("strong");
    h.textContent = title;
    var p = document.createElement("p");
    p.textContent = body;
    box.appendChild(h);
    box.appendChild(p);
    if (location.protocol !== "file:") {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "読み込み直す";
      b.onclick = function () { location.reload(); };
      box.appendChild(b);
    }
    document.body.appendChild(box);
  }
  function check() {
    if (location.protocol === "file:") {
      show("この開きかたでは動きません",
        "ファイルをダブルクリックで開くと、ブラウザの決まりで画面の部品が読めません。"
        + "サーバー（InfinityFree や Cloudflare）に上げたアドレスで開いてください。");
      return;
    }
    setTimeout(function () {
      show("画面の部品を読み込めませんでした",
        "通信が途切れたか、js/ のファイルが欠けているかもしれません。読み込み直しても直らないときは、"
        + "サイトのファイルを全部上げ直すか、ブラウザを新しくしてください。");
    }, 9000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check);
  else check();
})();
