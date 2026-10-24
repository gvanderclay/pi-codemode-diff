#!/usr/bin/env python3
"""Exercise inline Pi and custom-entry PiG diff UIs through actual PTYs."""
import argparse
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import struct
import subprocess
import termios
import time

from cross_host import Harness, ENTRY_TYPE, cm

ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")


def verify(h, mode, code_tool=cm):
    run = h.root / "tui" / mode
    run.mkdir(parents=True)
    if h.work.exists():
        shutil.rmtree(h.work)
    h.work.mkdir()
    cmd = h.command(mode, "tui", run) + ["--tui-mode", "regular"]
    env = h.environment(mode)
    env.update(TERM="xterm-256color", COLORTERM="truecolor")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 55, 120, 0, 0))
    transcript = bytearray()

    def wait(process, predicate, label, offset=0):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], min(.2, max(0, deadline-time.monotonic())))
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    chunk = b""
                transcript.extend(chunk)
                if b"\x1b[6n" in chunk:
                    os.write(master, b"\x1b[1;1R")
            text = ANSI.sub("", bytes(transcript[offset:]).decode("utf8", errors="replace"))
            if predicate(text):
                return text
            if process.poll() is not None:
                raise AssertionError((mode, label, "exit", process.returncode, text[-2500:]))
        raise AssertionError((mode, label, "timeout", text[-2500:]))

    def stop(process):
        if process.poll() is None:
            os.write(master, b"\x04")
            # Keep draining terminal cleanup output: waiting without reading can
            # block a host on a full PTY buffer, particularly on macOS.
            for stage in range(3):
                deadline = time.monotonic() + 5
                while process.poll() is None and time.monotonic() < deadline:
                    ready, _, _ = select.select([master], [], [], .1)
                    if ready:
                        try:
                            transcript.extend(os.read(master, 65536))
                        except OSError:
                            break
                if process.poll() is not None:
                    break
                if stage == 0:
                    process.terminate()
                else:
                    process.kill()
            process.wait(timeout=5)

    h.calls = [code_tool('await tools.write({path:"long.txt",content:' + json.dumps("\n".join("line-" + str(i) for i in range(40))) + '});')]
    h.requests, h.error = [], None
    process = subprocess.Popen(cmd + ["Run the scripted UI verification."], stdin=slave, stdout=slave, stderr=slave, cwd=h.work, env=env, start_new_session=True)
    try:
        collapsed = wait(process, lambda s: "File changes (1)" in s and "more lines" in s and "PARITY_DONE" in s and len(h.requests) == 2, "collapsed diff and completed turn")
        assert "+40 line-39" not in collapsed
        offset = len(transcript)
        os.write(master, b"\x0f")
        wait(process, lambda s: "line-39" in s, "Ctrl+O expansion", offset)
        offset = len(transcript)
        os.write(master, b"\x0f")
        wait(process, lambda s: "more lines" in s, "Ctrl+O collapse", offset)
        offset = len(transcript)
        os.write(master, b"/reload\r")
        wait(process, lambda s: "reloaded" in s.lower(), "reload", offset)
        h.calls = [code_tool('await tools.write({path:"after-reload.txt",content:"after reload"});')]
        h.requests = []
        offset = len(transcript)
        os.write(master, b"Run the fixture after reload\r")
        wait(process, lambda s: "File changes (1)" in s and "after-reload.txt" in s and "PARITY_DONE" in s and len(h.requests) == 2, "diff after reload and completed turn", offset)
        assert (h.work / "after-reload.txt").read_text() == "after reload"
        assert len(h.requests) == 2 and h.error is None
    finally:
        stop(process)
        (run / "live.log").write_bytes(transcript)
        (run / "last-requests.json").write_text(json.dumps(h.requests, indent=2))
    sessions = list((run / "sessions").rglob("*.jsonl"))
    assert len(sessions) == 1
    entries = [json.loads(line) for line in sessions[0].read_text().splitlines()]
    custom = [e for e in entries if e.get("customType") == ENTRY_TYPE]
    expected = 0 if mode.startswith("pi-") else 2
    assert len(custom) == expected, (mode, len(custom), expected)
    for entry in custom:
        assert entry["data"].get("toolName", "codemode") == code_tool("")[0]
    metadata = [e["message"]["details"]["piCodemodeDiff"] for e in entries if e.get("message", {}).get("role") == "toolResult" and "piCodemodeDiff" in (e["message"].get("details") or {})]
    assert len(metadata) == 2
    transcript.clear()
    process = subprocess.Popen(cmd + ["--session", str(sessions[0])], stdin=slave, stdout=slave, stderr=slave, cwd=h.work, env=env, start_new_session=True)
    try:
        wait(process, lambda s: "File changes (1)" in s and "after-reload.txt" in s, "restored entry")
        offset = len(transcript)
        os.write(master, b"\x0f")
        wait(process, lambda s: "line-39" in s, "restored expansion", offset)
    finally:
        stop(process)
        (run / "resume.log").write_bytes(transcript)
        os.close(master)
        os.close(slave)
    print("PASS", mode, "preview, expansion, collapse, reload, further write, resume", flush=True)
    return {"mode": mode, "custom_entries": len(custom), "parent_diff_records": len(metadata), "presentation": "inline" if mode.startswith("pi-") else "completed custom entry", "checks": ["preview", "expand", "collapse", "reload", "write_after_reload", "resume", "expand_after_resume"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", type=pathlib.Path, required=True)
    parser.add_argument("--pig", type=pathlib.Path, required=True)
    parser.add_argument("--fused", type=pathlib.Path, required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--pig-typescript-entry", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    args.pi, args.pig, args.fused = args.pi.resolve(), args.pig.resolve(), args.fused.resolve()
    h = Harness(args)
    try:
        results = [verify(h, mode) for mode in ["pi-typescript", "pig-typescript", "pig-source", "pig-fused"]]
        (h.root / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        print("Evidence:", h.root)
    finally:
        h.close()


if __name__ == "__main__":
    main()
