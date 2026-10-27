import assert from "node:assert/strict";
import { test } from "node:test";
import { createEditToolDefinition, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Capture } from "../src/capture.ts";
import { DETAILS_KEY, readChanges } from "../src/changes.ts";
import { MAX_BATCH_DIFF_LINES, MAX_DIFF_BYTES, MAX_DIFF_LINES } from "../src/limits.ts";
import { editProposal, MAX_PROPOSAL_INPUT_BYTES, writeProposal, type Proposal } from "../src/proposals.ts";
import { PREVIEW_CHANGES, proposalSection, registerDiffRenderer } from "../src/render.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;
const prepare = createEditToolDefinition("/nonexistent-cwd").prepareArguments as (args: unknown) => unknown;

function text(component: Component, width = 100): string {
  return component.render(width).map(line => line.trimEnd()).join("\n");
}

function nestedCapture(...ids: string[]): Capture {
  const capture = new Capture();
  capture.start("root", "codemode");
  for (const id of ids) capture.start(id, id.includes("w") ? "write" : "edit", "root");
  return capture;
}

test("a replacement renders as unnumbered -/+ lines with shared lines as context", () => {
  const proposal = editProposal("root/1", {
    path: "src/a.ts",
    edits: [{ oldText: "keep\nconst x = 1;\n", newText: "keep\nconst x = 2;\nconst y = 3;\n" }],
  }, prepare);
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.path, "src/a.ts");
  assert.equal(proposal.diff, "  keep\n- const x = 1;\n+ const x = 2;\n+ const y = 3;");
  assert.deepEqual([proposal.added, proposal.removed], [2, 1]);
  assert.doesNotMatch(proposal.diff!, /^[+-]\s*\d/m, "No invented file line numbers");
});

test("multiple replacements are separated and counted individually and in total", () => {
  const proposal = editProposal("root/1", {
    path: "a",
    edits: [{ oldText: "one", newText: "uno" }, { oldText: "two\nthree", newText: "" }],
  }, prepare);
  assert.equal(proposal.diff, "· replacement 1/2 +1 -1\n- one\n+ uno\n· replacement 2/2 +0 -2\n- two\n- three");
  assert.deepEqual([proposal.added, proposal.removed], [1, 3]);
});

test("Pi's normalization handles JSON-string, single-object and legacy edit arguments", () => {
  const raw = { path: "a", edits: JSON.stringify([{ oldText: "x", newText: "y" }]) };
  const frozen = JSON.stringify(raw);
  for (const args of [
    raw,
    { path: "a", edits: { oldText: "x", newText: "y" } },
    { path: "a", oldText: "x", newText: "y" },
    { path: "a", edits: JSON.stringify({ oldText: "x", newText: "y" }) },
  ]) {
    const proposal = editProposal("root/1", args, prepare);
    assert.equal(proposal.diff, "- x\n+ y", JSON.stringify(args));
    assert.equal(proposal.note, undefined);
  }
  assert.equal(JSON.stringify(raw), frozen, "The tool's own arguments must not be normalized in place");
});

test("malformed or empty edit arguments produce a safe notice", () => {
  const cases: Array<[unknown, RegExp]> = [
    [undefined, /no edits\[\]/],
    ["not an object", /no edits\[\]/],
    [{ path: "a" }, /no edits\[\]/],
    [{ path: "a", edits: "{not json" }, /no edits\[\]/],
    [{ path: "a", edits: [] }, /empty/],
    [{ path: "a", edits: [{ oldText: 1, newText: "x" }] }, /string oldText and newText/],
    [{ path: "a", edits: [null] }, /string oldText and newText/],
    [{ path: "a", edits: [{ oldText: "x", newText: "y" }], fn: () => 1 }, /could not be read/],
  ];
  for (const [args, note] of cases) {
    const proposal = editProposal("root/1", args, prepare);
    assert.equal(proposal.diff, undefined);
    assert.match(proposal.note!, note, JSON.stringify(args));
    assert.ok(proposal.path.length > 0);
  }
  assert.match(editProposal("root/1", { edits: [] }, prepare).path, /no path supplied/);
  const throwing = editProposal("root/1", { path: "a", edits: [] }, () => { throw new Error("boom"); });
  assert.match(throwing.note!, /could not be read/);
});

