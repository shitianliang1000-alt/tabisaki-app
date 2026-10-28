// 利用者の手元に置く「足した情報」のファイル（spotinfo.mjs の形）を読み書きします。
//
// 置き場は TABISAKI_HOME（無ければ ~/.tabisaki）の spots.json です。
// リポジトリの kb/ には書きません。Git にも入りません。
//
// 写真を手元に置くときは、同じ場所の photos/ に置き、spots.json には
// ファイル名とライセンス・作者だけを書きます（spot photo add --file）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyStore, SCHEMA_VERSION, validateStore } from "./spotinfo.mjs";

export function userHome(env = process.env) {
  return path.resolve(env.TABISAKI_HOME || path.join(os.homedir(), ".tabisaki"));
}

export const storePath = (env = process.env) => path.join(userHome(env), "spots.json");
export const photoDir = (env = process.env) => path.join(userHome(env), "photos");

/** 読みます。無ければ空の形を返します。壊れていればエラーにします（黙って捨てません）。 */
export async function loadStore(file = storePath()) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return emptyStore();
    throw e;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} が JSON として読めません: ${e.message}`);
  }
  if (doc?.version !== SCHEMA_VERSION) throw new Error(`${file} の version が ${doc?.version} です（読めるのは ${SCHEMA_VERSION}）`);
  return { ...emptyStore(), ...doc };
}

/** 確かめてから書きます。途中で止まっても前のファイルが残るよう、別名で書いてから入れ替えます。 */
export async function saveStore(doc, file = storePath(), opts = {}) {
  const errors = validateStore(doc, opts);
  if (errors.length) throw new Error(`書けません（形がまちがっています）:\n  ${errors.join("\n  ")}`);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}
