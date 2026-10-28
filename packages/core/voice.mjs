// 声から希望の文を起こす（tabisaki voice-plan）。
//
// 文字起こしは**手元の whisper.cpp** で行います。録音したファイルは
// この端末から出ません（クラウドの音声認識は使いません）。
//
//   TABISAKI_WHISPER        whisper.cpp のコマンド（既定: whisper-cli）
//   TABISAKI_WHISPER_MODEL  モデルのファイル（例: ~/models/ggml-small.bin）
//
// 起こした文は、そのまま旅程にしません。人が読んで「これで組む」と
// 決めてから使います（CLI 側で確かめます）。聞き違い（「箱根」→「箱で」）
// のまま組むと、気づかないまま違う旅程ができるからです。

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export class VoiceError extends Error {
  /** @param {"invalid_input"|"setup"|"failed"} code */
  constructor(code, message) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
  }
}

/** whisper.cpp の出力から、起こした文だけを取り出します。 */
export function cleanTranscript(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    // -nt を付けても、版によっては [00:00:00.000 --> …] が付きます。
    .map((l) => l.replace(/^\s*\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, "").trim())
    // 音の無いところに出る印（[音楽]・(拍手) など）は除きます。
    .filter((l) => l && !/^[[(（【].*[\])）】]$/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function run(bin, args, { spawnImpl = spawn, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * 録音を文字にします。
 * @param {string} file 16kHz の WAV（ffmpeg -i in.m4a -ar 16000 -ac 1 out.wav）
 * @param {{env?: NodeJS.ProcessEnv, spawnImpl?: typeof spawn}} [opts]
 * @returns {Promise<string>}
 */
export async function transcribe(file, { env = process.env, spawnImpl } = {}) {
  if (!file) throw new VoiceError("invalid_input", "録音のファイルを指定してください。例: tabisaki voice-plan wish.wav");
  try {
    await access(file);
  } catch {
    throw new VoiceError("invalid_input", `録音のファイルがありません: ${file}`);
  }
  const model = env.TABISAKI_WHISPER_MODEL;
  if (!model) {
    throw new VoiceError("setup",
      "TABISAKI_WHISPER_MODEL に whisper.cpp のモデル（ggml-small.bin など）を指定してください（docs/calendar-and-voice.md）");
  }
  const bin = env.TABISAKI_WHISPER || "whisper-cli";
  let r;
  try {
    r = await run(bin, ["-m", model, "-f", file, "-l", "ja", "-nt", "-np"], { spawnImpl });
  } catch (e) {
    if (e?.code === "ENOENT") {
      throw new VoiceError("setup", `${bin} が見つかりません。whisper.cpp を入れるか、TABISAKI_WHISPER でコマンドを指定してください`);
    }
    throw new VoiceError("failed", `文字起こしを始められませんでした: ${e?.message ?? e}`);
  }
  if (r.code !== 0) {
    const why = r.err.trim().split(/\r?\n/).pop() || `終了コード ${r.code}`;
    throw new VoiceError("failed", `文字起こしに失敗しました: ${why}`);
  }
  const text = cleanTranscript(r.out);
  if (!text) throw new VoiceError("failed", "声を聞き取れませんでした。もう少し近くで、はっきり録ってみてください");
  return text;
}
