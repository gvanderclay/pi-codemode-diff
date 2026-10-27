#!/usr/bin/env python3
"""Drive the real Pi binary in tmux: the codemode card must show the proposal while a gate prompt waits.

Scripted local model only (no network model calls). Usage:
  python3 test/pty/preapproval_tui.py --pi /path/to/pi-coding-agent/dist/bundle/cli.js --output /tmp/new-empty-dir
"""
import argparse
import http.server
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import tempfile
import threading
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
SOCKET = "pi-codemode-diff-preapproval"
CODE = "\n".join([
    'try { await tools.edit({ path: "target.txt", edits: [{ oldText: "alpha", newText: "beta" }] }); } catch { text("first blocked"); }',
    'await tools.edit({ path: "target.txt", edits: [{ oldText: "alpha", newText: "gamma" }] });',
])


class Model:
    def __init__(self):
        self.requests = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append(body)
                if len(owner.requests) == 1:
                    call = {"index": 0, "id": "root", "type": "function", "function": {"name": "codemode", "arguments": json.dumps({"code": CODE})}}
                    delta, finish = {"role": "assistant", "tool_calls": [call]}, "tool_calls"
                else:
                    delta, finish = {"role": "assistant", "content": "SCRIPTED_DONE"}, "stop"
                chunks = [
                    {"id": "x", "object": "chat.completion.chunk", "created": 1, "model": "verify", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {"id": "x", "object": "chat.completion.chunk", "created": 1, "model": "verify", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
                ]
                payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def tmux(*args):
    return subprocess.run(["tmux", "-L", SOCKET, *args], check=True, capture_output=True, text=True).stdout


def screen():
    return tmux("capture-pane", "-p", "-J", "-t", "pi", "-S", "-200")


def wait(predicate, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        text = screen()
        if predicate(text):
            return text
        if "PI EXITED" in text:
            break
        time.sleep(0.2)
    raise AssertionError(label + ": failed\n" + screen())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path(tempfile.mkdtemp(prefix="pi-preapproval-tui-")))
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--permission-system", type=pathlib.Path,
                        help="Use this pi-permission-system package (with an edit ask rule) instead of the test select gate")
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise SystemExit("Use a new empty --output directory")
    work, agent, home = out / "workspace", out / "agent", out / "home"
    for path in (work, agent, home):
        path.mkdir()
    target = work / "target.txt"
    target.write_text("alpha\n")
    model = Model()
    (agent / "models.json").write_text(json.dumps({"providers": {"local": {"api": "openai-completions", "baseUrl": f"http://127.0.0.1:{model.server.server_port}/v1", "apiKey": "placeholder", "models": [{"id": "verify", "name": "Local scripted", "reasoning": False, "input": ["text"], "contextWindow": 100000, "maxTokens": 4096}]}}}))
    gate = str(REPO / "test/pty/select-gate.ts")
    # Keys: [block, allow]. The select gate highlights Allow first.
    marker, block_keys, allow_keys = "TEST GATE", ["Down", "Enter"], ["Enter"]
    if args.permission_system:
        gate = str(args.permission_system.resolve())
        config = agent / "extensions" / "pi-permission-system"
        config.mkdir(parents=True)
        (config / "config.json").write_text(json.dumps({
            "doublePressToConfirm": False, "permissionReviewLog": False,
            "permission": {"*": "allow", "path": {"*": "allow"}, "external_directory": "allow", "edit": "ask"},
        }))
        # Options: (y) Yes, (s) Yes for this session, (n) No, (r) No with reason.
        marker, block_keys, allow_keys = "Permission Required", ["Down", "Down", "Enter"], ["Enter"]
    (agent / "settings.json").write_text(json.dumps({"compaction": {"enabled": False}, "retry": {"enabled": False}, "cacheWarming": "off", "quietStartup": True}))
    env = {"HOME": str(home), "PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "TERM": "xterm-256color", "PATH": os.environ["PATH"]}
    cmd = [shutil.which("node"), str(args.pi), "--offline", "--no-extensions", "-e", "builtin:codemode",
           "-e", str(REPO / "src/index.ts"), "-e", gate,
           "--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read,edit,write,codemode",
           "--model", "local/verify", "--session-dir", str(out / "sessions"), "Run the scripted check."]
    envs = [f"{k}={v}" for k, v in env.items()]
    subprocess.run(["tmux", "-L", SOCKET, "kill-server"], capture_output=True)
    # Keep the pane after an unexpected exit so its error is captured as evidence.
    shell = shlex.join(["env", "-i", *envs, *cmd]) + '; echo "PI EXITED $?"; sleep 600'
    tmux("new-session", "-d", "-s", "pi", "-x", str(args.cols), "-y", str(args.rows), "-c", str(work), "sh", "-c", shell)
    evidence = {}
    try:
        s = wait(lambda s: marker in s and "Proposed changes (1)" in s, "first gate with proposal")
        evidence["1-first-gate-waiting"] = s
        assert "- alpha" in s and "+ beta" in s, s
        assert "File changes" not in s, s
        assert target.read_text() == "alpha\n"
        tmux("send-keys", "-t", "pi", "C-o")
        time.sleep(0.5)
        evidence["2-first-gate-expanded"] = wait(lambda s: marker in s and "+ beta" in s, "expanded while waiting")
        tmux("send-keys", "-t", "pi", "C-o")
        time.sleep(0.5)
        for key in block_keys:
            tmux("send-keys", "-t", "pi", key)
            time.sleep(0.3)
        s = wait(lambda s: marker in s and "Did not complete" in s and "+ gamma" in s, "second gate after block")
        evidence["3-second-gate-after-block"] = s
        assert target.read_text() == "alpha\n"
        for key in allow_keys:
            tmux("send-keys", "-t", "pi", key)
            time.sleep(0.3)
        s = wait(lambda s: "SCRIPTED_DONE" in s and "File changes (1)" in s, "completed after allow")
        evidence["4-completed-after-allow"] = s
        assert "Proposed changes" not in s, s
        assert "+1 gamma" in s and "-1 alpha" in s, s
        assert target.read_text() == "gamma\n"
    finally:
        try:
            evidence["final"] = screen()
        except Exception:
            pass
        subprocess.run(["tmux", "-L", SOCKET, "kill-server"], capture_output=True)
        model.server.shutdown()
        for name, text in evidence.items():
            (out / f"{name}.txt").write_text(text)
    sessions = list((out / "sessions").rglob("*.jsonl"))
    saved = sessions[0].read_text()
    assert "unverified" not in saved and "Proposed changes" not in saved
    print("PASS: proposal visible while gate waited; block left file unchanged; allow applied and showed the real diff. Evidence:", out)


if __name__ == "__main__":
    main()
