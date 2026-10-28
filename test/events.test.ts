import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { MAX_EVENT_PREVIEW_BYTES, MAX_EVENT_PREVIEW_LINES, PROPOSALS_EVENT, type ProposalsEvent } from "../src/events.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

type Event = Record<string, unknown>;

function harness() {
  const handlers = new Map<string, Array<(event: Event) => unknown>>();
  const tools = new Map<string, ToolDefinition<any, any>>();
  const emitted: ProposalsEvent[] = [];
  extension({
    on(name: string, handler: (event: Event) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: ToolDefinition<any, any>) { tools.set(tool.name, tool); },
    registerToolRenderer() {},
    events: {
      emit(channel: string, data: unknown) {
        assert.equal(channel, PROPOSALS_EVENT);
        emitted.push(JSON.parse(JSON.stringify(data)));
      },
      on() { return () => {}; },
    },
  } as unknown as ExtensionAPI);
  async function emit(event: Event) {
    for (const handler of handlers.get(String(event.type)) ?? []) await handler(event);
  }
  const start = (id: string, name: string, parentToolCallId?: string, args?: unknown) =>
    emit({ type: "tool_execution_start", toolCallId: id, toolName: name, parentToolCallId, args });
  const end = (id: string, name: string, isError: boolean, result: unknown = { content: [] }, parentToolCallId?: string) =>
    emit({ type: "tool_execution_end", toolCallId: id, toolName: name, isError, result, parentToolCallId });
  return { emit, start, end, emitted, last: () => emitted.at(-1)! };
}

const edit = (oldText: string, newText: string, path = "a.ts") => ({ path, edits: [{ oldText, newText }] });

test("snapshots follow add, unverified-with-error, completion, removal and root end; duplicates are skipped", async () => {
  const host = harness();
  await host.start("root", "codemode");
  assert.equal(host.emitted.length, 0, "Starting a root without proposals emits nothing");
  await host.start("root/1", "edit", "root", edit("one", "two"));
  assert.deepEqual(host.last(), { version: 1, proposals: [{
    toolCallId: "root/1", tool: "edit", path: "a.ts", status: "pending", preview: "- one\n+ two", added: 1, removed: 1,
  }] });
  await host.start("root/2", "write", "root", { path: "b.ts", content: "x\n" });
  await host.start("root/3", "edit", "root", edit("c", "d", "c.ts"));
  assert.deepEqual(host.last().proposals.map(p => p.toolCallId), ["root/1", "root/2", "root/3"]);
  assert.equal(host.last().proposals[1].preview, "  x");

  // Error: status change with the first error line; the end event repeats it but adds no new snapshot.
  await host.emit({ type: "tool_result", toolCallId: "root/1", toolName: "edit", input: edit("one", "two"), isError: true,
    content: [{ type: "text", text: "Blocked by gate\nmore" }], details: undefined });
  const count = host.emitted.length;
  await host.end("root/1", "edit", true, { content: [{ type: "text", text: "Blocked by gate" }] }, "root");
  assert.equal(host.emitted.length, count, "Identical consecutive snapshots are not re-emitted");
  assert.deepEqual(host.last().proposals[0], {
    toolCallId: "root/1", tool: "edit", path: "a.ts", status: "unverified", preview: "- one\n+ two", added: 1, removed: 1, error: "Blocked by gate",
  });

  // Success: the completed diff replaces root/3's proposal; a plain successful end removes root/2's.
  await host.emit({ type: "tool_result", toolCallId: "root/3", toolName: "edit", input: edit("c", "d", "c.ts"), isError: false,
    content: [], details: { diff: "-1 c\n+1 d" } });
  assert.deepEqual(host.last().proposals.map(p => p.toolCallId), ["root/1", "root/2"]);
  await host.end("root/2", "write", false, { content: [] }, "root");
  assert.deepEqual(host.last().proposals.map(p => p.toolCallId), ["root/1"]);

  await host.end("root", "codemode", false);
  assert.deepEqual(host.last(), { version: 1, proposals: [] });
  const total = host.emitted.length;
  await host.emit({ type: "session_start" });
  assert.equal(host.emitted.length, total, "An already-empty snapshot is not repeated");
});

