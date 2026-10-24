#!/usr/bin/env python3
"""Actual PTY checks for codemode_o diff preview, reload and saved rendering."""
import argparse
import json
import pathlib
import shutil

from cross_host_tui import verify
from opencode_parity import OpenCodeHarness, REPO, oc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", type=pathlib.Path, required=True)
    parser.add_argument("--pig", type=pathlib.Path, required=True)
    parser.add_argument("--fused", type=pathlib.Path, required=True)
    parser.add_argument("--opencode", type=pathlib.Path, default=REPO / "node_modules/pi-opencode-mode/index.js")
    parser.add_argument("--opencode-first", action="store_true")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    for name in ("pi", "pig", "fused", "opencode"):
        setattr(args, name, getattr(args, name).resolve(strict=True))
    h = OpenCodeHarness(args)
    try:
        results = [verify(h, mode, code_tool=oc) for mode in ["pi-typescript", "pig-typescript", "pig-source", "pig-fused"]]
        (h.root / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        print("Evidence:", h.root)
    finally:
        h.close()


if __name__ == "__main__":
    main()
