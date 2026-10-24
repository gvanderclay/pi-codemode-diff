#!/usr/bin/env python3
"""Offline codemode_o parity through real Pi, PiG TS, Go source and fused hosts.

The diff factory is native in Go modes; pi-opencode-mode itself remains a Node
extension. This suite intentionally does not make a Node-free execution claim.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

from cross_host import Harness, MODES, REPO, compare, cm


def oc(code):
    return ("codemode_o", {"code": code})


CASES = [
    ("nested", [oc('await tools.write({path:"file.txt",content:"before\\n"}); await tools.edit({path:"file.txt",edits:[{oldText:"before",newText:"after"}]}); await tools.write({path:"file.txt",content:"final\\n"}); return {status:"kept"};')], {}, 3, False),
    ("failed_script", [oc('await tools.write({path:"file.txt",content:"retained"}); throw new Error("intentional failure");')], {}, 1, True),
    ("failed_edit", [oc('await tools.edit({path:"file.txt",edits:[{oldText:"missing",newText:"bad"}]});')], {"file.txt": b"original"}, 0, True),
    ("read_only", [oc('return await tools.read({path:"file.txt"});')], {"file.txt": b"existing\n"}, 0, False),
    ("long", [oc('await tools.write({path:"file.txt",content:' + json.dumps("\n".join("line-" + str(i) for i in range(40))) + '}); return "long";')], {}, 1, False),
    ("old_budget", [oc('await tools.write({path:"file.txt",content:"small"});')], {"file.txt": b"x" * 262145}, 1, False),
    ("binary", [oc('await tools.write({path:"file.txt",content:"text\\n"});')], {"file.txt": b"old\x00binary"}, 1, False),
    ("invalid_utf8", [oc('await tools.write({path:"file.txt",content:"text\\n"});')], {"file.txt": b"\xff\xfe"}, 1, False),
    ("normalization", [oc('await tools.write({path:"file.txt",content:"same\\n"});')], {"file.txt": b"\xef\xbb\xbfsame\r\n"}, 1, False),
    ("empty", [oc('await tools.write({path:"file.txt",content:""});')], {}, 1, False),
    ("mixed", [cm('await tools.write({path:"a.txt",content:"native"});'), oc('await tools.write({path:"b.txt",content:"opencode"});')], {}, 2, False),
    ("blocked", [oc('await tools.write({path:"blocked.txt",content:"bad"});')], {}, 0, True),
    ("disabled", [oc('await tools.write({path:"disabled.txt",content:"bad"});')], {}, 0, True),
    ("late_error", [oc('await tools.write({path:"reject.txt",content:"observed"});')], {}, 1, True),
    ("helper", [oc('return await tools.helper({});')], {}, 1, False),
    ("native_required", [oc('text(1); await tools.write({path:"denied.txt",content:"bad"});')], {}, 0, True),
    ("queued_edits", [oc('await tools.write({path:"file.txt",content:"seed"}); await tools.edit({path:"file.txt",edits:[{oldText:"seed",newText:"base"}]}); await tools.write({path:"file.txt",content:"last"}); await tools.edit({path:"file.txt",edits:[{oldText:"last",newText:"edited"}]});')], {}, 4, False),
]


class OpenCodeHarness(Harness):
    def command(self, mode, name, run, session=None):
        cmd = super().command(mode, name, run, session)
        if mode == "pig-typescript":
            cmd[cmd.index(str(REPO / "src/index.ts"))] = str(REPO / "src/pig-index.ts")
        addition = ["-e", str(self.args.opencode)]
        if self.args.opencode_first:
            index = 2 if mode.startswith("pi-") else 1
            cmd[index:index] = addition
        else:
            cmd += addition
        index = cmd.index("--tools") + 1
        tools = cmd[index].split(",") + ["codemode_o"]
        if name == "disabled":
            tools.remove("write")
        cmd[index] = ",".join(tools)
        return cmd


def check_output(mode, name, output, calls, changes, is_error):
    assert len(output["parent_status"]) == len(calls), (mode, name, "missing parent")
    assert all(status == is_error for status in output["parent_status"].values()), (mode, name, "unexpected status", output["parent_status"])
    enabled = mode not in ("pi-control", "pig-control")
    items = [item for details in output["diffs"].values() for item in details["changes"]]
    assert len(items) == (changes if enabled else 0), (mode, name, "wrong diff count", items)
    for data in output["custom_entries"]:
        parent = int(data["toolCallId"].removeprefix("parity_"))
        assert data["toolName"] == calls[parent][0], (mode, name, "wrong saved parent tool name")
        assert data["piCodemodeDiff"] == output["diffs"][data["toolCallId"]]
    if name in ("blocked", "disabled", "native_required"):
        assert output["files"] == {}, (mode, name, "denied program mutated files")
    if enabled and name == "late_error":
        assert items[0]["toolReportedError"] is True
    if enabled and name == "old_budget":
        assert "diff" not in items[0] and "too large" in items[0]["note"]
    expected = {"nested": b"final\n", "failed_script": b"retained", "queued_edits": b"edited", "failed_edit": b"original"}
    if name in expected:
        assert output["files"]["file.txt"] == expected[name].hex()
    if enabled and name == "mixed":
        assert set(output["diffs"]) == {"parity_0", "parity_1"}
        assert [item["path"] for item in output["diffs"]["parity_0"]["changes"]] == ["a.txt"]
        assert [item["path"] for item in output["diffs"]["parity_1"]["changes"]] == ["b.txt"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", type=pathlib.Path, required=True, help="Pi CLI JavaScript entry")
    parser.add_argument("--pig", type=pathlib.Path, required=True)
    parser.add_argument("--fused", type=pathlib.Path, required=True)
    parser.add_argument("--opencode", type=pathlib.Path, default=REPO / "node_modules/pi-opencode-mode/index.js")
    parser.add_argument("--opencode-first", action="store_true", help="Load OpenCode before explicit diff extensions; fused factories are preloaded")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--only", help="Comma-separated case names")
    args = parser.parse_args()
    selected = [case for case in CASES if not args.only or case[0] in args.only.split(",")]
    if args.runs < 1 or not selected or (args.only and set(args.only.split(",")) - {case[0] for case in CASES}):
        parser.error("Use positive --runs and known case names")
    for name in ("pi", "pig", "fused", "opencode"):
        setattr(args, name, getattr(args, name).resolve(strict=True))
    h = OpenCodeHarness(args)
    summary = {"versions": {}, "cases": [], "scope": {"scenarios": [case[0] for case in selected], "runs": args.runs, "modes": MODES, "opencode_first": args.opencode_first, "external_model": False, "node_required_for_opencode": True}, "executables": {}}
    for name in ("pig", "fused"):
        summary["versions"][name] = subprocess.check_output([str(getattr(args, name)), "--version"], text=True).strip()
    summary["versions"]["pi"] = subprocess.check_output([args.node, str(args.pi), "--version"], text=True).strip()
    summary["versions"]["opencode"] = json.loads(args.opencode.with_name("package.json").read_text())["version"]
    for name in ("pi", "pig", "fused"):
        path = getattr(args, name)
        with path.open("rb") as file:
            summary["executables"][name] = {"sha256": hashlib.file_digest(file, "sha256").hexdigest()}
    try:
        for name, calls, files, changes, is_error in selected:
            for iteration in range(args.runs):
                outputs = {}
                for mode in MODES:
                    output, _ = h.run(mode, name, calls, files, iteration)
                    check_output(mode, name, output, calls, changes, is_error)
                    outputs[mode] = output
                row = {"case": name, "iteration": iteration, "cross_host": {}, "extension_effect": {}, "native_vs_pigts": {}}
                for mode in ("pig-typescript", "pig-source", "pig-fused"):
                    row["cross_host"][mode] = compare(outputs["pi-typescript"], outputs[mode], ["files", "parent_status", "model_results", "diffs"])
                    row["native_vs_pigts"][mode] = compare(outputs["pig-typescript"], outputs[mode], ["files", "parent_status", "model_results", "diffs", "custom_entries"])
                for mode in ("pi-typescript", "pig-typescript", "pig-source", "pig-fused"):
                    control = "pi-control" if mode.startswith("pi-") else "pig-control"
                    row["extension_effect"][mode] = compare(outputs[control], outputs[mode], ["files", "parent_status", "model_results"])
                summary["cases"].append(row)
                print(json.dumps(row), flush=True)
        summary["full_parity"] = all(not diff for row in summary["cases"] for dimension in ("cross_host", "extension_effect", "native_vs_pigts") for diff in row[dimension].values())
        print("FULL_PARITY", summary["full_parity"], "Evidence:", h.root, flush=True)
    except Exception as error:
        summary["full_parity"] = False
        summary["error"] = repr(error)
        raise
    finally:
        (h.root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        h.close()
    return 0 if summary["full_parity"] else 1


if __name__ == "__main__":
    sys.exit(main())