for (const type of ["agent_end", "session_start", "session_shutdown"]) test(type + " clears the snapshot across roots", async () => {
  const host = harness();
  await host.start("left", "codemode");
  await host.start("right", "codemode");
  await host.start("left/1", "edit", "left", edit("a", "b"));
  await host.start("right/1", "edit", "right", edit("c", "d", "r.ts"));
  assert.deepEqual(host.last().proposals.map(p => p.toolCallId), ["left/1", "right/1"], "All roots are in one snapshot");
  await host.emit({ type });
  assert.deepEqual(host.last(), { version: 1, proposals: [] });
});

test("previews are bounded and every string field is sanitized", async () => {
  const host = harness();
  await host.start("root", "codemode");
  const many = Array.from({ length: 1_000 }, (_, i) => "line " + i).join("\n");
  await host.start("root/1", "edit", "root", edit("x", many, "many.ts"));
  const long = Array.from({ length: 120 }, () => "y".repeat(500)).join("\n");
  await host.start("root/2", "edit", "root", edit("x", long, "long.ts"));
  const [byLines, byBytes] = host.last().proposals;
  for (const preview of [byLines.preview!, byBytes.preview!]) {
    assert.ok(preview.split("\n").length <= MAX_EVENT_PREVIEW_LINES, "line cap");
    assert.ok(Buffer.byteLength(preview) <= MAX_EVENT_PREVIEW_BYTES, "byte cap");
    assert.match(preview.split("\n").at(-1)!, /^… \d+ more lines$/);
  }
  assert.equal(byLines.preview!.split("\n").length, MAX_EVENT_PREVIEW_LINES);
  assert.equal(byLines.preview!.split("\n").at(-1), "… " + (1_001 - (MAX_EVENT_PREVIEW_LINES - 1)) + " more lines");

  await host.start("root/3", "edit", "root", edit("old\u001b[2J", "new\u009b\u0007", "evil\u001b]0;t\u0007.ts"));
  await host.end("root/3", "edit", true, { content: [{ type: "text", text: "Denied \u001b[31mred" }] }, "root");
  const evil = host.last().proposals.find(p => p.toolCallId === "root/3")!;
  assert.doesNotMatch(evil.path + evil.preview + evil.error, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.equal(evil.path, "evil�]0;t�.ts");
  assert.equal(evil.preview, "- old�[2J\n+ new��");
  assert.equal(evil.error, "Denied �[31mred");
});

test("a throwing consumer never affects the tool pipeline", async () => {
  const handlers = new Map<string, Array<(event: Event) => unknown>>();
  extension({
    on(name: string, handler: (event: Event) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool() {}, registerToolRenderer() {},
    events: { emit() { throw new Error("consumer bug"); }, on() { return () => {}; } },
  } as unknown as ExtensionAPI);
  for (const event of [
    { type: "tool_execution_start", toolCallId: "root", toolName: "codemode" },
    { type: "tool_execution_start", toolCallId: "root/1", toolName: "edit", parentToolCallId: "root", args: edit("a", "b") },
    { type: "agent_end" },
  ]) for (const handler of handlers.get(event.type) ?? []) await handler(event);
});

test("real Pi: the snapshot holds the proposal when a tool_call gate handler starts", { timeout: 30_000 }, async t => {
  const seen: Array<ProposalsEvent["proposals"]> = [];
  let latest: ProposalsEvent | undefined;
  const fixture = await runtimeFixture(t, { extraExtensions: [pi => {
    pi.events.on(PROPOSALS_EVENT, data => { latest = data as ProposalsEvent; });
    pi.on("tool_call", event => {
      if (event.toolName !== "edit") return undefined;
      seen.push(structuredClone(latest?.proposals ?? []));
      return { block: true, reason: "Denied by test gate" };
    });
  }] });
  await writeFile(join(fixture.cwd, "a.txt"), "alpha\n");
  const result = await fixture.codemode('try { await tools.edit({ path: "a.txt", edits: [{ oldText: "alpha", newText: "beta" }] }); } catch {}');
  assert.equal(result.isError, false);
  assert.deepEqual(seen, [[{ toolCallId: "root/1", tool: "edit", path: "a.txt", status: "pending", preview: "- alpha\n+ beta", added: 1, removed: 1 }]]);
  assert.deepEqual(latest, { version: 1, proposals: [] }, "Cleared once the root ends");
});
