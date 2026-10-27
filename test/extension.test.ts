import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, Theme, ToolDefinition, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import { DETAILS_KEY, readChanges } from "../src/changes.ts";

type Event = Record<string, unknown>;
type Handler = (event: Event) => unknown;

function harness() {
  const handlers = new Map<string, Handler[]>();
  // The fake host intentionally erases tool-specific schemas; the real host validates them.
  const tools = new Map<string, ToolDefinition<any, any>>();
  let renderer: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  extension({
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition<any, any>) { tools.set(tool.name, tool); },
    registerToolRenderer(resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0]) { renderer = resolver; },
  } as unknown as ExtensionAPI);

  async function emit(event: Event): Promise<Event> {
    let current = event;
    for (const handler of handlers.get(String(event.type)) ?? []) {
      const result = await handler(current);
      if (result && typeof result === "object") current = { ...current, ...result };
    }
    return current;
  }

  async function start(id: string, name: string, parentToolCallId?: string) {
    await emit({ type: "tool_execution_start", toolCallId: id, toolName: name, parentToolCallId });
  }

  async function runWrite(cwd: string, id: string, path: string, content: string, parent?: string) {
    await start(id, "write", parent);
    const input = { path, content };
    const result = await tools.get("write")!.execute(id, input, undefined, undefined, { cwd } as ExtensionToolContext);
    const modified = await emit({ type: "tool_result", toolCallId: id, toolName: "write", input, ...result, isError: false, parentToolCallId: parent });
    await emit({ type: "tool_execution_end", toolCallId: id, toolName: "write", result, isError: false, parentToolCallId: parent });
    return { result, modified };
  }

  async function finish(id: string, isError = false, name = "codemode") {
    const content = [{ type: "text", text: "Script output only" }];
    const originalDetails = { calls: [{ id: `${id}/1`, name: "write", status: "ok" }], fullOutputPath: "/tmp/output" };
    const structuredContent = { returned: "untouched" };
    const usage = { input: 3, output: 5 };
    const result = await emit({ type: "tool_result", toolCallId: id, toolName: name, input: {}, content, structuredContent, usage, details: originalDetails, isError });
    assert.strictEqual(result.structuredContent, structuredContent);
    assert.strictEqual(result.usage, usage);
    assert.strictEqual(result.content, content);
    assert.equal(result.isError, isError);
    assert.deepEqual((result.details as Event).calls, originalDetails.calls);
    assert.equal((result.details as Event).fullOutputPath, originalDetails.fullOutputPath);
    await emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError });
    return result;
  }

  return { emit, start, runWrite, finish, tools, getRenderer: () => renderer! };
}

async function temp(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-codemode-diff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("captures nested edit details without changing model-facing content", async () => {
  const host = harness();
  await host.start("root", "codemode");
  await host.start("root/1", "edit", "root");
  const event = {
    type: "tool_result", toolCallId: "root/1", toolName: "edit", parentToolCallId: "root",
    input: { path: "a.ts", edits: [] }, content: [{ type: "text", text: "Successfully replaced" }],
    details: { diff: "-1 before\n+1 after", patch: "not copied" }, isError: false,
  };
  assert.strictEqual(await host.emit(event), event);
  const result = await host.finish("root");
  const changes = readChanges(result.details)!;
  assert.equal(changes[0].diff, "-1 before\n+1 after");
  assert.equal("patch" in changes[0], false);
  assert.equal(JSON.stringify(result.content).includes("before"), false);
  assert.deepEqual(readChanges(JSON.parse(JSON.stringify(result.details))), changes);
});

test("direct writes retain native results and do not acquire diff metadata", async (t) => {
  const host = harness();
  const dir = await temp(t);
  const { result, modified } = await host.runWrite(dir, "direct", "nested/new.txt", "hello\n");
  assert.equal(await readFile(join(dir, "nested/new.txt"), "utf8"), "hello\n");
  assert.equal(result.details, undefined);
  assert.deepEqual(modified.content, [{ type: "text", text: "Successfully wrote to nested/new.txt" }]);
  assert.equal(readChanges(modified.details), undefined);
  assert.equal(host.tools.get("write")!.defaultActive, false);
});

test("direct writes follow execution cwd changes without reloading the extension", async t => {
  const initialCwd = await temp(t);
  const nextCwd = await temp(t);
  // Capture an isolated startup cwd without changing the real process cwd.
  // The same registered wrapper must use each later execution context instead.
  const cwdMock = t.mock.method(process, "cwd", () => initialCwd);
  let host: ReturnType<typeof harness>;
  try {
    host = harness();
  } finally {
    cwdMock.mock.restore();
  }
  const writer = host.tools.get("write");
  const path = "nested/cwd.txt";
  const first = await host.runWrite(initialCwd, "direct-first", path, "initial workspace");
  const second = await host.runWrite(nextCwd, "direct-second", path, "new workspace");

  assert.strictEqual(host.tools.get("write"), writer, "No reload or tool replacement should be needed");
  assert.equal(await readFile(join(initialCwd, path), "utf8"), "initial workspace", "The old cwd must not receive the second write");
  assert.equal(await readFile(join(nextCwd, path), "utf8"), "new workspace");
  for (const { result, modified } of [first, second]) {
    assert.deepEqual(modified.content, [{ type: "text", text: `Successfully wrote to ${path}` }]);
    assert.equal(result.details, undefined);
    assert.equal(readChanges(modified.details), undefined);
  }
});

test("nested create and overwrite generate diffs, while write results stay unchanged", async (t) => {
  const host = harness();
  const dir = await temp(t);
  await writeFile(join(dir, "existing.txt"), "before\n");
  await host.start("root", "codemode");
  const created = await host.runWrite(dir, "root/1", "nested/new.txt", "new\n", "root");
  const overwritten = await host.runWrite(dir, "root/2", "existing.txt", "after\n", "root");
  assert.equal(created.result.details, undefined);
  assert.equal(overwritten.result.details, undefined);
  assert.deepEqual(overwritten.modified.content, [{ type: "text", text: "Successfully wrote to existing.txt" }]);
  const changes = readChanges((await host.finish("root")).details)!;
  assert.equal(changes[0].kind, "create");
  assert.equal(changes[1].kind, "overwrite");
  assert.match(changes[1].diff!, /before/);
  assert.match(changes[1].diff!, /after/);
});

test("parallel writes to the same file snapshot under the native mutation queue", async (t) => {
  const host = harness();
  const dir = await temp(t);
  await writeFile(join(dir, "a.txt"), "zero\n");
  await host.start("root", "codemode");
  await Promise.all([
    host.runWrite(dir, "root/1", "a.txt", "one\n", "root"),
    host.runWrite(dir, "root/2", "a.txt", "two\n", "root"),
  ]);
  const changes = readChanges((await host.finish("root")).details)!;
  assert.match(changes[0].diff!, /zero/);
  assert.match(changes[0].diff!, /one/);
  assert.match(changes[1].diff!, /one/);
  assert.match(changes[1].diff!, /two/);
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "two\n");
});

