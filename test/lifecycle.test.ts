import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { Capture } from "../src/capture.ts";
import { DETAILS_KEY, type Change } from "../src/changes.ts";
import { NestedCallLifecycle } from "../src/lifecycle.ts";
import type { Proposal } from "../src/proposals.ts";

type Step =
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; parentToolCallId?: string; args?: unknown }
  | {
    type: "tool_result"; toolCallId: string; toolName: string; parentToolCallId?: string;
    input?: Record<string, unknown>; content?: unknown[]; details?: unknown; isError?: boolean;
  }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; parentToolCallId?: string; isError: boolean; result?: unknown };

interface Case {
  name: string;
  prepareEdit?: (args: unknown) => unknown;
  steps: Step[];
  /** Relevant Change fields, in capture order. */
  changes: unknown[];
  /** Relevant Proposal fields, in capture order. */
  proposals: unknown[];
  /** What the root's tool_result handler returned; undefined when the case delivers no root result. */
  rootResult?: unknown;
}

const EDIT_ARGS = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
const rootStart = (toolName = "codemode"): Step => ({ type: "tool_execution_start", toolCallId: "root", toolName });
const editStart = (args: unknown = EDIT_ARGS): Step =>
  ({ type: "tool_execution_start", toolCallId: "root/1", toolName: "edit", parentToolCallId: "root", args });
const editResult = (details: unknown, isError = false, content: unknown[] = []): Step => ({
  type: "tool_result", toolCallId: "root/1", toolName: "edit", parentToolCallId: "root",
  input: { path: "a.ts" }, content, details, isError,
});
const editEnd = (isError = false, result: unknown = { content: [] }): Step => ({
  type: "tool_execution_end", toolCallId: "root/1", toolName: "edit", parentToolCallId: "root", isError, result,
});
const rootResult = (toolName: string, details: unknown): Step => ({
  type: "tool_result", toolCallId: "root", toolName, input: {},
  content: [{ type: "text", text: "Script output only" }], details, isError: false,
});

const EDIT_CHANGE = { toolCallId: "root/1", tool: "edit", path: "a.ts", kind: "edit", diff: "-1 a\n+1 b" };
const PENDING_EDIT = { toolCallId: "root/1", tool: "edit", path: "a.ts", status: "pending", diff: "- a\n+ b" };

