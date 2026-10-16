#!/usr/bin/env python3
"""Compare the real TypeScript, Go source, and fused PiG execution paths.

Uses a local scripted OpenAI endpoint; no external model credentials are needed.
Run from any directory with --pig /path/to/pig and --fused /path/to/binary.
"""
import argparse
import http.server
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import threading

REPO = pathlib.Path(__file__).resolve().parents[2]
PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument("--pig", default="pig")
PARSER.add_argument("--fused", required=True)
PARSER.add_argument("--output", type=pathlib.Path)
ARGS = PARSER.parse_args()
ARGS.pig = shutil.which(ARGS.pig) or ARGS.pig
ARGS.fused = str(pathlib.Path(ARGS.fused).resolve())
ROOT = ARGS.output or pathlib.Path(tempfile.mkdtemp(prefix="codemode-native-"))
ROOT.mkdir(parents=True, exist_ok=True)
STATE = {"calls": [], "requests": []}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        STATE["requests"].append(body)
        if len(STATE["requests"]) == 1:
            available = {(t.get("function") or t.get("custom"))["name"]: t for t in body["tools"]}
            calls = []
            for index, (name, arguments) in enumerate(STATE["calls"]):
                tool = available[name]
                if tool["type"] == "custom":
                    call = {"type": "custom", "custom": {"name": name, "input": arguments["code"]}}
                else:
                    call = {"type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}
                calls.append({"index": index, "id": STATE.get("prefix", "verify") + "_" + str(index), **call})
            delta, finish = {"role": "assistant", "tool_calls": calls}, "tool_calls"
        else:
            delta, finish = {"role": "assistant", "content": "VERIFICATION_DONE"}, "stop"
        chunks = [{"id": "verify", "object": "chat.completion.chunk", "created": 1, "model": "verify", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                  {"id": "verify", "object": "chat.completion.chunk", "created": 1, "model": "verify", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}]
        payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def codemode(code):
    return ("codemode", {"code": code})


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if k not in ("elapsedMs", "durationMs")}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, str):
        return re.sub(r"Wall time:? [0-9.]+ seconds", "Wall time <elapsed> seconds", value)
    return value


SCENARIOS = [
    ("direct", [("write", {"path": "direct.txt", "content": "direct\n"})], {}),
    ("nested", [codemode('await tools.write({path:"nested.txt",content:"before\\n"}); await tools.edit({path:"nested.txt",oldText:"before",newText:"after"}); await tools.write({path:"nested.txt",content:"final\\n"}); text("NESTED_OK");')], {}),
    ("error_after_write", [codemode('await tools.write({path:"observed.txt",content:"saved\\n"}); throw new Error("intentional verification failure");')], {}),
    ("failed_edit", [codemode('await tools.edit({path:"missing.txt",oldText:"before",newText:"after"});')], {}),
    ("read_only", [codemode('await tools.read({path:"existing.txt"}); text("READ_OK");')], {"existing.txt": b"existing\n"}),
    ("long", [codemode('await tools.write({path:"long.txt",content:Array.from({length:40},(_,i)=>"line-"+i).join("\\n")});')], {}),
    ("oversized", [codemode('await tools.write({path:"large.txt",content:"x".repeat(262145)});')], {}),
    ("binary", [codemode('await tools.write({path:"binary.txt",content:"now text\\n"});')], {"binary.txt": b"old\x00binary"}),
    ("invalid_utf8", [codemode('await tools.write({path:"invalid.txt",content:"now text\\n"});')], {"invalid.txt": b"\xff\xfe"}),
    ("normalization", [codemode('await tools.write({path:"crlf.txt",content:"same\\n"});')], {"crlf.txt": b"\xef\xbb\xbfsame\r\n"}),
    ("empty", [codemode('await tools.write({path:"empty.txt",content:""});')], {}),
    ("parallel_parents", [codemode('await tools.write({path:"a.txt",content:"parent A"});'), codemode('await tools.write({path:"b.txt",content:"parent B"});')], {}),
    ("parallel_aliases", [codemode('await Promise.all(Array.from({length:12},(_,i)=>tools.write({path:i%2?"alias.txt":"real.txt",content:"value-"+i+"\\n"})));')], {"real.txt": b"initial\n"}),
    ("blocked", [codemode('await tools.write({path:"blocked.txt",content:"must not be written"});')], {}),
    ("late_error", [codemode('await tools.write({path:"reject.txt",content:"observed change"});')], {}),
    ("helper", [codemode('await tools.helper({});')], {}),
    ("rewritten_path", [codemode('await tools.write({path:"redirect.txt",content:"redirected"});')], {}),
]


