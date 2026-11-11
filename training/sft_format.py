# -*- coding: utf-8 -*-
"""学習データ（messages の JSONL）を、モデルに渡す形に直す部品（Issue #434）。

torch も transformers も使いません（GPU の無い機械でも、単体で試せるように）。

- 1行 = {"messages": [{"role": "user"|"assistant"|"system", "content": "..."}], "meta": {...}}
  （tools/export_training_data.mjs が書く形。TRL・Unsloth もそのまま読めます）
- 学ばせるのは**答え（assistant）の部分だけ**です。質問とシステムの文は、損失の計算から外します
  （labels を -100 にする）。外さないと、質問の言い回しまで覚えて、答えの質が落ちます

答えの範囲は、チャットの型（chat template）で「答えの手前まで」と「答えまで」を2回描いて、
その差で決めます。Gemma 4 の `<|turn>model` のような目印を決め打ちしないので、型が変わっても使えます。
"""
import hashlib
import json

IGNORE = -100


def load_jsonl(path, limit=0):
    rows = []
    with open(path, encoding="utf-8") as fp:
        for line in fp:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if valid(row):
                rows.append(row)
            if limit and len(rows) >= limit:
                break
    return rows


def valid(row):
    """messages があり、答え（assistant）を1つ以上含み、最後が答えで終わるか。"""
    msgs = row.get("messages") if isinstance(row, dict) else None
    if not isinstance(msgs, list) or not msgs:
        return False
    if any(not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant")
           or not isinstance(m.get("content"), str) for m in msgs):
        return False
    return msgs[-1]["role"] == "assistant"


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_example(messages, render, encode, max_len=2048):
    """1つの会話を {input_ids, labels} にします。合わなければ None。

    render(messages, add_generation_prompt) -> str   チャットの型で文字にする
    encode(text) -> list[int]                         文字をトークンにする（先頭の <bos> も含めて）
    """
    ids = encode(render(messages, False))
    labels = [IGNORE] * len(ids)
    for i, m in enumerate(messages):
        if m["role"] != "assistant":
            continue
        prompt = encode(render(messages[:i], True))
        upto = encode(render(messages[:i + 1], False))
        start = len(prompt)
        # 「答えの手前まで」⊂「答えまで」⊂「全体」の頭どうしが一致しないなら、範囲を決められません。
        if start > len(upto) or upto[:start] != prompt or ids[:len(upto)] != upto:
            return None
        labels[start:len(upto)] = upto[start:]
    ids, labels = ids[:max_len], labels[:max_len]
    if all(x == IGNORE for x in labels):
        return None
    return {"input_ids": ids, "labels": labels}


def build_dataset(rows, render, encode, max_len=2048):
    """全部の行を直します。直せなかった数も返します。"""
    out, skipped = [], 0
    for row in rows:
        ex = build_example(row["messages"], render, encode, max_len)
        if ex is None:
            skipped += 1
        else:
            out.append(ex)
    return out, skipped


def collate(batch, pad_id):
    """長さをそろえます（右に詰め物。詰め物は学ばせない）。"""
    n = max(len(b["input_ids"]) for b in batch)
    ids = [b["input_ids"] + [pad_id] * (n - len(b["input_ids"])) for b in batch]
    labels = [b["labels"] + [IGNORE] * (n - len(b["labels"])) for b in batch]
    mask = [[1] * len(b["input_ids"]) + [0] * (n - len(b["input_ids"])) for b in batch]
    return {"input_ids": ids, "labels": labels, "attention_mask": mask}
