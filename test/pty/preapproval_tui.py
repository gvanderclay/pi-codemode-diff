#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyte>=0.8"]
# ///
"""Actual PTY checks: the pre-approval proposal is shown while a real permission prompt waits.

PTY setup and draining shutdown follow native/tests/cross_host_tui.py, but the
output is fed to a pyte terminal emulator at the same window size and every
visibility check reads its CURRENT screen, not the byte transcript (kept only
as evidence). Needs only Pi and the permission package, not PiG. Offline: a
local scripted model answers; no network model calls. Run with uv, which
installs pyte from the inline metadata into a cached environment (plain
python3 works if pyte is importable):

  uv run test/pty/preapproval_tui.py \
    --pi <pi-coding-agent>/dist/bundle/cli.js \
    --permission-system <path to @gotgenes/pi-permission-system> \
    [--output <new empty dir>]
"""
import argparse
import fcntl
import hashlib
import http.server
import json
import os
import pathlib
import pty
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import threading
import time

try:
    import pyte
except ImportError:  # pragma: no cover - depends on how the script is launched
    raise SystemExit("This verifier needs the pyte terminal emulator. Run it with uv: uv run test/pty/preapproval_tui.py ...")

REPO = pathlib.Path(__file__).resolve().parents[2]
CTRL_O, DOWN, ENTER = b"\x0f", b"\x1b[B", b"\r"
# Built at run time so the marker never appears in the script text or call arguments.
MARKER = "PREVIEW-MARKER-"
UNVERIFIED = "Did not complete \u2014 changes not verified."
PROMPT = "Permission Required"


def display(screen):
    """The emulated terminal's current viewport, one line per row."""
    return "\n".join(line.rstrip() for line in screen.display)


def waiting_with_proposal(text, line):
    """Proposal header, a diff line and the live permission prompt share one screen."""
    return PROMPT in text and "Proposed changes (" in text and "[edit \u00b7 proposed]" in text and line in text


def self_test():
    """A proposal frame cleared before the prompt frame must not satisfy the check."""
    screen = pyte.Screen(120, 40)
    stream = pyte.ByteStream(screen)
    stream.feed("Proposed changes (1)\r\na [edit \u00b7 proposed] +1 -1\r\n+ line 1\r\n".encode())
    assert not waiting_with_proposal(display(screen), "+ line 1")
    stream.feed(("\r\n" + PROMPT + "\r\n").encode())
    assert waiting_with_proposal(display(screen), "+ line 1")
    stream.feed(("\x1b[2J\x1b[H" + PROMPT + "\r\n").encode())
    assert not waiting_with_proposal(display(screen), "+ line 1"), "cleared text must not count"
    print("self-test PASS: cleared frames do not satisfy screen checks")

# Each scenario: the edited path, a permission config whose ask decides it, and the gate's denial text.
SCENARIOS = {
    # A tool rule: every edit asks.
    "edit-tool-ask": ("target.txt", {"*": "allow", "path": {"*": "allow"}, "external_directory": "allow", "edit": "ask"}, "denied this 'edit' call"),
    # The originally reported case: a protected-path ask from the path gate.
    "protected-path-ask": ("protected/config.json", {"*": "allow", "path": {"*": "allow", "*protected/*": "ask"}, "external_directory": "allow"}, "denied this 'path' call for tool 'edit'"),
}


def script(path):
    lines = ", ".join(f'"line {i}"' for i in range(1, 15))
    return "\n".join([
        f"const lines = [{lines}, \"{MARKER[:8]}\" + \"{MARKER[8:]}\" + 15, \"line 16\"];",
        f'try {{ await tools.edit({{ path: "{path}", edits: [{{ oldText: "alpha", newText: lines.join("\\n") }}] }}); }} catch {{ text("first denied"); }}',
        f'await tools.edit({{ path: "{path}", edits: [{{ oldText: "alpha", newText: "gamma" }}] }});',
    ])


class Model:
    """OpenAI-compatible stream: one codemode call, then a final text turn."""

    def __init__(self):
        self.requests, self.code = [], ""
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                owner.requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                if len(owner.requests) == 1:
                    call = {"index": 0, "id": "root", "type": "function", "function": {"name": "codemode", "arguments": json.dumps({"code": owner.code})}}
                    delta, finish = {"role": "assistant", "tool_calls": [call]}, "tool_calls"
                else:
                    delta, finish = {"role": "assistant", "content": "SCRIPTED_DONE"}, "stop"
                chunks = [{"id": "x", "object": "chat.completion.chunk", "created": 1, "model": "verify", "choices": [{"index": 0, "delta": d, "finish_reason": f}]}
                          for d, f in ((delta, None), ({}, finish))]
                payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


