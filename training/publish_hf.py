# -*- coding: utf-8 -*-
"""学習した重みを Hugging Face Hub に置く（Issue #434）。既定は「何を置くかを見せるだけ」。

    python training/publish_hf.py runs/e2b-r64 --repo <ユーザー名>/tabisaki-gemma-4-e2b            # 見るだけ
    HF_TOKEN=… python training/publish_hf.py runs/e2b-r64 --repo <ユーザー名>/tabisaki-gemma-4-e2b --push

置くもの（runs/<TAG>/hf/ にまとめてから上げます）
    *.Q4_K_M.gguf・Modelfile・SHA256SUMS    Ollama・llama.cpp でそのまま使う（約 3GB）
    adapter/                                LoRA だけ（--with-adapter。元の Gemma に足して使う人向け）
    run.json・eval.json・gate.md・manifest.json  どう作り、どう採点したか
    README.md                               モデルカード（ここで書きます）

守ること
- 合否（gate.md）が「合格」でないものは上げません（--force で上げられますが、勧めません）
- 学習データの出典（manifest.json の groups）に、継承が要るもの（cc-by-sa・odbl）や
  非商用のもの（国土数値情報・Yahoo! 由来）が入っていたら、重みを Apache-2.0 で出せません。
  そのときは --noncommercial を付けたときだけ、**非公開に限って**上げます（モデルカードは非商用の扱い）。
  公開するかと、そのライセンスは 持ち主が決めます（docs/own-model.md「あなたにしかできないこと」4）
- 既定は非公開のリポジトリ（--public で公開）。公開は取り消しても複製が残ります
- トークンは環境変数 HF_TOKEN からだけ読みます（引数には書きません）
"""
import argparse
import glob
import json
import os
import shutil
import sys

ALLOWED = {"cc0", "project", "permissive"}


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("run", help="train_lora.py の --out（runs/<TAG>）")
    p.add_argument("--repo", required=True, help="置き場所（<ユーザー名>/<名前>）")
    p.add_argument("--manifest", default=".tabisaki/training/manifest.json")
    p.add_argument("--with-adapter", action="store_true")
    p.add_argument("--public", action="store_true")
    p.add_argument("--noncommercial", action="store_true",
                   help="Apache-2.0 で出せない出典を含む学習データでも、非公開なら上げる")
    p.add_argument("--push", action="store_true")
    p.add_argument("--force", action="store_true", help="不合格でも上げる")
    return p.parse_args(argv)


def extra_groups(manifest):
    return sorted(set((manifest or {}).get("options", {}).get("groups", [])) - ALLOWED)


def check(run, manifest, force=False, noncommercial=False, public=False):
    """上げてよいか。だめな理由のリストを返します。"""
    problems = []
    gate = os.path.join(run, "gate.md")
    if not os.path.exists(gate):
        problems.append("gate.md がありません（training/eval_gate.mjs を通していない）")
    elif not open(gate, encoding="utf-8").read().strip().splitlines()[-1].startswith("合格") and not force:
        problems.append("合否が「合格」ではありません（gate.md）")
    if not glob.glob(os.path.join(run, "gguf", "*.gguf")):
        problems.append("GGUF がありません（training/to_gguf.sh か --gguf）")
    if not manifest:
        problems.append("学習データの manifest.json がありません（出典を確かめられない）")
    else:
        extra = extra_groups(manifest)
        if extra and not noncommercial:
            problems.append(f"学習データに、重みを Apache-2.0 で出せない出典が入っています: {', '.join(extra)}"
                            "（非公開で上げるなら --noncommercial）")
        elif extra and public:
            problems.append(f"学習データに {', '.join(extra)} が入っているので、公開（--public）はできません")
    return problems