test("a script failure retains diffs from writes that already succeeded", async (t) => {
  const host = harness();
  const dir = await temp(t);
  await host.start("root", "codemode");
  await host.runWrite(dir, "root/1", "a.txt", "written\n", "root");
  assert.equal(readChanges((await host.finish("root", true)).details)?.length, 1);
});

test("failed writes have no success diff and aborted writes preserve files", async (t) => {
  const host = harness();
  const dir = await temp(t);
  await writeFile(join(dir, "a.txt"), "original\n");
  await host.start("root", "codemode");
  await host.start("root/1", "write", "root");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(host.tools.get("write")!.execute(
    "root/1", { path: "a.txt", content: "replacement" }, controller.signal, undefined, { cwd: dir } as ExtensionToolContext,
  ), /aborted/i);
  assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "original\n");
  assert.equal(readChanges((await host.finish("root", true)).details), undefined);
});

test("binary/non-UTF-8 previous content is labeled unavailable without blocking writes", async (t) => {
  const host = harness();
  const dir = await temp(t);
  await writeFile(join(dir, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(dir, "invalid"), Buffer.from([0xff, 0xfe]));
  await host.start("root", "codemode");
  await host.runWrite(dir, "root/1", "binary", "text", "root");
  await host.runWrite(dir, "root/2", "invalid", "text", "root");
  const changes = readChanges((await host.finish("root")).details)!;
  assert.match(changes[0].note!, /binary/);
  assert.match(changes[1].note!, /UTF-8/);
  assert.ok(changes.every(c => c.diff === undefined && c.kind === "unknown"));
});

test("the renderer resolver leaves every non-codemode tool alone", () => {
  const host = harness();
  const base: ToolRenderers = { renderShell: "self" };
  assert.strictEqual(host.getRenderer()("edit", () => base), base);
  assert.equal(host.getRenderer()("codemode", () => undefined), undefined);
});

test("no changes means no metadata, and new sessions clear in-flight state", async () => {
  const host = harness();
  await host.start("root", "codemode");
  await host.start("root/1", "edit", "root");
  await host.emit({ type: "tool_result", toolCallId: "root/1", toolName: "edit", input: { path: "a" }, content: [], details: { diff: "+1 a" }, isError: false });
  await host.emit({ type: "session_start", reason: "new" });
  // The original codemode details survive, but the abandoned batch does not.
  const result = await host.finish("root");
  assert.equal((result.details as Event)[DETAILS_KEY], undefined);
});

test("an edit without display details produces a notice rather than an invented diff", async () => {
  const host = harness();
  await host.start("root", "codemode");
  await host.start("root/1", "edit", "root");
  await host.emit({ type: "tool_result", toolCallId: "root/1", toolName: "edit", input: { path: "a" }, content: [], details: undefined, isError: false });
  const change = readChanges((await host.finish("root")).details)![0];
  assert.equal(change.diff, undefined);
  assert.match(change.note!, /did not provide/);
});

for (const name of ["codemode", "codemode_o"]) {
  test(`${name}: edit/write capture, failed-parent retention and lifecycle cleanup`, async t => {
    const host = harness();
    const dir = await temp(t);
    await host.start("root", name);
    await host.runWrite(dir, "root/1", "a.txt", "before\n", "root");
    await host.start("root/2", "edit", "root");
    await host.emit({
      type: "tool_result", toolCallId: "root/2", toolName: "edit", input: { path: "a.txt" },
      content: [], details: { diff: "-1 before\n+1 after" }, isError: false,
    });
    const result = await host.finish("root", true, name);
    assert.deepEqual(readChanges(result.details)?.map(change => change.tool), ["write", "edit"]);
    assert.equal(readChanges((await host.finish("root", false, name)).details), undefined);
    for (const type of ["session_start", "agent_end", "session_shutdown"]) {
      await host.start("abandoned", name);
      await host.runWrite(dir, "abandoned/1", "a.txt", type, "abandoned");
      await host.emit({ type });
      assert.equal(readChanges((await host.finish("abandoned", false, name)).details), undefined);
    }
  });
}

test("mixed roots remain isolated and codemode prefixes do not establish capture", async t => {
  const host = harness();
  const dir = await temp(t);
  for (const name of ["codemode", "codemode_o", "codemode_other", "codemode_o_extra", "helper"]) {
    await host.start(name, name);
  }
  await Promise.all(["codemode", "codemode_o", "codemode_other", "codemode_o_extra", "helper"].map(name =>
    host.runWrite(dir, `${name}/1`, name, name, name)));
  for (const name of ["codemode", "codemode_o", "codemode_other", "codemode_o_extra", "helper"]) {
    const changes = readChanges((await host.finish(name, false, name)).details);
    if (name === "codemode" || name === "codemode_o") {
      assert.deepEqual(changes?.map(change => change.path), [name]);
    } else {
      assert.equal(changes, undefined);
      const base: ToolRenderers = { renderResult: () => { throw new Error("unused"); } };
      assert.strictEqual(host.getRenderer()(name, () => base), base);
    }
  }
});

for (const lifecycle of ["agent_end", "session_shutdown"]) {
  test(`${lifecycle} clears abandoned capture state`, async () => {
    const host = harness();
    await host.start("root", "codemode");
    await host.start("root/1", "edit", "root");
    await host.emit({ type: "tool_result", toolCallId: "root/1", toolName: "edit", input: { path: "a" }, content: [], details: { diff: "+1 a" }, isError: false });
    await host.emit({ type: lifecycle });
    assert.equal(readChanges((await host.finish("root")).details), undefined);
  });
}

test("nested edit/write starts create live proposals that lifecycle events drop", async () => {
  const host = harness();
  type Render = NonNullable<ToolRenderers["renderResult"]>;
  const render = host.getRenderer()("codemode", () => ({ renderResult: () => new Text("running", 0, 0) }))!.renderResult as Render;
  const theme = { fg: (_: string, value: string) => value, bold: (value: string) => value, inverse: (value: string) => value } as unknown as Theme;
  const context = {
    durationMs: undefined, outputPad: 0, args: {}, toolCallId: "root", invalidate() {}, lastComponent: undefined,
    state: {}, cwd: "/tmp", executionStarted: true, argsComplete: true, isPartial: true,
    expanded: true, showImages: true, isError: false,
  } as Parameters<Render>[3];
  const view = () => render({ content: [], details: {} }, { expanded: true, isPartial: true }, theme, context).render(100).join("\n");
  for (const type of ["agent_end", "session_start", "session_shutdown"]) {
    await host.start("root", "codemode");
    await host.emit({ type: "tool_execution_start", toolCallId: "root/1", toolName: "edit", parentToolCallId: "root",
      args: { path: "a.ts", edits: JSON.stringify([{ oldText: "one", newText: "two" }]) } });
    await host.emit({ type: "tool_execution_start", toolCallId: "root/2", toolName: "write", parentToolCallId: "root",
      args: { path: "b.ts", content: "new\n" } });
    await host.emit({ type: "tool_execution_start", toolCallId: "direct", toolName: "edit",
      args: { path: "direct.ts", edits: [{ oldText: "x", newText: "y" }] } });
    const live = view();
    assert.match(live, /Proposed \(not applied\) \(2\)/);
    assert.match(live, /a\.ts \[edit · proposed\] \+1 -1/);
    assert.match(live, /b\.ts \[write · proposed content\] 4 bytes · 1 line/);
    assert.doesNotMatch(live, /direct\.ts/, "Direct calls never get a proposal");
    await host.emit({ type: "tool_execution_end", toolCallId: "root/2", toolName: "write", parentToolCallId: "root", isError: false, result: {} });
    assert.doesNotMatch(view(), /b\.ts/, "A successful end without a captured change drops the proposal");
    await host.emit({ type });
    assert.doesNotMatch(view(), /Proposed/, type + " drops proposals");
    assert.equal(readChanges((await host.finish("root")).details), undefined);
  }
});