def verify(args, model, root, name):
    path, permission, denial = SCENARIOS[name]
    run = root / name
    work, agent, home = run / "workspace", run / "agent", run / "home"
    for directory in (work, agent, home):
        directory.mkdir(parents=True)
    target = work / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("alpha\n")
    model.requests, model.code = [], script(path)
    (agent / "models.json").write_text(json.dumps({"providers": {"local": {"api": "openai-completions", "baseUrl": f"http://127.0.0.1:{model.server.server_port}/v1", "apiKey": "placeholder", "models": [{"id": "verify", "name": "Local scripted", "reasoning": False, "input": ["text"], "contextWindow": 100000, "maxTokens": 4096}]}}}))
    (agent / "settings.json").write_text(json.dumps({"compaction": {"enabled": False}, "retry": {"enabled": False}, "cacheWarming": "off", "quietStartup": True}))
    config = agent / "extensions" / "pi-permission-system"
    config.mkdir(parents=True)
    (config / "config.json").write_text(json.dumps({"doublePressToConfirm": False, "permissionReviewLog": False, "permission": permission}))
    env = os.environ.copy()
    env.update(HOME=str(home), PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", TERM="xterm-256color", COLORTERM="truecolor")
    cmd = [args.node, str(args.pi), "--offline", "--no-extensions", "-e", "builtin:codemode", "-e", str(REPO / "src/index.ts"),
           "-e", str(args.permission_system), "--no-skills", "--no-prompt-templates", "--no-context-files",
           "--tools", "read,edit,write,codemode", "--model", "local/verify", "--session-dir", str(run / "sessions"),
           "Run the scripted check."]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))
    transcript = bytearray()
    # Assertions read the emulated CURRENT screen; the transcript is evidence only.
    screen = pyte.Screen(args.cols, args.rows)
    stream = pyte.ByteStream(screen)

    def feed(chunk):
        transcript.extend(chunk)
        stream.feed(chunk)
        if b"\x1b[6n" in chunk:
            row, col = screen.cursor.y + 1, screen.cursor.x + 1
            os.write(master, f"\x1b[{row};{col}R".encode())

    def wait(process, predicate, label):
        """Poll until predicate(current screen) holds; fail with the screen it last saw."""
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], min(.2, max(0, deadline - time.monotonic())))
            if ready:
                try:
                    feed(os.read(master, 65536))
                except OSError:
                    pass
            text = display(screen)
            if predicate(text):
                return text
            if process.poll() is not None:
                raise AssertionError(f"{name}: {label}: Pi exited {process.returncode}\n--- current screen ---\n{display(screen)}")
        raise AssertionError(f"{name}: {label}: timed out\n--- current screen ---\n{display(screen)}")

    def settle(process, quiet=.5, limit=3):
        """Feed output until none arrives for `quiet` seconds (redraws done), at most `limit`."""
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], quiet)
            if not ready:
                return
            try:
                feed(os.read(master, 65536))
            except OSError:
                return

    def check(condition, label):
        if not condition:
            raise AssertionError(f"{name}: {label}\n--- current screen ---\n{display(screen)}")

    def send(process, *keys):
        for key in keys:
            os.write(master, key)
            time.sleep(.15)

    def stop(process):
        if process.poll() is None:
            os.write(master, b"\x04")
            # Keep draining: waiting without reading can block on a full PTY buffer (macOS).
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

    hidden = "+ " + MARKER + "15"
    checks = []
    process = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, cwd=work, env=env, start_new_session=True)
    try:
        s = wait(process, lambda s: waiting_with_proposal(s, "+ line 1"), "proposal and prompt on one screen")
        settle(process)
        s = display(screen)
        check(waiting_with_proposal(s, "+ line 1"), "proposal still on screen with the prompt after redraws settle")
        check(hidden not in s, "collapsed preview must hide the marker")
        check(target.read_text() == "alpha\n", "file unchanged while waiting")
        checks += ["proposal_and_prompt_on_screen", "file_unchanged_while_waiting", "marker_hidden_collapsed"]
        send(process, CTRL_O)
        wait(process, lambda s: hidden in s and PROMPT in s and "ctrl+o collapse" in s, "Ctrl+O shows the marker with the prompt on screen")
        settle(process)
        check(hidden in display(screen) and PROMPT in display(screen), "expanded screen keeps marker and prompt")
        checks.append("expand_while_waiting")
        send(process, CTRL_O)
        wait(process, lambda s: hidden not in s and waiting_with_proposal(s, "+ line 1"), "Ctrl+O collapses: marker gone, proposal and prompt on screen")
        settle(process)
        check(hidden not in display(screen) and waiting_with_proposal(display(screen), "+ line 1"), "collapsed screen after settling")
        check(target.read_text() == "alpha\n", "file unchanged after expand/collapse")
        checks.append("collapse_while_waiting")
        # Deny: options are (y) Yes, (s) Yes for this session, (n) No, (r) No with reason.
        send(process, DOWN, DOWN, ENTER)
        error = "Error: [pi-permission-system] The user " + denial
        wait(process, lambda s: UNVERIFIED in s and error in s and waiting_with_proposal(s, "+ gamma"), "deny: unverified + error line, next proposal and prompt on screen")
        settle(process)
        check(UNVERIFIED in display(screen) and error in display(screen), "unverified label and error stay on screen")
        check(target.read_text() == "alpha\n", "file unchanged after deny")
        checks += ["deny_unverified_with_error_on_screen", "file_unchanged_after_deny"]
        send(process, ENTER)
        wait(process, lambda s: "SCRIPTED_DONE" in s and "File changes (1)" in s and "+1 gamma" in s and "-1 alpha" in s and "Proposed changes" not in s and PROMPT not in s,
             "allow: real diff on screen, no proposal section")
        check(target.read_text() == "gamma\n", "file changed after allow")
        checks += ["allow_real_diff_on_screen", "no_proposal_after_completion", "file_changed_after_allow"]
    finally:
        stop(process)
        os.close(master)
        os.close(slave)
        (run / "live.log").write_bytes(transcript)
    sessions = list((run / "sessions").rglob("*.jsonl"))
    assert len(sessions) == 1
    entries = [json.loads(line) for line in sessions[0].read_text().splitlines()]
    details = [e["message"]["details"]["piCodemodeDiff"] for e in entries
               if e.get("message", {}).get("role") == "toolResult" and "piCodemodeDiff" in (e["message"].get("details") or {})]
    assert len(details) == 1 and details[0]["version"] == 1 and len(details[0]["changes"]) == 1, details
    saved = json.dumps(details)
    assert "unverified" not in saved and "Proposed" not in saved and MARKER not in saved, saved
    checks.append("saved_details_completed_only")
    print("PASS", name, ", ".join(checks), flush=True)
    return {"scenario": name, "edited_path": path, "permission": permission, "parent_diff_records": len(details), "checks": checks}