const cases: Case[] = [
  {
    name: "a successful nested edit records its display diff and drops the proposal",
    steps: [rootStart(), editStart(), editResult({ diff: "-1 a\n+1 b" }), editEnd()],
    changes: [EDIT_CHANGE],
    proposals: [],
  },
  {
    name: "a nested edit result without a display diff records a notice instead",
    steps: [rootStart(), editStart(), editResult(undefined), editEnd()],
    changes: [{ toolCallId: "root/1", tool: "edit", path: "a.ts", kind: "edit", note: "The edit tool did not provide a display diff." }],
    proposals: [],
  },
  {
    name: "a call blocked before execution leaves an unverified proposal and no Change",
    steps: [rootStart(), editStart(), editEnd(true, { content: [{ type: "text", text: "Denied\nmore" }] })],
    changes: [],
    proposals: [{ ...PENDING_EDIT, status: "unverified", error: "Denied" }],
  },
  {
    name: "the first reported error wins when the end event repeats one",
    steps: [
      rootStart(), editStart(),
      editResult(undefined, true, [{ type: "text", text: "Failed to match\nmore" }]),
      editEnd(true, { content: [{ type: "text", text: "Failed to match" }] }),
    ],
    changes: [],
    proposals: [{ ...PENDING_EDIT, status: "unverified", error: "Failed to match" }],
  },
  {
    name: "an extension that flips isError to false settles the call without a Change",
    steps: [
      rootStart(), editStart(),
      editResult(undefined, true, [{ type: "text", text: "Denied" }]),
      editEnd(false),
    ],
    changes: [],
    proposals: [],
  },
  {
    name: "a nested write start publishes a pending proposal; its Change comes from the write tool",
    steps: [
      rootStart(),
      { type: "tool_execution_start", toolCallId: "root/1", toolName: "write", parentToolCallId: "root", args: { path: "b.ts", content: "x\n" } },
    ],
    changes: [],
    proposals: [{ toolCallId: "root/1", tool: "write", path: "b.ts", status: "pending", diff: "  x" }],
  },
  {
    name: "a root that is not the exact codemode tool records nothing and returns no details",
    steps: [
      rootStart("codemode_x"), editStart(), editResult({ diff: "-1 a\n+1 b" }), editEnd(),
      rootResult("codemode_x", { calls: [] }),
    ],
    changes: [],
    proposals: [],
    rootResult: undefined,
  },
  {
    name: "the root result keeps its existing details and adds the recorded Changes",
    steps: [
      rootStart(), editStart(), editResult({ diff: "-1 a\n+1 b" }),
      rootResult("codemode", { calls: [{ id: "root/1", name: "edit", status: "ok" }], fullOutputPath: "/tmp/output" }),
    ],
    changes: [EDIT_CHANGE],
    proposals: [],
    rootResult: {
      details: {
        calls: [{ id: "root/1", name: "edit", status: "ok" }],
        fullOutputPath: "/tmp/output",
        [DETAILS_KEY]: { version: 1, changes: [EDIT_CHANGE] },
      },
    },
  },
  {
    name: "the root's end removes its batch",
    steps: [
      rootStart(), editStart(), editResult({ diff: "-1 a\n+1 b" }), editEnd(),
      { type: "tool_execution_end", toolCallId: "root", toolName: "codemode", isError: false, result: {} },
    ],
    changes: [],
    proposals: [],
  },
  {
    // editProposal() itself catches a throwing prepare and substitutes this notice, so the
    // call still gets a proposal: it just never carries a diff derived from unreadable arguments.
    name: "a prepareEdit that throws leaves a safe notice and never throws",
    prepareEdit: () => { throw new Error("boom"); },
    steps: [rootStart(), editStart()],
    changes: [],
    proposals: [{ toolCallId: "root/1", tool: "edit", path: "a.ts", status: "pending", note: "Preview unavailable: the edit arguments could not be read." }],
  },
];

/** Only the fields these cases assert; JSON drops absent ones so the table stays short. */
function summarizeChange(change: Change): unknown {
  return JSON.parse(JSON.stringify({
    toolCallId: change.toolCallId, tool: change.tool, path: change.path, kind: change.kind,
    diff: change.diff, note: change.note,
  }));
}

function summarizeProposal(proposal: Proposal): unknown {
  return JSON.parse(JSON.stringify({
    toolCallId: proposal.toolCallId, tool: proposal.tool, path: proposal.path, status: proposal.status,
    diff: proposal.diff, error: proposal.error, note: proposal.note,
  }));
}

/** Drives the lifecycle with plain event objects: no ExtensionAPI and no host event bus. */
function drive(item: Case) {
  const capture = new Capture();
  const lifecycle = new NestedCallLifecycle(capture, item.prepareEdit);
  let rootReturn: ToolResultEventResult | undefined;
  for (const step of item.steps) {
    if (step.type === "tool_execution_start") {
      lifecycle.executionStarted(step as unknown as ToolExecutionStartEvent);
    } else if (step.type === "tool_result") {
      const result = lifecycle.toolResult(step as unknown as ToolResultEvent);
      if (step.toolCallId === "root") rootReturn = result;
    } else {
      lifecycle.executionEnded(step as unknown as ToolExecutionEndEvent);
    }
  }
  return {
    changes: capture.changes("root").map(summarizeChange),
    proposals: capture.proposals("root").map(summarizeProposal),
    rootResult: rootReturn === undefined ? undefined : JSON.parse(JSON.stringify(rootReturn)),
  };
}

for (const item of cases) {
  test(item.name, () => {
    const actual = drive(item);
    assert.deepEqual(actual.changes, item.changes, "capture.changes(\"root\")");
    assert.deepEqual(actual.proposals, item.proposals, "capture.proposals(\"root\")");
    assert.deepEqual(actual.rootResult, item.rootResult, "the root's tool_result return value");
  });
}