test("oversized inputs and diffs are omitted with a notice", () => {
  const big = "x".repeat(MAX_PROPOSAL_INPUT_BYTES + 1);
  assert.match(editProposal("root/1", { path: "a", edits: [{ oldText: big, newText: "" }] }, prepare).note!, /too large/);
  const many = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => "line " + i).join("\n");
  const omitted = editProposal("root/1", { path: "a", edits: [{ oldText: "a", newText: many }] }, prepare);
  assert.equal(omitted.diff, undefined);
  assert.match(omitted.note!, /proposed diff too large/);
  const long = "p".repeat(10_000);
  assert.ok(editProposal("root/1", { path: long, edits: [] }, prepare).path.length < 1_100);
});

test("write proposals show bounded proposed content and size only", () => {
  const proposal = writeProposal("root/w1", { path: "new.txt", content: "a\n+b\n" });
  assert.equal(proposal.diff, "  a\n  +b");
  assert.deepEqual([proposal.bytes, proposal.lines], [5, 2]);
  assert.match(writeProposal("root/w1", { path: "x", content: "x".repeat(MAX_DIFF_BYTES + 1) }).note!, /too large/);
  assert.match(writeProposal("root/w1", { path: "x", content: "a\0b" }).note!, /Binary/);
  assert.match(writeProposal("root/w1", { path: "x" }).note!, /unavailable/);
  const rendered = text(proposalSection([proposal], true, theme));
  assert.match(rendered, /\[write · proposed content\] 5 bytes · 2 lines/);
  assert.doesNotMatch(rendered, /overwrite|· new|create/);
});

test("capture keeps proposals per call id, separate from completed diffs", () => {
  const capture = nestedCapture("root/1", "root/2", "root/3");
  let redraws = 0;
  capture.watch("root", () => { redraws++; });
  capture.propose(editProposal("root/1", { path: "same.ts", edits: [{ oldText: "a", newText: "b" }] }, prepare));
  capture.propose(editProposal("root/2", { path: "same.ts", edits: [{ oldText: "c", newText: "d" }] }, prepare));
  capture.propose(editProposal("root/3", { path: "other.ts", edits: [{ oldText: "e", newText: "f" }] }, prepare));
  assert.equal(redraws, 3);
  assert.deepEqual(capture.proposals("root").map(p => [p.toolCallId, p.path, p.diff]), [
    ["root/1", "same.ts", "- a\n+ b"], ["root/2", "same.ts", "- c\n+ d"], ["root/3", "other.ts", "- e\n+ f"],
  ]);
  assert.equal(capture.details("root"), undefined, "Proposals never become persisted details");

  capture.add({ toolCallId: "root/1", tool: "edit", path: "same.ts", kind: "edit", diff: "-1 a\n+1 b" });
  capture.reportError("root/2");
  capture.settle("root/3");
  assert.deepEqual(capture.proposals("root").map(p => [p.toolCallId, p.status]), [["root/2", "not-applied"]]);
  const details = JSON.stringify(capture.details("root"));
  assert.deepEqual(capture.details("root")!.changes.map(c => c.toolCallId), ["root/1"]);
  assert.doesNotMatch(details, /not-applied|pending|- c/);

  capture.end("root");
  assert.deepEqual(capture.proposals("root"), []);
});

test("capture ignores proposals for direct calls and drops them on clear", () => {
  const capture = new Capture();
  capture.start("direct", "edit");
  capture.propose(editProposal("direct", { path: "a", edits: [{ oldText: "a", newText: "b" }] }, prepare));
  assert.deepEqual(capture.proposals("direct"), []);
  const nested = nestedCapture("root/1");
  nested.propose(editProposal("root/1", { path: "a", edits: [{ oldText: "a", newText: "b" }] }, prepare));
  nested.clear();
  assert.deepEqual(nested.proposals("root"), []);
});

