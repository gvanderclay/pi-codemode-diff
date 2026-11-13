import assert from "node:assert/strict";
import { test } from "node:test";
import { DisplayBudget, cutLines } from "../src/budget.ts";
import { DETAILS_KEY, limitChange, readChanges, type Change } from "../src/changes.ts";
import { MAX_BATCH_DIFF_BYTES, MAX_BATCH_DIFF_LINES, MAX_DIFF_BYTES } from "../src/limits.ts";
import { limitProposal, type Proposal } from "../src/proposals.ts";

test("charges count UTF-8 bytes and logical lines, and rejected keys hold nothing", () => {
  const budget = new DisplayBudget(10, 5);
  const text = "가\r\nx\r";
  assert.equal(budget.charge("a", text), true);
  assert.deepEqual(budget.remaining(), { bytes: 3, lines: 3 });
  assert.equal(budget.charge("b", "xxxx"), false);
  assert.deepEqual(budget.remaining(), { bytes: 3, lines: 3 });
  budget.release("b");
  assert.deepEqual(budget.remaining(), { bytes: 3, lines: 3 });
  assert.equal(budget.charge("b", "xxx"), true);
  assert.deepEqual(budget.remaining(), { bytes: 0, lines: 2 });
});

test("re-charging a key refunds its previous charge before checking the replacement", () => {
  const budget = new DisplayBudget(100, 10);
  assert.equal(budget.charge("a", "x".repeat(60)), true);
  assert.equal(budget.charge("b", "y".repeat(40)), true);
  assert.equal(budget.charge("a", "z".repeat(10)), true);
  assert.deepEqual(budget.remaining(), { bytes: 50, lines: 8 });
  assert.equal(budget.charge("a", "z".repeat(61)), false);
  assert.deepEqual(budget.remaining(), { bytes: 60, lines: 9 });
  budget.release("a");
  assert.deepEqual(budget.remaining(), { bytes: 60, lines: 9 });
});

test("release refunds exactly and unknown or repeated releases are no-ops", () => {
  const budget = new DisplayBudget(100, 10);
  assert.equal(budget.charge("a", "가\n나"), true);
  assert.equal(budget.charge("b", "x"), true);
  budget.release("unknown");
  assert.deepEqual(budget.remaining(), { bytes: 92, lines: 7 });
  budget.release("a");
  assert.deepEqual(budget.remaining(), { bytes: 99, lines: 9 });
  budget.release("a");
  assert.deepEqual(budget.remaining(), { bytes: 99, lines: 9 });
  budget.release("b");
  assert.deepEqual(budget.remaining(), { bytes: 100, lines: 10 });
});

test("line charges enforce their own limit independently of bytes", () => {
  const budget = new DisplayBudget(1_000, 2);
  assert.equal(budget.charge("a", "one\ntwo\n"), true);
  assert.deepEqual(budget.remaining(), { bytes: 992, lines: 0 });
  assert.equal(budget.charge("b", "x"), false);
  assert.deepEqual(budget.remaining(), { bytes: 992, lines: 0 });
  assert.equal(budget.charge("empty", ""), true);
  assert.deepEqual(budget.remaining(), { bytes: 992, lines: 0 });
});

test("default display budgets match the batch limits", () => {
  assert.deepEqual(new DisplayBudget().remaining(), { bytes: MAX_BATCH_DIFF_BYTES, lines: MAX_BATCH_DIFF_LINES });
});

const trailer = (dropped: number) => `… ${dropped} more lines`;

test("cutLines joins fitting lines without a trailer", () => {
  assert.equal(cutLines(["one", "two", "three"], 100, 3, trailer), "one\ntwo\nthree");
  assert.equal(cutLines([], 100, 3, trailer), "");
});

test("cutLines reserves a trailer line and counts every dropped line", () => {
  const result = cutLines(["one", "two", "three", "four", "five"], 100, 3, trailer);
  assert.equal(result, "one\ntwo\n" + trailer(3));
  assert.equal(result.split("\n").length, 3);
});

test("cutLines reserves UTF-8 bytes for the trailer when cutting by bytes", () => {
  const lines = ["가".repeat(5), "나".repeat(5), "다".repeat(5), "라".repeat(5)];
  const maxBytes = 35;
  const result = cutLines(lines, maxBytes, 10, trailer);
  assert.equal(result, lines[0] + "\n" + trailer(3));
  assert.ok(Buffer.byteLength(result, "utf8") <= maxBytes);
  assert.ok(result.endsWith(trailer(3)));
});

test("cutLines keeps a fitting single last line without reserving trailer space", () => {
  assert.equal(cutLines(["가"], 3, 1, trailer), "가");
});

test("cutLines can spend the remaining bytes on the last line", () => {
  const lines = ["first", "x".repeat(20)];
  assert.equal(cutLines(lines, 26, 2, trailer), lines.join("\n"));
});

const change = (id: string, diff: string): Change => ({
  toolCallId: id, tool: "edit", path: "a", kind: "edit", diff,
});

test("per-diff omissions do not charge the display budget", () => {
  const budget = new DisplayBudget();
  const oversized = limitChange(change("a", "x".repeat(MAX_DIFF_BYTES + 1)), budget);
  assert.equal(oversized.diff, undefined);
  assert.equal(oversized.note, "Diff omitted: diff too large.");
  assert.deepEqual(budget.remaining(), { bytes: MAX_BATCH_DIFF_BYTES, lines: MAX_BATCH_DIFF_LINES });
});

test("resumed Changes with repeated call IDs are charged independently", () => {
  const changes = Array.from({ length: 5 }, () => change("same", "x".repeat(MAX_DIFF_BYTES)));
  const bounded = readChanges({ [DETAILS_KEY]: { version: 1, changes } })!;
  assert.equal(bounded.filter(item => item.diff !== undefined).length, 4);
  assert.equal(bounded[4].note, "Diff omitted: codemode diff budget exceeded.");
  assert.ok(changes.every(item => item.diff !== undefined), "Persisted data is not mutated");
});

test("Change and Proposal budget omissions retain their original notices and metadata", () => {
  const budget = new DisplayBudget(1, 1);
  assert.deepEqual(limitChange({ ...change("a", "xx"), note: "Original note." }, budget), {
    toolCallId: "a", tool: "edit", path: "a", kind: "edit",
    note: "Diff omitted: codemode diff budget exceeded. Original note.",
  });
  const proposal: Proposal = { toolCallId: "a", tool: "edit", path: "a", status: "pending", diff: "xx", added: 1 };
  assert.deepEqual(limitProposal(proposal, budget), {
    toolCallId: "a", tool: "edit", path: "a", status: "pending", added: 1,
    note: "Preview omitted: codemode preview budget exceeded.",
  });
  assert.deepEqual(budget.remaining(), { bytes: 1, lines: 1 });
});
