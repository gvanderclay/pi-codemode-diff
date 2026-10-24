#!/usr/bin/env python3
"""Run real Pi/PiG parity and mixed-write/edit concurrency probes offline.

Requires --pi pointing to Pi's CLI .js entry, --pig to a stock PiG binary,
and --fused to the native extension's Piglet Binary built from the same host.
Each subprocess has isolated configuration; hosts reuse the same disposable
working directory so error paths need no normalization.
"""
import argparse
import collections
import hashlib
import http.server
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

REPO = pathlib.Path(__file__).resolve().parents[2]
MODES = ["pi-control", "pi-typescript", "pig-control", "pig-typescript", "pig-source", "pig-fused"]
ENTRY_TYPE = "pi-codemode-diff:pig"


def cm(code):
    return ("codemode", {"code": code})


CASES = [
    ("direct", [("write", {"path": "file.txt", "content": "direct\n"})], {}),
    ("nested", [cm('await tools.write({path:"file.txt",content:"before\\n"}); await tools.edit({path:"file.txt",edits:[{oldText:"before",newText:"after"}]}); await tools.write({path:"file.txt",content:"final\\n"}); text("NESTED_OK");')], {}),
    ("failed_script", [cm('await tools.write({path:"file.txt",content:"retained\\n"}); throw new Error("intentional failure");')], {}),
    ("failed_edit", [cm('await tools.edit({path:"absent.txt",edits:[{oldText:"old",newText:"new"}]});')], {}),
    ("read_only", [cm('text(await tools.read({path:"file.txt"}));')], {"file.txt": b"existing\n"}),
    ("long", [cm('await tools.write({path:"file.txt",content:Array.from({length:40},(_,i)=>"line-"+i).join("\\n")});')], {}),
    ("oversized", [cm('await tools.write({path:"file.txt",content:"x".repeat(262145)});')], {}),
    ("binary", [cm('await tools.write({path:"file.txt",content:"text\\n"});')], {"file.txt": b"old\x00binary"}),
    ("invalid_utf8", [cm('await tools.write({path:"file.txt",content:"text\\n"});')], {"file.txt": b"\xff\xfe"}),
    ("normalization", [cm('await tools.write({path:"file.txt",content:"same\\n"});')], {"file.txt": b"\xef\xbb\xbfsame\r\n"}),
    ("empty", [cm('await tools.write({path:"file.txt",content:""});')], {}),
    ("parallel_parents", [cm('await tools.write({path:"a.txt",content:"A"});'), cm('await tools.write({path:"b.txt",content:"B"});')], {}),
    ("parallel_writes", [cm('await Promise.all(Array.from({length:12},(_,i)=>tools.write({path:i%2?"alias.txt":"file.txt",content:"value-"+i+"\\n"})));')], {"file.txt": b"initial\n"}),
    ("blocked", [cm('await tools.write({path:"blocked.txt",content:"blocked"});')], {}),
    ("late_error", [cm('await tools.write({path:"reject.txt",content:"observed"});')], {}),
    ("helper", [cm('await tools.helper({});')], {}),
    ("rewritten_path", [cm('await tools.write({path:"redirect.txt",content:"redirected"});')], {}),
    ("edit_direct", [("edit", {"path":"file.txt","edits":[{"oldText":"before","newText":"after"}]})], {"file.txt":b"before\n"}),
    ("edit_crlf", [cm('await tools.edit({path:"file.txt",edits:[{oldText:"two\\n",newText:"second\\nthird\\n"}]});')], {"file.txt":b"\xef\xbb\xbfone\r\ntwo\r\n"}),
    ("edit_disjoint", [cm('await tools.edit({path:"file.txt",edits:[{oldText:"last",newText:"end"},{oldText:"first",newText:"start"}]});')], {"file.txt":b"first\nmiddle\nlast\n"}),
    ("edit_fuzzy", [cm('await tools.edit({path:"file.txt",edits:[{oldText:"A = 1",newText:"A = 2"}]});')], {"file.txt":"Ａ = １\n".encode()}),
    ("edit_ambiguous", [cm('await tools.edit({path:"file.txt",edits:[{oldText:"same",newText:"new"}]});')], {"file.txt":b"same same\n"}),
    ("edit_overlap", [cm('await tools.edit({path:"file.txt",edits:[{oldText:"abc",newText:"A"},{oldText:"bcd",newText:"B"}]});')], {"file.txt":b"abcdef\n"}),
    ("edit_blocked", [cm('try { await tools.edit({path:"blocked-edit.txt",edits:[{oldText:"before",newText:"after"}]}); } catch {} await tools.write({path:"blocked-edit.txt",content:"queue drained"});')], {"blocked-edit.txt":b"before\n"}),
    ("edit_rewritten", [cm('await tools.edit({path:"redirect-edit.txt",edits:[{oldText:"before",newText:"after"}]}); await tools.write({path:"redirect-edit.txt",content:"write original"});')], {"redirect-edit.txt":b"before\n","redirected-edit.txt":b"before\n"}),
]
PROBE_CASES = {"blocked", "late_error", "helper", "rewritten_path", "edit_blocked", "edit_rewritten"}


