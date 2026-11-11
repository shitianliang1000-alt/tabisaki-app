// 手元（node-proxy・試験）で使う、Workers KV と同じ答えを返す入れ物。
//
// tools/upload_private_kb.mjs --pack-only が作る .private-kb/ を読みます。
// Worker の中では使いません（Cloudflare では Workers KV のバインディング PRIVATE_KB を使います）。

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * @param {string} dir .private-kb/ の場所
 * @returns {{get(key:string): Promise<{json():Promise<any>, text():Promise<string>}|null>}|null}
 */
export function dirStore(dir) {
  const root = resolve(dir);
  if (!existsSync(join(root, "manifest.json"))) return null;
  return {
    async get(key) {
      const file = resolve(root, String(key));
      // 入れ物の外は読みません。
      if (!file.startsWith(root + sep)) return null;
      let body;
      try { body = await readFile(file, "utf8"); } catch { return null; }
      return { json: async () => JSON.parse(body), text: async () => body };
    },
  };
}