def card(run_info, manifest, gate_text, repo):
    lic = (manifest or {}).get("counts", {}).get("byLicense", {})
    extra = extra_groups(manifest)
    license_id = "other" if extra else "apache-2.0"
    note = (f"学習データに {', '.join(extra)} の出典を含むため、**非商用に限ります**（重みのライセンスは未決）。"
            if extra else "継承が要るもの（CC BY-SA・ODbL）と非商用のものは、学習データから外しています。")
    rows = "\n".join(f"| {k} | {v} |" for k, v in lic.items())
    base = run_info.get("base", "google/gemma-4-E2B-it")
    res = run_info.get("result", {})
    return f"""---
license: {license_id}
base_model: {base}
language: [ja]
tags: [gemma4, lora, gguf, travel, japan]
---

# {repo.split('/')[-1]}

旅さき（日本の旅行先を提案するアプリ）用に、{base} に LoRA（r={run_info.get('lora', {}).get('r')}）をかけたモデルです。
観光スポットの事実（都道府県・料金の目安）を答え、収録に無い場所は「見つかりません」と答えるように学ばせています。

## 使いかた

```sh
ollama create tabisaki-gemma -f Modelfile   # 同じフォルダに GGUF を置いて
ollama run tabisaki-gemma "大通公園について教えてください。"
```

## 学習

| | |
| --- | --- |
| 元のモデル | {base}（Apache-2.0） |
| 方法 | LoRA r={run_info.get('lora', {}).get('r')}・alpha={run_info.get('lora', {}).get('alpha')}、答えの部分だけを学習（{run_info.get('backend')}） |
| データ | {run_info.get('data', {}).get('train_rows')} 件（確かめ {run_info.get('data', {}).get('eval_rows')} 件）、sha256 `{str(run_info.get('data', {}).get('train_sha256'))[:16]}…` |
| 損失 | 学習 {res.get('train_loss')}／確かめ {res.get('eval_loss')} |
| 機械 | {run_info.get('device')}、{run_info.get('seconds')} 秒 |

## 採点（tools/model_eval.mjs）

{gate_text.strip()}

## 学習データの出典

| ライセンス | 件数 |
| --- | ---: |
{rows}

{note}
「旅さきの収録データ」は旅さきのプロジェクトが書いた説明です。

## 注意

営業時間・料金は変わります。出かける前に公式の案内で確かめてください。
"""


def main(argv=None):
    a = parse(argv)
    manifest = json.load(open(a.manifest, encoding="utf-8")) if os.path.exists(a.manifest) else None
    problems = check(a.run, manifest, a.force, a.noncommercial, a.public)
    run_info = json.load(open(os.path.join(a.run, "run.json"), encoding="utf-8")) \
        if os.path.exists(os.path.join(a.run, "run.json")) else {}
    gate_path = os.path.join(a.run, "gate.md")
    gate_text = open(gate_path, encoding="utf-8").read() if os.path.exists(gate_path) else "（まだ採点していません）"

    out = os.path.join(a.run, "hf")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    files = []
    for f in glob.glob(os.path.join(a.run, "gguf", "*.gguf")) + [os.path.join(a.run, "gguf", n) for n in ("Modelfile", "SHA256SUMS")]:
        if os.path.exists(f):
            shutil.copy2(f, out)
            files.append(os.path.basename(f))
    for n in ("run.json", "eval.json", "gate.md"):
        if os.path.exists(os.path.join(a.run, n)):
            shutil.copy2(os.path.join(a.run, n), out)
            files.append(n)
    if manifest:
        shutil.copy2(a.manifest, os.path.join(out, "manifest.json"))
        files.append("manifest.json")
    if a.with_adapter and os.path.isdir(os.path.join(a.run, "adapter")):
        shutil.copytree(os.path.join(a.run, "adapter"), os.path.join(out, "adapter"))
        files.append("adapter/")
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as fp:
        fp.write(card(run_info, manifest, gate_text, a.repo))
    files.append("README.md")

    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(out) for f in fs)
    print(f"置き場所: https://huggingface.co/{a.repo}（{'公開' if a.public else '非公開'}）")
    print(f"置くもの（{size / 1e9:.2f}GB）: {', '.join(files)}")
    if problems:
        print("上げられません:\n  - " + "\n  - ".join(problems))
        return 1
    if not a.push:
        print("見るだけです。上げるなら --push を（HF_TOKEN が要ります）")
        return 0
    token = os.environ.get("HF_TOKEN")
    if not token:
        print("HF_TOKEN がありません")
        return 1
    from huggingface_hub import HfApi
    api = HfApi(token=token)
    api.create_repo(a.repo, private=not a.public, exist_ok=True, repo_type="model")
    api.upload_folder(repo_id=a.repo, folder_path=out, repo_type="model",
                      commit_message=f"旅さき {run_info.get('git', '')[:7]} の学習結果")
    print(f"上げました: https://huggingface.co/{a.repo}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