def normalize(value):
    """Only elapsed measurements change; no error/status/diff text is erased."""
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k not in ("durationMs", "elapsedMs")}
    if isinstance(value, list):
        return [normalize(v) for v in value]
    if isinstance(value, str):
        return re.sub(r"(?m)^(Wall time:? )[0-9.]+( seconds)$", r"\1<elapsed>\2", value)
    return value


class Harness:
    def __init__(self, args):
        self.args = args
        self.root = args.output or pathlib.Path(tempfile.mkdtemp(prefix="pi-pig-parity-"))
        self.root.mkdir(parents=True, exist_ok=True)
        if any(self.root.iterdir()):
            raise ValueError("Use a new empty --output directory to preserve previous evidence")
        self.work = self.root / "workspace"
        self.requests = []
        self.calls = []
        self.error = None
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    owner.requests.append(body)
                    if len(owner.requests) == 1:
                        available = {(t.get("function") or t.get("custom"))["name"]: t for t in body["tools"]}
                        calls = []
                        for i, (name, arguments) in enumerate(owner.calls):
                            tool = available[name]
                            if tool["type"] == "custom":
                                call = {"type": "custom", "custom": {"name": name, "input": arguments["code"]}}
                            else:
                                call = {"type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}
                            calls.append({"index": i, "id": f"parity_{i}", **call})
                        delta, finish = {"role": "assistant", "tool_calls": calls}, "tool_calls"
                    else:
                        delta, finish = {"role": "assistant", "content": "PARITY_DONE"}, "stop"
                    chunks = [{"id": "parity", "object": "chat.completion.chunk", "created": 1, "model": "verify", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}, {"id": "parity", "object": "chat.completion.chunk", "created": 1, "model": "verify", "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}]
                    payload = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except Exception as error:
                    owner.error = repr(error)
                    self.send_error(500, "Local scripted fixture failed")

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def environment(self, mode):
        home = self.root / "homes" / mode
        pig, pi = home / "pig", home / "pi"
        agent = (pi if mode.startswith("pi-") else pig) / "agent"
        agent.mkdir(parents=True, exist_ok=True)
        (agent / "models.json").write_text(json.dumps({"providers": {"parity-local": {"api": "openai-completions", "baseUrl": f"http://127.0.0.1:{self.server.server_port}/v1", "apiKey": "local-fixture-placeholder", "models": [{"id": "verify", "name": "Local parity fixture", "reasoning": False, "input": ["text"], "contextWindow": 100000, "maxTokens": 4096}]}}}))
        (agent / "settings.json").write_text(json.dumps({"compaction": {"enabled": False}, "retry": {"enabled": False}, "cacheWarming": "off", "quietStartup": True}))
        env = os.environ.copy()
        env.update(HOME=str(home), PIG_HOME=str(pig), PI_HOME=str(pi), PIG_CODING_AGENT_DIR=str(pig / "agent"), PI_CODING_AGENT_DIR=str(pi / "agent"), PIG_OFFLINE="1", PI_OFFLINE="1", PIG_QUIET_STARTUP="1", PI_SKIP_VERSION_CHECK="1")
        return env

    def command(self, mode, name, run, session=None):
        if mode.startswith("pi-"):
            cmd = [self.args.node, str(self.args.pi)]
        else:
            cmd = [str(self.args.fused if mode == "pig-fused" else self.args.pig)]
        cmd += ["--offline", "--no-extensions", "-e", "builtin:codemode"]
        if mode in ("pi-typescript", "pig-typescript"):
            entry = getattr(self.args, "pig_typescript_entry", None) if mode == "pig-typescript" else None
            # CLI and TUI hosts run in disposable workspaces, not the caller's cwd.
            cmd += ["-e", str(entry.resolve() if entry is not None else REPO / "src/index.ts")]
        elif mode == "pig-source":
            cmd += ["-e", str(REPO / "native/pig")]
        if name in PROBE_CASES:
            cmd += ["-e", str(REPO / "native/tests/cross-host-probe.ts")]
        tools = "read,edit,write,codemode" + (",helper" if name == "helper" else "")
        cmd += ["--no-skills", "--no-prompt-templates", "--no-context-files", "--tools", tools, "--model", "parity-local/verify", "--session-dir", str(run / "sessions")]
        if session:
            cmd += ["--session", str(session)]
        return cmd

    def run(self, mode, name, calls, files, iteration=0, session=None):
        run = self.root / "runs" / name / str(iteration) / mode
        run.mkdir(parents=True)
        if self.work.exists():
            shutil.rmtree(self.work)
        self.work.mkdir()
        for path, data in files.items():
            (self.work / path).write_bytes(data)
        if name == "parallel_writes":
            (self.work / "alias.txt").symlink_to("file.txt")
        self.calls, self.requests, self.error = calls, [], None
        cmd = self.command(mode, name, run, session) + ["--mode", "json", "--print", "Run the scripted parity fixture."]
        result = subprocess.run(cmd, cwd=self.work, env=self.environment(mode), text=True, capture_output=True, timeout=90)
        (run / "stdout.jsonl").write_text(result.stdout)
        (run / "stderr.log").write_text(result.stderr)
        (run / "requests.json").write_text(json.dumps(self.requests, indent=2))
        if result.returncode or self.error or len(self.requests) != 2:
            raise AssertionError((name, mode, result.returncode, self.error, result.stderr, result.stdout[-1500:]))
        events = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        ends = [e for e in events if e.get("type") == "tool_execution_end"]
        parents = [e for e in ends if e["toolCallId"] in {f"parity_{i}" for i in range(len(calls))}]
        diffs = {e["toolCallId"]: e["result"]["details"]["piCodemodeDiff"] for e in parents if "piCodemodeDiff" in (e.get("result", {}).get("details") or {})}
        model = [{k: m[k] for k in ("role", "tool_call_id", "content") if k in m} for m in self.requests[1]["messages"] if m.get("role") == "tool"]
        if any("piCodemodeDiff" in json.dumps(m) or ENTRY_TYPE in json.dumps(m) for m in model):
            raise AssertionError((name, mode, "diff leaked into model-facing tool content"))
        sessions = [session] if session else list((run / "sessions").rglob("*.jsonl"))
        if len(sessions) != 1:
            raise AssertionError((mode, name, "missing session", sessions))
        entries = [json.loads(line) for line in sessions[0].read_text().splitlines()]
        custom = [e["data"] for e in entries if e.get("customType") == ENTRY_TYPE]
        if mode.startswith("pi-") and custom:
            raise AssertionError((mode, name, "Pi enabled the PiG-only display path"))
        if mode.startswith("pig-") and mode != "pig-control" and len(custom) != len(diffs):
            raise AssertionError((mode, name, "missing completed diff entry", len(custom), len(diffs)))
        output = {"files": {p.name: p.read_bytes().hex() for p in self.work.iterdir() if p.is_file()}, "parent_status": {e["toolCallId"]: e.get("isError", False) for e in parents}, "model_results": normalize(model), "diffs": diffs, "custom_entries": sorted(custom, key=lambda d: d["toolCallId"]), "tool_results": normalize({e["toolCallId"]: {k: e[k] for k in ("toolName", "result", "isError") if k in e} for e in ends})}
        (run / "comparison.json").write_text(json.dumps(output, indent=2))
        return output, sessions[0]


def compare(left, right, fields):
    return [key for key in fields if left[key] != right[key]]


def queue_script(rounds, overwrite=False, sequential=False):
    edit_old = "seed" if overwrite else "base"
    operations = 'await tools.write({path:"race.txt",content:"base"}); await tools.edit({path:"race.txt",edits:[{oldText:"base",newText:"edited"}]}); const statuses=["fulfilled","fulfilled"];' if sequential else f'''const outcomes=await Promise.allSettled([
tools.write({{path:"race.txt",content:"base"}}),
tools.edit({{path:"race.txt",edits:[{{oldText:{json.dumps(edit_old)},newText:"edited"}}]}})
]); const statuses=outcomes.map(x=>x.status);'''
    return f'''const observed=[];
for(let i=0;i<{rounds};i++){{
await tools.write({{path:"race.txt",content:"seed"}});
{operations}
const final=await tools.read({{path:"race.txt"}});
observed.push({{statuses,final}});
}}
text("QUEUE_RESULT="+JSON.stringify(observed));'''


def queued_batch_script(rounds):
    # Each write computes a real, bounded diff while holding its own queue.
    # The host edit is submitted after all writes, so a shared queue must wait.
    return f'''const observed=[];
const body=(prefix)=>Array.from({{length:200}},(_,i)=>prefix+"-"+i+" "+"x".repeat(120)).join("\\n");
for(let iteration=0;iteration<{rounds};iteration++){{
await tools.write({{path:"race.txt",content:body("seed")}});
const outcomes=await Promise.allSettled([
...Array.from({{length:12}},(_,i)=>tools.write({{path:"race.txt",content:body("v"+i)}})),
tools.edit({{path:"race.txt",edits:[{{oldText:"v11-0 ",newText:"edited "}}]}})
]);
const final=await tools.read({{path:"race.txt",limit:1}});
observed.push({{statuses:outcomes.map(x=>x.status),final:final.split("\\n")[0]}});
}}
text("QUEUE_RESULT="+JSON.stringify(observed));'''


def verdict(summary):
    ordinary_equal = all(not differences for row in summary["cases"] for dimension in ("cross_host", "extension_effect", "native_vs_pigts") for differences in row[dimension].values())
    queue_equal = {}
    for name, outputs in summary["queues"].items():
        baseline = sorted(json.dumps(item, sort_keys=True) for item in outputs["pi-typescript"])
        queue_equal[name] = {mode: sorted(json.dumps(item, sort_keys=True) for item in outcomes) == baseline for mode, outcomes in outputs.items()}
    return {"ordinary_cases_equal": ordinary_equal, "queue_parity": queue_equal, "full_parity": ordinary_equal and all(equal for outputs in queue_equal.values() for equal in outputs.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", type=pathlib.Path, required=True)
    parser.add_argument("--pig", type=pathlib.Path, required=True)
    parser.add_argument("--fused", type=pathlib.Path, required=True)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--pig-typescript-entry", type=pathlib.Path, help="Explicit PiG TS entry, e.g. src/pig-index.ts on PiG 0.5.1")
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--runs", type=int, default=2)
    parser.add_argument("--queue-rounds", type=int, default=20)
    parser.add_argument("--only", help="Comma-separated ordinary case names; queue probes always run")
    args = parser.parse_args()
    if args.runs < 1 or args.queue_rounds < 1:
        parser.error("--runs and --queue-rounds must be positive")
    if args.only and set(args.only.split(",")) - {case[0] for case in CASES}:
        parser.error("--only contains an unknown case name")
    args.pi, args.pig, args.fused = args.pi.resolve(), args.pig.resolve(), args.fused.resolve()
    h = Harness(args)
    selected = [case[0] for case in CASES if not args.only or case[0] in args.only.split(",")]
    summary = {"versions": {"pi": subprocess.check_output([args.node, str(args.pi), "--version"], text=True).strip(), "pig": subprocess.check_output([str(args.pig), "--version"], text=True).strip(), "fused": subprocess.check_output([str(args.fused), "--version"], text=True).strip()}, "cases": [], "queues": {}, "scope": {"scenarios": selected, "repetitions": args.runs, "ordinary_invocations": len(selected) * args.runs * len(MODES), "queue_rounds": args.queue_rounds, "batch_rounds": min(args.queue_rounds, 3), "external_model": False, "node": subprocess.check_output([args.node, "--version"], text=True).strip()}, "executables": {}}
    for name, path in {"pi_cli": args.pi, "pig": args.pig, "fused": args.fused}.items():
        with path.open("rb") as file:
            summary["executables"][name] = {"path": str(path), "sha256": hashlib.file_digest(file, "sha256").hexdigest()}
    try:
        for name, calls, files in CASES:
            if args.only and name not in args.only.split(","):
                continue
            for iteration in range(args.runs):
                outputs = {mode: h.run(mode, name, calls, files, iteration)[0] for mode in MODES}
                row = {"case": name, "iteration": iteration, "cross_host": {}, "extension_effect": {}, "native_vs_pigts": {}}
                for mode in ("pig-typescript", "pig-source", "pig-fused"):
                    row["cross_host"][mode] = compare(outputs["pi-typescript"], outputs[mode], ["files", "parent_status", "model_results", "diffs"])
                    row["native_vs_pigts"][mode] = compare(outputs["pig-typescript"], outputs[mode], ["files", "parent_status", "model_results", "diffs", "custom_entries"])
                for mode in ("pi-typescript", "pig-typescript", "pig-source", "pig-fused"):
                    control = "pi-control" if mode.startswith("pi-") else "pig-control"
                    row["extension_effect"][mode] = compare(outputs[control], outputs[mode], ["files", "parent_status", "model_results"])
                summary["cases"].append(row)
                print(json.dumps(row), flush=True)
        queue_cases = [("sequential", queue_script(args.queue_rounds, sequential=True)), ("dependent_parallel", queue_script(args.queue_rounds)), ("overwrite_parallel", queue_script(args.queue_rounds, overwrite=True)), ("queued_batch", queued_batch_script(min(args.queue_rounds, 3)))]
        for name, code in queue_cases:
            summary["queues"][name] = {}
            for mode in MODES:
                output, _ = h.run(mode, "queue_" + name, [cm(code)], {})
                text = "\n".join(m.get("content", "") for m in output["model_results"])
                match = re.search(r"QUEUE_RESULT=(\[[^\n]*\])", text)
                if not match:
                    raise AssertionError((mode, name, "queue probe did not finish", text[-2000:]))
                outcomes = json.loads(match.group(1))
                counts = collections.Counter(json.dumps(x, sort_keys=True) for x in outcomes)
                summary["queues"][name][mode] = [{"count": count, **json.loads(value)} for value, count in counts.items()]
                print("QUEUE", name, mode, summary["queues"][name][mode], flush=True)
        summary["verdict"] = verdict(summary)
        (h.root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print("VERDICT", json.dumps(summary["verdict"]), flush=True)
        print("Evidence:", h.root, flush=True)
    finally:
        h.close()
    return 0 if summary["verdict"]["full_parity"] else 1


if __name__ == "__main__":
    sys.exit(main())
