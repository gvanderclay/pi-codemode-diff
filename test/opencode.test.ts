import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { DETAILS_KEY, readChanges } from "../src/changes.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

const options = { timeout: 30_000 };

for (const order of ["before", "after"] as const) {
  test(`codemode_o loaded ${order} diff: unchanged output, create/edit/overwrite, rendering and persistence`, options, async t => {
    const fixture = await runtimeFixture(t, { openCode: order });
    const baseline = await runtimeFixture(t, { openCode: order, withoutDiff: true });
    const lines = Array.from({ length: 30 }, (_, i) => `marker-${i + 1}`).join("\n");
    const code = `
      await tools.write({path: "a.txt", content: "before\\n"});
      await tools.edit({path: "a.txt", edits: [{oldText: "before", newText: "after"}]});
      await tools.write({path: "a.txt", content: ${JSON.stringify(lines)}});
      return {status: "kept"};
    `;
    const original = await baseline.codemode(code, "root", undefined, "codemode_o");
    const result = await fixture.codemode(code, "root", undefined, "codemode_o");
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.deepEqual(result.content, original.content);
    assert.deepEqual(result.usage, original.usage);
    const { durationMs: _a, [DETAILS_KEY]: _diff, ...details } = result.details as Record<string, unknown>;
    const { durationMs: _b, ...originalDetails } = original.details as Record<string, unknown>;
    assert.deepEqual(details, originalDetails);
    assert.deepEqual(readChanges(result.details)?.map(change => change.kind), ["create", "edit", "overwrite"]);
    assert.equal(await readFile(join(fixture.cwd, "a.txt"), "utf8"), lines);
    assert.deepEqual(result.nestedCalls?.calls.map(call => call.name), ["write", "edit", "write"]);
    assert.equal(JSON.stringify(result.content).includes(DETAILS_KEY), false);

    initTheme("dark", false);
    const native = fixture.session.getToolDefinition("codemode_o")!;
    const renderers = fixture.session.extensionRunner.resolveToolRenderers("codemode_o", () => native)!;
    assert.strictEqual(renderers.renderCall, native.renderCall);
    assert.equal(renderers.renderShell, native.renderShell);
    const component = new ToolExecutionComponent("codemode_o", "root", { code }, {}, { ...native, ...renderers }, { requestRender() {} } as TUI, fixture.cwd);
    component.setArgsComplete();
    // Exercise the real downstream warning/truncation/duration display, too.
    component.updateResult({ ...result, details: { ...result.details as object, warnings: [{ kind: "Test", message: "notice" }], truncated: true } });
    const visible = () => stripVTControlCharacters(component.render(100).join("\n"));
    assert.match(visible(), /codemode_o/);
    assert.match(visible(), /File changes \(3\)/);
    assert.match(visible(), /1 warning/);
    assert.match(visible(), /Output truncated/);
    assert.match(visible(), /Took /);
    assert.doesNotMatch(visible(), /\+30 marker-30/);
    component.setExpanded(true);
    assert.match(visible(), /\+30 marker-30/);
    assert.match(visible(), /"status"/);
    component.setExpanded(false);
    assert.doesNotMatch(visible(), /\+30 marker-30/);

    const resumed = await fixture.resume();
    const restored = resumed.messages.find(message => message.role === "toolResult" && message.toolCallId === "root");
    assert.ok(restored && restored.role === "toolResult");
    assert.deepEqual(readChanges(restored.details), readChanges(result.details));
    await fixture.session.reload();
    const old = fixture.session.messages.find(message => message.role === "toolResult" && message.toolCallId === "root");
    assert.ok(old && old.role === "toolResult");
    assert.deepEqual(readChanges(old.details), readChanges(result.details));
    const next = await fixture.codemode('return await tools.write({path: "a.txt", content: "reloaded"});', "next", undefined, "codemode_o");
    assert.equal(next.isError, false);
    assert.equal(readChanges(next.details)?.[0].kind, "overwrite");
  });
}

test("real mixed codemode and codemode_o calls keep separate batches", options, async t => {
  const fixture = await runtimeFixture(t, { openCode: "after" });
  const results = await fixture.run(["codemode", "codemode_o"].map(name => ({
    id: name, name, arguments: { code: `await tools.write({path: "${name}.txt", content: "${name}"});` },
  })));
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.isError, false);
    assert.deepEqual(readChanges(result.details)?.map(change => change.path), [`${result.toolName}.txt`]);
    assert.equal(result.nestedCalls?.calls.length, 1);
  }
});

test("codemode_o failure keeps a completed write without automatic replay", options, async t => {
  const fixture = await runtimeFixture(t, { openCode: "before" });
  const result = await fixture.codemode('await tools.write({path: "kept.txt", content: "once"}); return await tools.read({path: "missing"});', "root", undefined, "codemode_o");
  assert.equal(result.isError, true);
  assert.equal(readChanges(result.details)?.length, 1);
  assert.equal(await readFile(join(fixture.cwd, "kept.txt"), "utf8"), "once");
  assert.deepEqual(result.nestedCalls?.calls.map(call => call.name), ["write", "read"]);
  assert.equal(fixture.session.messages.filter(message => message.role === "toolResult").length, 1);
});

for (const denied of ["blocked", "disabled", "native-required"]) {
  test(`codemode_o ${denied} write has no mutation or diff`, options, async t => {
    const fixture = await runtimeFixture(t, {
      openCode: "after",
      ...(denied === "disabled" ? { tools: ["read", "codemode", "codemode_o"] } : {}),
      extraExtensions: denied === "blocked" ? [pi => {
        pi.on("tool_call", event => event.toolName === "write" ? { block: true, reason: "Test policy" } : undefined);
      }] : [],
    });
    const code = (denied === "native-required" ? "text(1); " : "") + 'return await tools.write({path: "denied.txt", content: "bad"});';
    const result = await fixture.codemode(code, "root", undefined, "codemode_o");
    assert.equal(result.isError, true);
    assert.equal(readChanges(result.details), undefined);
    await assert.rejects(access(join(fixture.cwd, "denied.txt")), { code: "ENOENT" });
    if (denied === "native-required") assert.match(JSON.stringify(result.details), /NativeCodemodeRequired/);
    if (denied === "disabled") assert.equal(fixture.session.getActiveToolNames().includes("write"), false);
  });
}
