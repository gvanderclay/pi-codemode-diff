import assert from "node:assert/strict";
import fs from "node:fs";
import fsp, { access, chmod, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent, type AgentSession, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DETAILS_KEY, readChanges } from "../src/changes.ts";
import { GATE_KEY, type Gate } from "./gate-extension.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

const options = { timeout: 30_000 };
const gatePath = fileURLToPath(new URL("./gate-extension.ts", import.meta.url));

/**
 * Mount the root codemode row the way interactive mode does
 * (modes/interactive/interactive-mode.js, tool_execution_* cases): one real
 * ToolExecutionComponent per parentless call, partial updates routed to
 * updateResult(..., true). Every requestRender() records what a repaint shows.
 */
function mountCard(session: AgentSession, cwd: string) {
  initTheme("dark", false);
  const frames: string[] = [];
  let component: ToolExecutionComponent | undefined;
  const visible = () => stripVTControlCharacters(component!.render(120).join("\n"))
    .split("\n").map(line => line.trimEnd().replace(/^ /, "")).join("\n");
  const ui = { requestRender() { if (component) frames.push(visible()); } } as unknown as TUI;
  session.subscribe(event => {
    if (event.type === "tool_execution_start" && !event.parentToolCallId) {
      const native = session.getToolDefinition(event.toolName)!;
      const renderers = session.extensionRunner.resolveToolRenderers(event.toolName, () => native)!;
      component = new ToolExecutionComponent(event.toolName, event.toolCallId, event.args, {}, { ...native, ...renderers }, ui, cwd);
      component.setArgsComplete();
      component.markExecutionStarted();
    } else if (event.type === "tool_execution_update" && !event.parentToolCallId) {
      component?.updateResult({ ...event.partialResult, isError: false }, true);
      ui.requestRender();
    } else if (event.type === "tool_execution_end" && !event.parentToolCallId) {
      component?.updateResult({ ...event.result, isError: event.isError });
      ui.requestRender();
    }
  });
  return { frames, visible, get component() { return component!; } };
}

/** Each gated call waits for an explicit decision; the test observes the card meanwhile. */
function installGate(t: TestContext, tools = ["edit"]) {
  const waiting: Array<{ event: ToolCallEvent; release: (decision: "block" | "allow") => void }> = [];
  let notify: (() => void) | undefined;
  const gate: Gate = event => {
    if (!tools.includes(event.toolName)) return undefined;
    return new Promise(resolve => {
      waiting.push({ event, release: decision => resolve(decision === "block" ? { block: true, reason: "Denied by test gate" } : undefined) });
      notify?.();
    });
  };
  (globalThis as Record<string, unknown>)[GATE_KEY] = gate;
  t.after(() => {
    delete (globalThis as Record<string, unknown>)[GATE_KEY];
    // Never leave a script holding a shared codemode worker after a failure.
    for (const paused of waiting) paused.release("block");
  });
  return {
    waiting,
    /** Resolves once n calls are paused at the gate. */
    async paused(n: number) {
      while (waiting.length < n) await new Promise<void>(resolve => { notify = resolve; });
      return waiting[n - 1];
    },
  };
}

