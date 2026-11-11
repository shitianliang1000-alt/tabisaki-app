# -*- coding: utf-8 -*-
"""旅さきの自前モデル（Gemma 4）に LoRA をかける（Issue #434）。

    # GPU（Colab など）。Unsloth があれば Unsloth、無ければ PEFT で
    python training/train_lora.py --base unsloth/gemma-4-E2B-it --out runs/e2b-r64 --gguf q4_k_m

    # GPU の無い機械で、道具が最後まで通るかだけ（小さな試験用モデル。数十秒）
    python training/train_lora.py --base tiny-random/gemma-4-e --backend peft --limit 16 --max-steps 4 --out runs/smoke

読むもの: .tabisaki/training/{train,eval}.jsonl（node tools/export_training_data.mjs が書く）
書くもの: <out>/
    adapter/           LoRA の重みだけ（数十〜数百MB）
    merged/            元のモデルに LoRA を足し込んだもの（GGUF にするのはこれ）
    gguf/              --gguf を付けて、Unsloth で学習したとき（*.Q4_K_M.gguf と Modelfile）
    run.json           条件・データの指紋（sha256）・損失の推移・git のコミット

決めてあること（docs/training.md）
- LoRA は r=64・alpha=64。言葉の層だけにかけ、画像の層には触りません
- 学ぶのは答えの部分だけ（sft_format.py）
- 学習率 2e-4、1件ずつ×8回ためて1歩（実質 8件）、1周
"""
import argparse
import json
import math
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sft_format as F  # noqa: E402

TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", default="unsloth/gemma-4-E2B-it", help="元のモデル（Hugging Face の名前か、手元のフォルダ）")
    p.add_argument("--backend", choices=["auto", "unsloth", "peft"], default="auto")
    p.add_argument("--data", default=".tabisaki/training", help="train.jsonl・eval.jsonl のあるフォルダ")
    p.add_argument("--out", default="runs/latest")
    p.add_argument("--r", type=int, default=64)
    p.add_argument("--alpha", type=int, default=64)
    p.add_argument("--dropout", type=float, default=0.0)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--epochs", type=float, default=1.0)
    p.add_argument("--max-steps", type=int, default=-1, help="これを決めると epochs より優先")
    p.add_argument("--max-len", type=int, default=2048)
    p.add_argument("--limit", type=int, default=0, help="学習に使う行の上限（試しに回すとき）")
    p.add_argument("--eval-limit", type=int, default=200)
    p.add_argument("--seed", type=int, default=3407)
    p.add_argument("--load-4bit", action="store_true", help="QLoRA（Unsloth のとき。VRAM が足りないとき）")
    p.add_argument("--gguf", default="", help="q4_k_m など。Unsloth のときだけ、学習のあと GGUF まで作る")
    p.add_argument("--no-merge", action="store_true", help="足し込んだモデルを書かない（容量の節約）")
    return p.parse_args(argv)


def pick_backend(name):
    if name != "auto":
        return name
    try:
        import torch
        if not torch.cuda.is_available():
            return "peft"
        import unsloth  # noqa: F401
        return "unsloth"
    except Exception:
        return "peft"


def git_commit():
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=HERE, capture_output=True, text=True,
                              timeout=10).stdout.strip() or None
    except Exception:
        return None


def load_unsloth(a):
    from unsloth import FastModel
    from unsloth.chat_templates import get_chat_template
    model, tok = FastModel.from_pretrained(model_name=a.base, max_seq_length=a.max_len,
                                           load_in_4bit=a.load_4bit, full_finetuning=False)
    model = FastModel.get_peft_model(
        model, finetune_vision_layers=False, finetune_language_layers=True,
        finetune_attention_modules=True, finetune_mlp_modules=True,
        r=a.r, lora_alpha=a.alpha, lora_dropout=a.dropout, bias="none", random_state=a.seed)
    tok = get_chat_template(tok, chat_template="gemma-4")
    return model, tok


def load_peft(a):
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoProcessor, AutoTokenizer
    cuda = torch.cuda.is_available()
    dtype = torch.bfloat16 if cuda and torch.cuda.is_bf16_supported() else (torch.float16 if cuda else torch.float32)
    try:
        tok = AutoTokenizer.from_pretrained(a.base)
    except Exception:
        tok = AutoProcessor.from_pretrained(a.base).tokenizer
    model = AutoModelForCausalLM.from_pretrained(a.base, dtype=dtype)
    if cuda:
        model = model.to("cuda")
    # 言葉の層だけに。名前に vision・audio を含む層には付けない。
    names = sorted({n for n, mod in model.named_modules()
                    if n.split(".")[-1] in TARGETS and not any(x in n for x in ("vision", "audio"))
                    and hasattr(mod, "weight")})
    if not names:
        raise SystemExit("LoRA を付ける層が見つかりません（q_proj などの名前が違うモデル）")
    cfg = LoraConfig(r=a.r, lora_alpha=a.alpha, lora_dropout=a.dropout, bias="none",
                     target_modules=names, task_type="CAUSAL_LM")
    model = get_peft_model(model, cfg)
    return model, tok


def make_codec(tok):
    """チャットの型で文字にする関数と、トークンにする関数。"""
    def render(messages, add_generation_prompt):
        return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=add_generation_prompt)

    def encode(text):
        # 型の文字列には <bos> が入っているので、もう一度は足さない。
        return tok(text, add_special_tokens=False)["input_ids"]
    return render, encode


class Rows:
    """Trainer に渡す、ただのリスト。"""
    def __init__(self, items):
        self.items = items

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        return self.items[i]