def execute(mode, name, calls, files, server, session=None):
    run = ROOT / mode / name
    work = run / "work"
    work.mkdir(parents=True, exist_ok=True)
    for path, data in files.items():
        (work / path).write_bytes(data)
    if name == "parallel_aliases":
        (work / "alias.txt").symlink_to("real.txt")
    home = ROOT / mode / "home"
    agent = home / "pig" / "agent"
    agent.mkdir(parents=True, exist_ok=True)
    (agent / "models.json").write_text(json.dumps({"providers": {"verify-local": {"api": "openai-completions", "baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "apiKey": "local-verification-placeholder", "models": [{"id": "verify", "name": "Local verification", "reasoning": False, "input": ["text"], "contextWindow": 32000, "maxTokens": 4096}]}}}))
    env = os.environ.copy()
    env.update(HOME=str(home), PIG_HOME=str(home / "pig"), PI_HOME=str(home / "pi"), PIG_CODING_AGENT_DIR=str(agent), PI_CODING_AGENT_DIR=str(home / "pi" / "agent"), PIG_OFFLINE="1", PIG_QUIET_STARTUP="1", PI_SKIP_VERSION_CHECK="1")
    if mode != "typescript":
        # Exercise both Go modes with no Node executable available to the host.
        env["PATH"] = str(pathlib.Path(shutil.which("go")).parent) + ":/usr/bin:/bin"
        assert shutil.which("node", path=env["PATH"]) is None, "Use a verification PATH without Node"
    binary = ARGS.fused if mode == "fused" else ARGS.pig
    cmd = [binary, "--offline", "--no-extensions", "-e", "builtin:codemode"]
    if mode != "fused":
        cmd += ["-e", str(REPO / ("src/index.ts" if mode == "typescript" else "native/pig"))]
    if name in ("blocked", "late_error", "helper", "rewritten_path"):
        cmd += ["-e", str(REPO / "native/tests/probe")]
    tools = "read,edit,write,codemode" + (",helper" if name == "helper" else "")
    cmd += ["--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", tools, "--model", "verify-local/verify", "--session-dir", str(run / "sessions"), "--mode", "json", "--print", "Run the scripted verification."]
    if session:
        cmd += ["--session", str(session)]
    STATE.update(calls=calls, requests=[])
    result = subprocess.run(cmd, cwd=work, env=env, text=True, capture_output=True, timeout=90)
    (run / "stdout.jsonl").write_text(result.stdout)
    (run / "stderr.log").write_text(result.stderr)
    (run / "requests.json").write_text(json.dumps(STATE["requests"], indent=2))
    assert result.returncode == 0, (mode, name, result.stderr, result.stdout[-2000:])
    assert len(STATE["requests"]) == 2, (mode, name, "model did not complete", result.stdout[-2000:])
    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    ends = [e for e in events if e.get("type") == "tool_execution_end" and not e.get("parentToolCallId")]
    sessions = list((run / "sessions").rglob("*.jsonl")) if not session else [session]
    assert len(sessions) == 1, (mode, name, sessions)
    entries = [json.loads(line) for line in sessions[0].read_text().splitlines()]
    custom = [e for e in entries if e.get("customType") == "pi-codemode-diff:pig"]
    request = json.dumps(STATE["requests"][1])
    assert "pi-codemode-diff:pig" not in request and "piCodemodeDiff" not in request
    assert not result.stderr.strip(), (mode, name, result.stderr)
    # Independent concurrent calls may complete in either order. Match results
    # by call ID; each parent's diff array must still preserve call-start order.
    output = {"files": {p.name: p.read_bytes().hex() for p in work.iterdir()}, "results": clean(sorted([{k: e[k] for k in ("toolCallId", "toolName", "result", "isError") if k in e} for e in ends], key=lambda e: e["toolCallId"])), "entries": sorted([e["data"] for e in custom], key=lambda e: e["toolCallId"])}
    # Elapsed times embedded in codemode call status use a separate seconds field.
    (run / "comparison.json").write_text(json.dumps(output, indent=2))
    if name == "nested":
        assert (work / "nested.txt").read_bytes() == b"final\n"
        assert [c["tool"] for c in custom[0]["data"]["piCodemodeDiff"]["changes"]] == ["write", "edit", "write"]
    if name == "parallel_aliases":
        assert (work / "real.txt").read_bytes() == b"value-11\n", (mode, "write admission reordered")
        changes = custom[0]["data"]["piCodemodeDiff"]["changes"]
        assert len(changes) == 12
        for i, change in enumerate(changes):
            assert f"value-{i}" in change["diff"], (mode, i, change)
            assert ("initial" if i == 0 else f"value-{i-1}") in change["diff"], (mode, "stale snapshot", i, change)
    if name == "blocked":
        assert not (work / "blocked.txt").exists() and not custom
    if name == "late_error":
        assert (work / "reject.txt").read_text() == "observed change"
        assert custom[0]["data"]["piCodemodeDiff"]["changes"][0]["toolReportedError"]
    if name == "helper":
        assert (work / "helper.txt").read_text() == "deeper descendant"
    if name == "rewritten_path":
        assert (work / "redirected.txt").read_text() == "redirected" and not (work / "redirect.txt").exists()
    return output, sessions[0]


def verify_tui(mode, server):
    import fcntl
    import pty
    import select
    import struct
    import termios
    import time

    run = ROOT / mode / "tui"
    work = run / "work"
    work.mkdir(parents=True)
    home = ROOT / mode / "home"
    env = os.environ.copy()
    env.update(HOME=str(home), PIG_HOME=str(home / "pig"), PI_HOME=str(home / "pi"), PIG_CODING_AGENT_DIR=str(home / "pig/agent"), PI_CODING_AGENT_DIR=str(home / "pi/agent"), PIG_OFFLINE="1", PIG_QUIET_STARTUP="1", TERM="xterm-256color", COLORTERM="truecolor")
    env["PATH"] = str(pathlib.Path(shutil.which("go")).parent) + ":/usr/bin:/bin"
    assert shutil.which("node", path=env["PATH"]) is None
    cmd = [ARGS.fused if mode == "fused" else ARGS.pig, "--offline", "--no-extensions", "-e", "builtin:codemode"]
    if mode == "source":
        cmd += ["-e", str(REPO / "native/pig")]
    cmd += ["--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", "read,edit,write,codemode", "--model", "verify-local/verify", "--session-dir", str(run / "sessions"), "--tui-mode", "regular"]
    ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 55, 120, 0, 0))
    transcript = bytearray()

    def read_until(process, predicate, label, offset=0, timeout=25):
        deadline = time.monotonic() + timeout
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
            text = ansi.sub("", bytes(transcript[offset:]).decode("utf8", errors="replace"))
            if predicate(text):
                return text
            if process.poll() is not None:
                raise AssertionError((mode, label, "exited", process.returncode, text[-2000:]))
        raise AssertionError((mode, label, "timeout", text[-2500:]))

    def stop(process):
        os.write(master, b"\x04")
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)

    STATE.update(calls=[codemode('await tools.write({path:"long.txt",content:Array.from({length:40},(_,i)=>"line-"+i).join("\\n")});')], requests=[], prefix="verify")
    process = subprocess.Popen(cmd + ["Run the scripted TUI verification."], stdin=slave, stdout=slave, stderr=slave, cwd=work, env=env, start_new_session=True)
    try:
        collapsed = read_until(process, lambda s: "File changes (1)" in s and "more lines" in s, "completed entry")
        assert "+40 line-39" not in collapsed
        offset = len(transcript)
        os.write(master, b"\x0f")
        read_until(process, lambda s: "line-39" in s, "Ctrl+O expansion", offset)
        offset = len(transcript)
        os.write(master, b"\x0f")
        read_until(process, lambda s: "more lines" in s, "Ctrl+O collapse", offset)
        offset = len(transcript)
        os.write(master, b"/reload\r")
        read_until(process, lambda s: "Reloaded" in s or "reloaded" in s, "/reload", offset)
        STATE.update(calls=[codemode('await tools.write({path:"after-reload.txt",content:"after reload"});')], requests=[], prefix="reloaded")
        offset = len(transcript)
        os.write(master, b"Run after reload\r")
        read_until(process, lambda s: "File changes (1)" in s and "after-reload.txt" in s, "new entry after reload", offset)
        assert (work / "after-reload.txt").read_text() == "after reload"
    finally:
        stop(process)
        (run / "tui.log").write_bytes(transcript)
    sessions = list((run / "sessions").rglob("*.jsonl"))
    assert len(sessions) == 1
    entries = [json.loads(line) for line in sessions[0].read_text().splitlines()]
    assert len([e for e in entries if e.get("customType") == "pi-codemode-diff:pig"]) == 2
    transcript.clear()
    process = subprocess.Popen(cmd + ["--session", str(sessions[0])], stdin=slave, stdout=slave, stderr=slave, cwd=work, env=env, start_new_session=True)
    try:
        read_until(process, lambda s: "File changes (1)" in s and "after-reload.txt" in s, "resumed entry renderer")
        offset = len(transcript)
        os.write(master, b"\x0f")
        read_until(process, lambda s: "line-39" in s, "resumed Ctrl+O", offset)
    finally:
        stop(process)
        (run / "resume-tui.log").write_bytes(transcript)
        os.close(master)
        os.close(slave)
    STATE["prefix"] = "verify"
    print(f"PASS {mode}/TUI display, Ctrl+O, reload, resume (Node absent)", flush=True)


def verify_self_contained():
    run = ROOT / "fused" / "self-contained"
    run.mkdir(parents=True)
    empty_path = run / "empty-path"
    empty_path.mkdir()
    home = ROOT / "fused" / "home"
    env = os.environ.copy()
    env.update(PATH=str(empty_path), HOME=str(home), PIG_HOME=str(home / "pig"), PI_HOME=str(home / "pi"), PIG_CODING_AGENT_DIR=str(home / "pig/agent"), PI_CODING_AGENT_DIR=str(home / "pi/agent"), PIG_OFFLINE="1", PIG_QUIET_STARTUP="1")
    assert shutil.which("node", path=env["PATH"]) is None and shutil.which("go", path=env["PATH"]) is None
    STATE.update(calls=[codemode('await tools.write({path:"native-only.txt",content:"self contained"});')], requests=[], prefix="verify")
    result = subprocess.run([ARGS.fused, "--offline", "--no-extensions", "-e", "builtin:codemode", "--tools", "read,edit,write,codemode", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-session", "--model", "verify-local/verify", "--mode", "json", "--print", "Verify the fused extension without external executables."], env=env, cwd=run, text=True, capture_output=True, timeout=60)
    (run / "stdout.jsonl").write_text(result.stdout)
    (run / "stderr.log").write_text(result.stderr)
    assert result.returncode == 0 and not result.stderr.strip(), result.stderr
    assert len(STATE["requests"]) == 2
    assert (run / "native-only.txt").read_text() == "self contained"
    events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    parent = next(e for e in events if e.get("type") == "tool_execution_end" and e.get("toolName") == "codemode")
    assert len(parent["result"]["details"]["piCodemodeDiff"]["changes"]) == 1
    print("PASS fused/self-contained (empty PATH; Node and Go absent)", flush=True)


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    summary = []
    try:
        for name, calls, files in SCENARIOS:
            baseline = None
            for mode in ["typescript", "source", "fused"]:
                output, _ = execute(mode, name, calls, files, server)
                if baseline is None:
                    baseline = output
                else:
                    assert output == baseline, f"{mode}/{name}: differs from TypeScript; compare {ROOT}/{{typescript,{mode}}}/{name}/comparison.json"
                print(f"PASS {mode}/{name}", flush=True)
            summary.append(name)
        for mode in ["source", "fused"]:
            _, session = execute(mode, "persist", [codemode('await tools.write({path:"persist.txt",content:"retained"});')], {}, server)
            resumed, _ = execute(mode, "resume", [codemode('await tools.write({path:"second.txt",content:"resumed"});')], {}, server, session=session)
            assert len(resumed["entries"]) == 2, (mode, "resume did not retain entries")
            print(f"PASS {mode}/resume", flush=True)
        for mode in ["source", "fused"]:
            verify_tui(mode, server)
        verify_self_contained()
        (ROOT / "summary.json").write_text(json.dumps({"scenarios": summary, "modes": ["typescript", "source", "fused"], "resume": ["source", "fused"], "tui_reload_expansion_resume": ["source", "fused"], "node_absent": ["source", "fused"], "fused_without_node_or_go": True, "model": "local scripted OpenAI-compatible endpoint"}, indent=2))
        print("Evidence:", ROOT, flush=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    main()