def version_of(distribution):
    from importlib.metadata import version as installed
    return installed(distribution)


def version(package_dir):
    return json.loads((package_dir / "package.json").read_text())["version"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pi", type=pathlib.Path, help="Pi's CLI .js entry (dist/bundle/cli.js)")
    parser.add_argument("--permission-system", type=pathlib.Path, help="@gotgenes/pi-permission-system package directory")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--self-test", action="store_true", help="Only check that screen predicates ignore cleared frames")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.pi or not args.permission_system:
        parser.error("--pi and --permission-system are required")
    args.pi = args.pi.resolve(strict=True)
    args.permission_system = args.permission_system.resolve(strict=True)
    if not args.pi.is_file() or not (args.permission_system / "package.json").is_file() or not args.node:
        raise SystemExit("--pi must be Pi's CLI file, --permission-system a package directory, and node must be on PATH")
    root = (args.output or pathlib.Path(tempfile.mkdtemp(prefix="pi-preapproval-tui-"))).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise SystemExit("Use a new empty --output directory to preserve previous evidence")
    pi_package = args.pi.parents[2]
    model = Model()
    try:
        results = {
            "host": {"pi": version(pi_package), "pi_cli_sha256": hashlib.sha256(args.pi.read_bytes()).hexdigest(),
                     "pi_permission_system": version(args.permission_system), "window": f"{args.cols}x{args.rows}",
                     "screen_checks": f"pyte {version_of('pyte')} emulated current screen"},
            "scenarios": [verify(args, model, root, name) for name in SCENARIOS],
        }
        (root / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        print("Evidence:", root)
    finally:
        model.close()


if __name__ == "__main__":
    main()
