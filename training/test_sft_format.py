# -*- coding: utf-8 -*-
"""sft_format.py の試験（標準ライブラリだけ）。  python3 -m unittest training/test_sft_format.py"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sft_format as F  # noqa: E402

ROLE = {"system": "system", "user": "user", "assistant": "model"}


def render(messages, add_generation_prompt):
    """Gemma 4 と同じ形のチャットの型（<bos><|turn>user\\n…<turn|>\\n<|turn>model\\n…）。"""
    s = "<bos>" + "".join(f"<|turn>{ROLE[m['role']]}\n{m['content']}<turn|>\n" for m in messages)
    return s + ("<|turn>model\n" if add_generation_prompt else "")


def encode(text):
    return [ord(c) for c in text]


def decode(ids):
    return "".join(chr(i) for i in ids)


class FormatTest(unittest.TestCase):
    def test_only_answers_are_learned(self):
        msgs = [{"role": "system", "content": "S"}, {"role": "user", "content": "質問"},
                {"role": "assistant", "content": "答え"}]
        ex = F.build_example(msgs, render, encode)
        learned = decode([t for t, l in zip(ex["input_ids"], ex["labels"]) if l != F.IGNORE])
        self.assertEqual(learned, "答え<turn|>\n")
        self.assertEqual(len(ex["input_ids"]), len(ex["labels"]))

    def test_every_answer_in_a_multi_turn_chat(self):
        msgs = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "B"},
                {"role": "user", "content": "c"}, {"role": "assistant", "content": "D"}]
        ex = F.build_example(msgs, render, encode)
        learned = decode([t for t, l in zip(ex["input_ids"], ex["labels"]) if l != F.IGNORE])
        self.assertEqual(learned, "B<turn|>\nD<turn|>\n")

    def test_truncation_keeps_lengths_and_drops_empty(self):
        msgs = [{"role": "user", "content": "x" * 50}, {"role": "assistant", "content": "y"}]
        self.assertIsNone(F.build_example(msgs, render, encode, max_len=20))
        ex = F.build_example(msgs, render, encode, max_len=200)
        self.assertEqual(len(ex["input_ids"]), len(ex["labels"]))

    def test_inconsistent_template_is_skipped(self):
        def odd(messages, add_generation_prompt):  # 途中までを描くと、頭が変わってしまう型
            return ("#" * len(messages)) + render(messages, add_generation_prompt)
        msgs = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
        rows = [{"messages": msgs}]
        data, skipped = F.build_dataset(rows, odd, encode)
        self.assertEqual((len(data), skipped), (0, 1))

    def test_load_jsonl_keeps_only_valid_rows(self):
        lines = [
            {"messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]},
            {"messages": [{"role": "user", "content": "q"}]},
            {"messages": [{"role": "robot", "content": "q"}, {"role": "assistant", "content": "a"}]},
            {"nope": 1},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as fp:
            for x in lines:
                fp.write(json.dumps(x, ensure_ascii=False) + "\n")
            fp.write("\n")
        try:
            self.assertEqual(len(F.load_jsonl(fp.name)), 1)
            self.assertEqual(len(F.file_sha256(fp.name)), 64)
        finally:
            os.unlink(fp.name)

    def test_collate_pads_without_learning_padding(self):
        b = F.collate([{"input_ids": [1, 2, 3], "labels": [F.IGNORE, 2, 3]},
                       {"input_ids": [4], "labels": [4]}], pad_id=0)
        self.assertEqual(b["input_ids"][1], [4, 0, 0])
        self.assertEqual(b["labels"][1], [4, F.IGNORE, F.IGNORE])
        self.assertEqual(b["attention_mask"][1], [1, 0, 0])


if __name__ == "__main__":
    unittest.main()