test("the per-root proposal budget is independent of the completed-diff budget", () => {
  const ids = Array.from({ length: 6 }, (_, i) => "root/" + (i + 1));
  const capture = nestedCapture(...ids);
  const lines = Array.from({ length: 1_500 }, (_, i) => "l" + i).join("\n");
  for (const id of ids) capture.propose(editProposal(id, { path: id, edits: [{ oldText: "x", newText: lines }] }, prepare));
  const proposals = capture.proposals("root");
  const kept = proposals.filter(p => p.diff !== undefined);
  assert.equal(kept.length, Math.floor(MAX_BATCH_DIFF_LINES / 1_501));
  assert.ok(proposals.slice(kept.length).every(p => /budget exceeded/.test(p.note!)));
  // Replacing a proposal by its completed diff frees its preview budget.
  capture.add({ toolCallId: "root/1", tool: "edit", path: "root/1", kind: "edit", diff: "+1 x" });
  capture.propose(editProposal("root/6", { path: "root/6", edits: [{ oldText: "x", newText: lines }] }, prepare));
  assert.ok(capture.proposals("root").find(p => p.toolCallId === "root/6")!.diff);
  assert.equal(capture.details("root")!.changes[0].diff, "+1 x");
});

test("the section is labelled not applied, lists pending calls first and bounds the collapsed view", () => {
  const proposals: Proposal[] = Array.from({ length: PREVIEW_CHANGES + 2 }, (_, i) => ({
    toolCallId: "root/" + i, tool: "edit", path: "file-" + i + ".ts", status: i === 0 ? "not-applied" : "pending",
    diff: Array.from({ length: 20 }, (_, j) => "+ added-" + i + "-" + j).join("\n"), added: 20, removed: 0,
  }));
  const collapsed = text(proposalSection(proposals, false, theme));
  assert.match(collapsed, /Proposed \(not applied\) \(5\)/);
  assert.match(collapsed, /not a dry run/);
  assert.match(collapsed, /file-1\.ts \[edit · proposed\] \+20 -0/);
  assert.doesNotMatch(collapsed, /file-0\.ts/, "Pending calls come before calls that are already settled");
  assert.match(collapsed, /2 more proposed/);
  assert.doesNotMatch(collapsed, /added-1-19/);
  const full = text(proposalSection(proposals, true, theme));
  assert.match(full, /file-0\.ts[^\n]*\nNot applied: the call was blocked, failed or cancelled\./);
  assert.match(full, /added-4-19/);
  assert.equal(text(proposalSection([], true, theme)), "");
});

test("terminal control characters in paths and replacement text are sanitized", () => {
  const proposal = editProposal("root/1", {
    path: "evil\u001b]0;title\u0007\npath",
    edits: [{ oldText: "a\u001b[2J\tb", newText: "c\u009bd\r\ne" }],
  }, prepare);
  const rendered = text(proposalSection([proposal], true, theme));
  assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.match(rendered, /evil�\]0;title�\\npath/);
  assert.match(rendered, /- a�\[2J   b/);
  assert.match(rendered, /\+ c�d\n\+ e/);
});

test("the wrapped card shows proposals only while partial and never from saved details", () => {
  let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  const capture = nestedCapture("root/1");
  registerDiffRenderer({ registerToolRenderer(value: typeof resolver) { resolver = value; } } as unknown as ExtensionAPI, capture);
  const render = resolver!("codemode", () => ({ renderResult: () => new Text("running", 0, 0) }))!.renderResult!;
  let invalidated = 0;
  const context: Parameters<typeof render>[3] = {
    ...{ durationMs: undefined, outputPad: 0 },
    args: {}, toolCallId: "root", invalidate() { invalidated++; }, lastComponent: undefined,
    state: {}, cwd: "/tmp", executionStarted: true, argsComplete: true, isPartial: true,
    expanded: false, showImages: true, isError: false,
  };
  const first = render({ content: [], details: {} }, { expanded: false, isPartial: true }, theme, context);
  assert.doesNotMatch(text(first), /Proposed/);
  capture.propose(editProposal("root/1", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] }, prepare));
  assert.equal(invalidated, 1, "A new proposal redraws the live card");
  const partial = render({ content: [], details: {} }, { expanded: false, isPartial: true }, theme, { ...context, lastComponent: first });
  assert.match(text(partial), /Proposed \(not applied\) \(1\)[\s\S]*a\.ts \[edit · proposed\] \+1 -1[\s\S]*- old\n\+ new/);
  const final = render({ content: [], details: { [DETAILS_KEY]: { version: 1, changes: [] } } }, { expanded: false, isPartial: false }, theme, { ...context, isPartial: false, lastComponent: partial });
  assert.doesNotMatch(text(final), /Proposed/);
  assert.equal(readChanges({ [DETAILS_KEY]: { version: 1, changes: [] } })?.length, 0);
});
