// 旅さき — サイトの下のページ（ssh.html・mobile.html・api.html・spots/）の小さな動き。
// どれも「無くても読める」ものだけにしています（JS が止まっても本文と目次は残ります）。
// 外のライブラリは読みません（CSP は script-src 'self' のまま）。
(function () {
  "use strict";

  // 1. コードの写し取り（<figure class="code"><button class="copy">）
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var fig = btn.closest(".code");
      var pre = fig && fig.querySelector("pre");
      if (!pre) return;
      var text = pre.innerText;
      var done = function () {
        var old = btn.textContent;
        btn.textContent = "写しました";
        btn.setAttribute("data-done", "");
        setTimeout(function () { btn.textContent = old; btn.removeAttribute("data-done"); }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        // 古いブラウザ・http のとき
        var ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  });

  // 2. 地方・分類の絞り込み（spots/index.html）
  var chips = document.querySelectorAll(".filters .chip");
  if (chips.length) {
    var cards = Array.prototype.slice.call(document.querySelectorAll(".spot-card"));
    var state = { region: "all", cat: "all" };
    var empty = document.getElementById("spots-empty");
    var count = document.getElementById("spots-count");
    var apply = function () {
      var shown = 0;
      cards.forEach(function (c) {
        var ok = (state.region === "all" || c.dataset.region === state.region) &&
                 (state.cat === "all" || c.dataset.cat === state.cat);
        c.hidden = !ok;
        if (ok) shown++;
      });
      if (empty) empty.hidden = shown !== 0;
      if (count) count.textContent = String(shown);
    };
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var group = chip.dataset.group;
        state[group] = chip.dataset.value;
        document.querySelectorAll('.chip[data-group="' + group + '"]').forEach(function (c) {
          c.setAttribute("aria-pressed", String(c === chip));
        });
        apply();
      });
    });
    apply();
  }

  // 3. 目次の「いまの節」（読みもののページ）
  var toc = document.querySelector(".doc-toc");
  if (toc && "IntersectionObserver" in window) {
    var links = Array.prototype.slice.call(toc.querySelectorAll("a[href^='#']"));
    var map = new Map();
    links.forEach(function (a) {
      var el = document.getElementById(a.getAttribute("href").slice(1));
      if (el) map.set(el, a);
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var a = map.get(e.target);
        if (!a) return;
        if (e.isIntersecting) {
          links.forEach(function (x) { x.removeAttribute("aria-current"); });
          a.setAttribute("aria-current", "true");
        }
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    map.forEach(function (_a, el) { io.observe(el); });
  }
})();