for (const position of ["before", "after"] as const) {
  test("the proposal is painted while a gate (loaded " + position + " this package) waits; block then allow", options, async t => {
    const fixture = await runtimeFixture(t, position === "before" ? { extensionPathsBefore: [gatePath] } : { extensionPathsAfter: [gatePath] });
    const target = join(fixture.cwd, "target.txt");
    await writeFile(target, "alpha\n");
    const card = mountCard(fixture.session, fixture.cwd);
    const gate = installGate(t);
    const code = [
      'try { await tools.edit({ path: "target.txt", edits: [{ oldText: "alpha", newText: "beta" }] }); } catch { text("first blocked"); }',
      'await tools.edit({ path: "target.txt", edits: [{ oldText: "alpha", newText: "gamma" }] });',
    ].join("\n");
    const run = fixture.codemode(code);

    // 1. First edit paused at the gate: the last repaint already shows its proposal.
    const first = await gate.paused(1);
    assert.equal(first.event.toolCallId, "root/1");
    const painted = card.frames.at(-1)!;
    assert.match(painted, /Proposed changes \(1\)/);
    assert.match(painted, /target\.txt \[edit · proposed\] \+1 -1\nPreview built from the call's arguments without reading the file; not applied yet\.\n- alpha\n\+ beta/);
    assert.doesNotMatch(painted, /File changes/);
    assert.equal(card.visible(), painted, "A fresh render matches the repaint");
    card.component.setExpanded(true);
    assert.match(card.visible(), /- alpha\n\+ beta/, "Expansion (Ctrl+O) keeps the proposal while waiting");
    card.component.setExpanded(false);
    assert.equal(await readFile(target, "utf8"), "alpha\n", "Nothing is written while the gate waits");

    // 2. Block: the file is unchanged and the proposal is repainted as unverified.
    first.release("block");
    const second = await gate.paused(2);
    assert.equal(await readFile(target, "utf8"), "alpha\n");
    const afterBlock = card.frames.at(-1)!;
    assert.match(afterBlock, /Proposed changes \(2\)/);
    assert.match(afterBlock, /\+ gamma[\s\S]*target\.txt \[edit · proposed\] \+1 -1\nDid not complete — changes not verified\.\nError: Denied by test gate\n- alpha\n\+ beta/,
      "The pending proposal is listed first; the blocked one is marked unverified with its reason");
    assert.doesNotMatch(afterBlock, /File changes/);

    // 3. Allow: the file changes and the real numbered diff replaces the proposal.
    second.release("allow");
    const result = await run;
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(await readFile(target, "utf8"), "gamma\n");
    const replaced = card.frames.find(frame => /File changes \(1\)/.test(frame) && /Proposed changes \(1\)/.test(frame));
    assert.ok(replaced, "While still running, the completed diff replaces the allowed call's proposal");
    assert.doesNotMatch(replaced!, /\+ gamma/);
    assert.match(replaced!, /-1 alpha\n\+1 gamma/);
    const final = card.frames.at(-1)!;
    assert.match(final, /File changes \(1\) · 1 file/);
    assert.match(final, /-1 alpha\n\+1 gamma/);
    assert.doesNotMatch(final, /Proposed|Did not complete/, "Proposals are dropped at root end");

    // Persisted/model-facing data hold only the v1 completed change.
    const changes = readChanges(result.details)!;
    assert.deepEqual(changes.map(change => [change.toolCallId, change.kind]), [["root/2", "edit"]]);
    const payload = JSON.stringify((result.details as Record<string, unknown>)[DETAILS_KEY]);
    assert.doesNotMatch(payload, /proposed|unverified|pending|beta/i);
    assert.doesNotMatch(JSON.stringify(result.content), /Proposed|\+ beta|\+ gamma/);
    const saved = await readFile(fixture.session.sessionManager.getSessionFile()!, "utf8");
    assert.doesNotMatch(saved, /Proposed changes|unverified|"proposals"/);
  });
}

test("parallel gated calls on unreadable and missing files preview without reading them", options, async t => {
  const fixture = await runtimeFixture(t, { extensionPathsAfter: [gatePath] });
  const locked = join(fixture.cwd, "locked.txt");
  await writeFile(locked, "secret contents\n");
  await chmod(locked, 0o000);
  t.after(() => chmod(locked, 0o600).catch(() => {}));
  const card = mountCard(fixture.session, fixture.cwd);
  const gate = installGate(t, ["edit", "write"]);
  const run = fixture.codemode([
    "await Promise.allSettled([",
    '  tools.edit({ path: "locked.txt", edits: [{ oldText: "supplied old", newText: "supplied new" }] }),',
    '  tools.edit({ path: "missing.txt", edits: JSON.stringify([{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }]) }),',
    '  tools.edit({ path: "missing.txt", oldText: "legacy", newText: "shape" }),',
    '  tools.write({ path: "written.txt", content: "proposed\\ncontent\\n" }),',
    "]);",
  ].join("\n"));
  await gate.paused(4);
  const painted = card.frames.at(-1)!;
  assert.match(painted, /Proposed changes \(4\)/);
  card.component.setExpanded(true);
  const full = card.visible();
  assert.match(full, /locked\.txt \[edit · proposed\] \+1 -1\nPreview built from the call's arguments without reading the file; not applied yet\.\n- supplied old\n\+ supplied new/);
  assert.match(full, /missing\.txt \[edit · proposed\] \+2 -2\nPreview built from the call's arguments without reading the file; not applied yet\.\n· replacement 1\/2 \+1 -1\n- a\n\+ b\n· replacement 2\/2 \+1 -1\n- c\n\+ d/);
  assert.match(full, /missing\.txt \[edit · proposed\] \+1 -1\nPreview built from the call's arguments without reading the file; not applied yet\.\n- legacy\n\+ shape/, "Same path, separate call");
  assert.match(full, /written\.txt \[write · proposed content\] 17 bytes · 2 lines\nPreview built from the call's arguments without reading the file; not applied yet\.\n  proposed\n  content/);
  assert.doesNotMatch(full, /secret contents/);
  for (const paused of gate.waiting) paused.release("block");
  const result = await run;
  assert.equal(readChanges(result.details), undefined);
  await chmod(locked, 0o600);
  assert.equal(await readFile(locked, "utf8"), "secret contents\n");
  await assert.rejects(access(join(fixture.cwd, "missing.txt")), { code: "ENOENT" });
  await assert.rejects(access(join(fixture.cwd, "written.txt")), { code: "ENOENT" });
  assert.ok(card.frames.some(frame => (frame.match(/Did not complete/g) ?? []).length === 3), "Blocked calls are repainted as unverified before the root ends");
  assert.doesNotMatch(card.frames.at(-1)!, /Proposed/);
});

/**
 * Count ATTEMPTED filesystem reads/opens/stats of the given basenames, whether
 * or not they succeed. Live ESM bindings (Pi's own named fs imports included)
 * are refreshed with syncBuiltinESMExports, as in limits.test.ts.
 */
function spyOnReads(t: TestContext, names: string[]) {
  const attempts: string[] = [];
  let counting = false;
  const pathOf = (value: unknown) => value instanceof URL ? value.pathname : Buffer.isBuffer(value) ? value.toString() : typeof value === "string" ? value : "";
  // fs signatures are erased: this spy only forwards arguments.
  const spy = (target: any, label: string, methods: string[]) => {
    for (const method of methods) {
      const original = target[method];
      if (typeof original !== "function") continue;
      t.mock.method(target, method, function (this: unknown, ...args: unknown[]) {
        const path = pathOf(args[0]);
        if (counting && names.some(name => path === name || path.endsWith("/" + name))) attempts.push(label + "." + method + " " + path);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      });
    }
  };
  const callbackAndSync = ["readFile", "readFileSync", "open", "openSync", "createReadStream", "access", "accessSync",
    "stat", "statSync", "lstat", "lstatSync", "existsSync", "realpath", "realpathSync", "opendir", "readdir"];
  const promise = ["readFile", "open", "access", "stat", "lstat", "realpath"];
  spy(fs, "fs", callbackAndSync);
  spy(fs.promises, "fs.promises", promise);
  if ((fsp as unknown) !== fs.promises) spy(fsp, "fs/promises", promise);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return {
    attempts,
    start() { counting = true; },
    /** Run the test's own verification reads outside the counted window. */
    async uncounted<T>(work: () => Promise<T>): Promise<T> {
      counting = false;
      try { return await work(); } finally { counting = true; }
    },
    stop() { counting = false; },
  };
}

test("no fixture read, open or stat is attempted before approval, for edit and write, deny and allow", options, async t => {
  const fixture = await runtimeFixture(t, { extensionPathsAfter: [gatePath] });
  const editTarget = join(fixture.cwd, "edit-target.txt");
  const writeTarget = join(fixture.cwd, "write-target.txt");
  await writeFile(editTarget, "alpha\n");
  await writeFile(writeTarget, "previous\n");
  const card = mountCard(fixture.session, fixture.cwd);
  const gate = installGate(t, ["edit", "write"]);
  const reads = spyOnReads(t, ["edit-target.txt", "write-target.txt"]);
  const of = (name: string) => reads.attempts.filter(entry => entry.endsWith(name));
  reads.start();
  const run = fixture.codemode([
    'try { await tools.edit({ path: "edit-target.txt", edits: [{ oldText: "alpha", newText: "beta" }] }); } catch {}',
    'try { await tools.write({ path: "write-target.txt", content: "denied\\n" }); } catch {}',
    'await tools.edit({ path: "edit-target.txt", edits: [{ oldText: "alpha", newText: "gamma" }] });',
    'await tools.write({ path: "write-target.txt", content: "allowed\\n" });',
  ].join("\n"));

  // Denied edit: zero attempts from its start through its end (and the next call's start).
  (await gate.paused(1)).release("block");
  await gate.paused(2);
  assert.match(card.frames.at(-1)!, /write-target\.txt \[write · proposed content\]/);
  assert.deepEqual(reads.attempts, [], "Neither the denied edit nor the pending write proposal touched the files");
  // Denied write: zero attempts for the whole call.
  gate.waiting[1].release("block");
  await gate.paused(3);
  assert.deepEqual(reads.attempts, []);
  assert.equal(await reads.uncounted(() => readFile(editTarget, "utf8")), "alpha\n");
  assert.equal(await reads.uncounted(() => readFile(writeTarget, "utf8")), "previous\n");

  // Allowed edit: zero before release; its execution then reads the file (proves the spies see Pi's reads).
  assert.match(card.frames.at(-1)!, /edit-target\.txt \[edit · proposed\][^\n]*\n[^\n]*\n- alpha\n\+ gamma/);
  assert.deepEqual(reads.attempts, []);
  gate.waiting[2].release("allow");
  await gate.paused(4);
  assert.ok(of("edit-target.txt").length > 0, "The allowed edit's own reads are observed after release");
  assert.deepEqual(of("write-target.txt"), [], "The pending write proposal attempted no read");
  // Allowed write: its post-approval snapshot opens the file.
  gate.waiting[3].release("allow");
  const result = await run;
  reads.stop();
  assert.equal(result.isError, false, JSON.stringify(result.content));
  assert.ok(of("write-target.txt").length > 0, "The allowed write's snapshot is observed after release");
  assert.equal(await readFile(editTarget, "utf8"), "gamma\n");
  assert.equal(await readFile(writeTarget, "utf8"), "allowed\n");
  assert.deepEqual(readChanges(result.details)!.map(change => change.tool), ["edit", "write"]);
});

test("an allowed edit that fails to match is reported as unverified", options, async t => {
  const fixture = await runtimeFixture(t, { extensionPathsAfter: [gatePath] });
  await writeFile(join(fixture.cwd, "a.txt"), "original\n");
  const card = mountCard(fixture.session, fixture.cwd);
  const gate = installGate(t);
  const run = fixture.codemode('try { await tools.edit({ path: "a.txt", edits: [{ oldText: "absent", newText: "x" }] }); } catch {} await tools.read({ path: "a.txt" });');
  (await gate.paused(1)).release("allow");
  const result = await run;
  assert.equal(readChanges(result.details), undefined);
  assert.equal(await readFile(join(fixture.cwd, "a.txt"), "utf8"), "original\n");
  assert.ok(card.frames.some(frame => /Did not complete — changes not verified\.\nError: [^\n]+\n- absent\n\+ x/.test(frame)));
  assert.doesNotMatch(card.frames.at(-1)!, /Proposed/);
});

test("proposal construction imports no filesystem module", async () => {
  const source = await readFile(new URL("../src/proposals.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:fs|from "fs|readFile|open\(/);
});
