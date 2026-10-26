// 管理画面の「変更待ち」を、GitHub のプルリクエストにします。
//
// kb/ はリポジトリに入っていて、公開（Cloudflare Worker・PHP 版）はそこから
// 組み立てます。管理画面から直接書き換える入れ物はありません（あっても、
// リポジトリと食い違うだけです）。変更は PR にして、マージしたら公開されます。
// 間違えても、マージ前なら閉じるだけで済みます。
//
// 使うには、Worker の secret GITHUB_TOKEN に、このリポジトリだけに
// 絞った fine-grained token（Contents: Read and write、
// Pull requests: Read and write）を入れます。無ければ、管理画面は
// 「JSON で書き出す」だけを出します（tools/apply_kb_edits.mjs で当てます）。

import { applyEdits, shardsFor } from "./kbedit.js";

// 2026-10 にリポジトリの名前が tabisaki.github.io から tabisaki-app に
// 変わりました（古い名前は GitHub が転送しますが、書き込みは新しい名前で）。
export const REPO = "shitianliang1000-alt/tabisaki-app";
const API = "https://api.github.com";

function gh(env, path, init = {}) {
  return fetch(`${API}/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tabisaki-admin",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function ok(res, what) {
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  throw new Error(`${what}に失敗しました（${res.status}）${text.slice(0, 200)}`);
}

/** main の、そのファイルの中身（文字列）。 */
async function raw(env, path, sha) {
  const res = await ok(await gh(env, `/contents/${path}?ref=${sha}`,
    { headers: { Accept: "application/vnd.github.raw" } }), `${path} の読み込み`);
  return res.text();
}

/**
 * 変更待ちを1本の PR にします。
 * @returns {Promise<{url: string, applied: object[], skipped: object[]}>}
 */
export async function openKbPullRequest(env, edits, now = new Date()) {
  if (!env?.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN が入っていません");
  if (!edits.length) throw new Error("変更待ちがありません");

  const ref = await (await ok(await gh(env, "/git/ref/heads/main"), "main の確認")).json();
  const base = ref.object.sha;
  const commit = await (await ok(await gh(env, `/git/commits/${base}`), "main の確認")).json();

  const index = await raw(env, "kb/index.json", base);
  const files = shardsFor(JSON.parse(index), edits);
  const shards = new Map();
  for (const f of files) shards.set(f, await raw(env, `kb/${f}`, base));
  const touchesNames = edits.some((e) => e.op === "add" || (e.op === "delete" && e.dropName));
  const names = touchesNames ? await raw(env, "kb/names.json", base) : undefined;

  const result = applyEdits({ index, shards, names, edits });
  if (!result.files.size) {
    return { url: "", applied: [], skipped: result.skipped };
  }

  const tree = await (await ok(await gh(env, "/git/trees", {
    method: "POST",
    body: JSON.stringify({
      base_tree: commit.tree.sha,
      tree: [...result.files].map(([path, content]) =>
        ({ path, mode: "100644", type: "blob", content })),
    }),
  }), "ファイルの用意")).json();

  const summary = describe(result.applied);
  const made = await (await ok(await gh(env, "/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message: `管理画面からのスポットの変更（${result.applied.length}件）\n\n${summary}`,
      tree: tree.sha, parents: [base],
    }),
  }), "コミット")).json();

  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 13);
  const branch = `admin/kb-edits-${stamp}`;
  await ok(await gh(env, "/git/refs", {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: made.sha }),
  }), "ブランチ");

  const pr = await (await ok(await gh(env, "/pulls", {
    method: "POST",
    body: JSON.stringify({
      title: `管理画面からのスポットの変更（${result.applied.length}件）`,
      head: branch, base: "main",
      body: `管理画面（/admin）の「変更待ち」から作りました。\n\n${summary}`
        + (result.skipped.length
          ? `\n\n当てられなかったもの:\n${result.skipped.map((s) => `- ${s.name || s.id}: ${s.why}`).join("\n")}`
          : ""),
    }),
  }), "プルリクエスト")).json();

  return { url: pr.html_url, applied: result.applied, skipped: result.skipped };
}

/** PR の本文に書く、変更の一覧。 */
export function describe(edits) {
  return edits.map((e) => {
    const who = `${e.name || e.id}（${e.id}）`;
    if (e.op === "add") return `- 追加: ${who} ${e.spot.category}`;
    if (e.op === "delete") return `- 削除: ${who}`;
    if (e.op === "category") return `- 分類: ${who} ${e.from || "?"} → ${e.category}`;
    if (e.op === "description") return `- 説明: ${who}`;
    return `- ${e.op}: ${who}`;
  }).join("\n");
}