def main(argv=None):
    a = parse(argv)
    import torch
    from transformers import Trainer, TrainerCallback, TrainingArguments, set_seed
    set_seed(a.seed)
    backend = pick_backend(a.backend)
    train_path = os.path.join(a.data, "train.jsonl")
    eval_path = os.path.join(a.data, "eval.jsonl")
    if not os.path.exists(train_path):
        raise SystemExit(f"{train_path} がありません。先に node tools/export_training_data.mjs を")
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    print(f"元のモデル {a.base}（{backend}）")
    model, tok = (load_unsloth if backend == "unsloth" else load_peft)(a)
    render, encode = make_codec(tok)

    train_rows = F.load_jsonl(train_path, a.limit)
    eval_rows = F.load_jsonl(eval_path, a.eval_limit) if os.path.exists(eval_path) else []
    train, skip_t = F.build_dataset(train_rows, render, encode, a.max_len)
    evals, skip_e = F.build_dataset(eval_rows, render, encode, a.max_len)
    if not train:
        raise SystemExit("学習に使える行がありません（チャットの型と合わない？）")
    print(f"学習 {len(train)}件（外した {skip_t}）・確かめ {len(evals)}件（外した {skip_e}）")
    pad = tok.pad_token_id if tok.pad_token_id is not None else (tok.eos_token_id or 0)

    def collate(batch):
        b = F.collate(batch, pad)
        return {k: torch.tensor(v) for k, v in b.items()}

    losses = []

    class Log(TrainerCallback):
        def on_log(self, args, state, control, logs=None, **kw):
            if logs:
                losses.append({"step": state.global_step, **{k: v for k, v in logs.items()
                                                             if isinstance(v, (int, float))}})

    cuda = torch.cuda.is_available()
    bf16 = cuda and torch.cuda.is_bf16_supported()
    args = TrainingArguments(
        output_dir=os.path.join(a.out, "checkpoints"),
        per_device_train_batch_size=a.batch, per_device_eval_batch_size=a.batch,
        gradient_accumulation_steps=a.grad_accum, learning_rate=a.lr,
        num_train_epochs=a.epochs, max_steps=a.max_steps,
        warmup_steps=5 if a.max_steps < 0 or a.max_steps > 20 else 0,
        lr_scheduler_type="linear", weight_decay=0.01, logging_steps=1,
        eval_strategy="epoch" if evals else "no", save_strategy="no",
        optim="adamw_8bit" if cuda and backend == "unsloth" else "adamw_torch",
        bf16=bf16, fp16=cuda and not bf16, seed=a.seed, report_to=[],
        remove_unused_columns=False, use_cpu=not cuda,
        gradient_checkpointing=cuda and backend == "peft",
    )
    trainer = Trainer(model=model, args=args, train_dataset=Rows(train),
                      eval_dataset=Rows(evals) if evals else None, data_collator=collate,
                      callbacks=[Log()])
    result = trainer.train()
    ev = trainer.evaluate() if evals else {}

    adapter = os.path.join(a.out, "adapter")
    model.save_pretrained(adapter)
    tok.save_pretrained(adapter)
    merged = None
    if not a.no_merge:
        merged = os.path.join(a.out, "merged")
        if backend == "unsloth":
            model.save_pretrained_merged(merged, tok, save_method="merged_16bit")
        else:
            m = model.merge_and_unload()
            m.save_pretrained(merged, safe_serialization=True)
            tok.save_pretrained(merged)
    gguf = None
    if a.gguf:
        if backend == "unsloth":
            gguf = os.path.join(a.out, "gguf")
            model.save_pretrained_gguf(gguf, tok, quantization_method=a.gguf)
        else:
            print("GGUF は Unsloth のときだけここで作ります。PEFT のときは training/to_gguf.sh を merged/ に")

    run = {
        "base": a.base, "backend": backend, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(t0)),
        "seconds": round(time.time() - t0, 1), "git": git_commit(),
        "device": torch.cuda.get_device_name(0) if cuda else "cpu",
        "lora": {"r": a.r, "alpha": a.alpha, "dropout": a.dropout},
        "train": {"lr": a.lr, "batch": a.batch, "grad_accum": a.grad_accum, "epochs": a.epochs,
                  "max_steps": a.max_steps, "max_len": a.max_len, "seed": a.seed, "load_4bit": a.load_4bit},
        "data": {"train": train_path, "train_sha256": F.file_sha256(train_path), "train_rows": len(train),
                 "train_skipped": skip_t, "eval_rows": len(evals), "eval_skipped": skip_e,
                 "eval_sha256": F.file_sha256(eval_path) if os.path.exists(eval_path) else None},
        "result": {"train_loss": result.training_loss, "eval_loss": ev.get("eval_loss"),
                   "steps": result.global_step,
                   "eval_perplexity": math.exp(ev["eval_loss"]) if ev.get("eval_loss") is not None
                   and ev["eval_loss"] < 50 else None},
        "outputs": {"adapter": adapter, "merged": merged, "gguf": gguf},
        "log": losses,
    }
    with open(os.path.join(a.out, "run.json"), "w", encoding="utf-8") as fp:
        json.dump(run, fp, ensure_ascii=False, indent=2)
    print(f"できました: {a.out}（{run['seconds']}秒、損失 {result.training_loss:.4f}"
          + (f"、確かめの損失 {ev['eval_loss']:.4f}" if ev.get("eval_loss") is not None else "") + "）")
    return run


if __name__ == "__main__":
    main()
