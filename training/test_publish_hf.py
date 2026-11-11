# -*- coding: utf-8 -*-
"""publish_hf.py の「上げてよいか」の試験（標準ライブラリだけ。上げはしません）。"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish_hf as P  # noqa: E402

OK_MANIFEST = {"options": {"groups": ["cc0", "project", "permissive"]},
               "counts": {"byLicense": {"CC0-1.0": 3}}}


def make_run(d, gate="合格（59問）", gguf=True):
    os.makedirs(os.path.join(d, "gguf"))
    if gguf:
        open(os.path.join(d, "gguf", "tabisaki-gemma-Q4_K_M.gguf"), "wb").write(b"GGUF")
        open(os.path.join(d, "gguf", "Modelfile"), "w").write("FROM ./x\n")
    if gate is not None:
        open(os.path.join(d, "gate.md"), "w", encoding="utf-8").write("| 点 |\n\n" + gate + "\n")
    json.dump({"base": "unsloth/gemma-4-E2B-it", "lora": {"r": 64, "alpha": 64}}, open(os.path.join(d, "run.json"), "w"))


class PublishTest(unittest.TestCase):
    def test_passes_only_with_gate_gguf_and_clean_sources(self):
        with tempfile.TemporaryDirectory() as d:
            make_run(d)
            self.assertEqual(P.check(d, OK_MANIFEST), [])
            bad = {"options": {"groups": ["cc0", "cc-by-sa", "kokudo-noncommercial"]}}
            self.assertTrue(any("Apache-2.0" in p for p in P.check(d, bad)))
            self.assertTrue(P.check(d, None))
            # 非商用のデータは、--noncommercial で非公開に限って上げられる
            self.assertEqual(P.check(d, bad, noncommercial=True), [])
            self.assertTrue(any("公開" in p for p in P.check(d, bad, noncommercial=True, public=True)))
            self.assertIn("license: other", P.card({}, bad, "合格", "a/b"))
            self.assertIn("license: apache-2.0", P.card({}, OK_MANIFEST, "合格", "a/b"))

    def test_failed_gate_or_missing_gguf_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            make_run(d, gate="不合格: unknown.refused が 0.5")
            self.assertTrue(P.check(d, OK_MANIFEST))
            self.assertEqual(P.check(d, OK_MANIFEST, force=True), [])
        with tempfile.TemporaryDirectory() as d:
            make_run(d, gate=None, gguf=False)
            self.assertEqual(len(P.check(d, OK_MANIFEST)), 2)

    def test_dry_run_builds_card_without_pushing(self):
        with tempfile.TemporaryDirectory() as d:
            make_run(d)
            man = os.path.join(d, "manifest.json")
            json.dump(OK_MANIFEST, open(man, "w"))
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = P.main([d, "--repo", "someone/tabisaki-gemma", "--manifest", man])
            self.assertEqual(code, 0)
            self.assertIn("見るだけ", buf.getvalue())
            readme = open(os.path.join(d, "hf", "README.md"), encoding="utf-8").read()
            self.assertIn("license: apache-2.0", readme)
            self.assertIn("r=64", readme)
            self.assertTrue(os.path.exists(os.path.join(d, "hf", "tabisaki-gemma-Q4_K_M.gguf")))


if __name__ == "__main__":
    unittest.main()
