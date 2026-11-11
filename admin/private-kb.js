// 非商用データを Workers KV に入れる画面（admin/private-kb.html）。
// 送るのは決まった名前のファイルだけです（manifest.json・bus/*.json・spots/*.json）。
// 中継（server/admin.js → server/private-kb.js）でも、鍵と中身の形をもう一度確かめます。

const API = new URL("../api/private-kb", location.href).toString();
const KEY = /^(manifest\.json|(bus|spots)\/-?\d{1,3}_-?\d{1,3}\.json)$/;
const $ = (id) => document.getElementById(id);
const log = (s) => { $("log").textContent += `${s}\n`; };

async function call(method, key, body) {
  const url = key ? `${API}?key=${encodeURIComponent(key)}` : API;
  const res = await fetch(url, {
    method, credentials: "same-origin", body,
    headers: { "X-Admin-Request": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* 下で言います */ }
  if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

/** 選んだフォルダの中のファイルを、KV の鍵（bus/24_123.json など）に直します。 */
export function keyOf(file) {
  const parts = String(file.webkitRelativePath || file.name).split("/");
  for (let i = 0; i < parts.length; i++) {
    const key = parts.slice(i).join("/");
    if (KEY.test(key)) return key;
  }
  return null;
}

async function refresh() {
  try {
    const s = await call("GET");
    $("status").textContent = !s.bound
      ? "Workers KV（PRIVATE_KB）がまだつながっていません。docs/private-kb.md の手順 1〜3 をしてから開き直してください。"
      : s.ready ? `入っています（バス停 ${s.tiles.bus}枚・観光資源 ${s.tiles.spots}枚）。入れ直すこともできます。`
        : "つながっています。まだ何も入っていません。";
    return s.bound;
  } catch (e) {
    $("status").textContent = `確かめられませんでした: ${e.message}`;
    return false;
  }
}

let picked = [];
$("folder").addEventListener("change", (e) => {
  picked = [...e.target.files].map((f) => ({ f, key: keyOf(f) })).filter((x) => x.key);
  // 目次は最後に入れます（途中で止まっても、中継は「まだ無い」と答えるだけ）。
  picked.sort((a, b) => (a.key === "manifest.json") - (b.key === "manifest.json") || a.key.localeCompare(b.key));
  $("log").textContent = "";
  log(`${picked.length}件を入れます。`);
  if (!picked.some((x) => x.key === "manifest.json")) log("manifest.json がありません。フォルダを選び直してください。");
  $("go").disabled = !picked.some((x) => x.key === "manifest.json");
});

$("go").addEventListener("click", async () => {
  $("go").disabled = true;
  $("bar").hidden = false;
  $("bar").max = picked.length;
  let failed = 0;
  for (let i = 0; i < picked.length; i++) {
    const { f, key } = picked[i];
    try { await call("PUT", key, await f.text()); }
    catch (e) {
      failed++;
      log(`入りませんでした: ${key}（${e.message}）`);
      if (key === "manifest.json") break;
    }
    $("bar").value = i + 1;
  }
  log(failed ? `${failed}件が入りませんでした。もう一度押してください（上書きされます）。` : "すべて入りました。");
  await refresh();
  $("go").disabled = false;
});

refresh();
