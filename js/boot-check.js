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
  function show(title, body, detail) {
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
    if (detail) {
      // 何が取れなかったか（サポートに伝えやすいように、小さく出します）。
      var d = document.createElement("p");
      d.textContent = detail;
      box.appendChild(d);
    }
    if (location.protocol !== "file:") {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "読み込み直す";
      b.onclick = function () { location.reload(); };
      box.appendChild(b);
    }
    document.body.appendChild(box);
  }
  // app.js を取り直して、取れない理由（404・HTML が返った・通信できない）を言葉にします。
  function probe(cb) {
    var el = document.querySelector('script[type="module"]');
    var src = el && el.src;
    if (!src || !window.fetch) return cb("");
    fetch(src, { cache: "no-store" }).then(function (r) {
      var type = (r.headers.get("content-type") || "").split(";")[0];
      cb("js/app.js: HTTP " + r.status + (type ? " (" + type + ")" : ""));
    }, function () { cb("js/app.js: 通信できませんでした"); });
  }
  function failed() {
    probe(function (detail) {
      show("画面の部品を読み込めませんでした",
        "通信が途切れたか、js/ のファイルが欠けているかもしれません。読み込み直しても直らないときは、"
        + "サイトのファイルを全部上げ直すか、ブラウザを新しくしてください。", detail);
    });
  }
  function check() {
    if (location.protocol === "file:") {
      show("この開きかたでは動きません",
        "ファイルをダブルクリックで開くと、ブラウザの決まりで画面の部品が読めません。"
        + "サーバー（InfinityFree や Cloudflare）に上げたアドレスで開いてください。");
      return;
    }
    // モジュールが1つでも取れないと、script の error が出ます。待たずにすぐ知らせます。
    var m = document.querySelector('script[type="module"]');
    if (m) m.addEventListener("error", failed);
    // 回線が遅いだけのこともあるので、読み終わるまで15秒は待ちます。
    setTimeout(failed, 15000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check);
  else check();
})();
