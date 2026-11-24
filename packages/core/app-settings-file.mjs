// CUI の設定ファイル（~/.tabisaki/settings.json。置き場は TABISAKI_HOME で変えられます）。
// 中身はアプリと同じです（packages/core/src/app-settings.js）。鍵は書きません。

import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { userHome } from "./userdata.mjs";
import { defaultAppSettings, normalizeAppSettings } from "./src/app-settings.js";

export const appSettingsPath = (env = process.env) => path.join(userHome(env), "settings.json");

/**
 * 読みます。無い・壊れているときは既定です。
 * @returns {{value: object, from: "file" | "default", errors: string[]}}
 */
export function readAppSettings(env = process.env) {
  let raw;
  try {
    raw = readFileSync(appSettingsPath(env), "utf8");
  } catch {
    return { value: defaultAppSettings(), from: "default", errors: [] };
  }
  try {
    const { value, errors } = normalizeAppSettings(JSON.parse(raw));
    return { value, from: "file", errors };
  } catch (e) {
    return { value: defaultAppSettings(), from: "default", errors: [`${appSettingsPath(env)} を読めません（${e.message}）。既定で動きます`] };
  }
}

/** 書きます（途中で落ちても壊れたファイルが残らないよう、別名に書いてから置き換えます）。 */
export async function writeAppSettings(input, env = process.env) {
  const { value, errors } = normalizeAppSettings(input);
  if (errors.length) throw Object.assign(new Error(errors.join("\n")), { code: "invalid_input" });
  const file = appSettingsPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, file);
  return { file, value };
}
