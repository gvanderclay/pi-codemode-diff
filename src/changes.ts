import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { DisplayBudget } from "./budget.ts";
import { MAX_DIFF_BYTES, MAX_DIFF_LINES, textFits, writeTextFits } from "./limits.ts";
import { displayText } from "./text.ts";

/** Rendering metadata only: never add this payload to model-facing content. */
export const DETAILS_KEY = "piCodemodeDiff";

export interface Change {
  toolCallId: string;
  tool: "edit" | "write";
  path: string;
  kind: "edit" | "create" | "overwrite" | "unknown";
  diff?: string;
  note?: string;
  /** Byte sizes only; omitted snapshots/diffs never retain source content. */
  beforeBytes?: number;
  afterBytes?: number;
  /** A write can complete before the tool observes cancellation. */
  toolReportedError?: boolean;
}

export interface DiffDetails {
  version: 1;
  changes: Change[];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validate persisted data rather than trusting a resumed session's details. */
export function readChanges(details: unknown): Change[] | undefined {
  const payload = asRecord(asRecord(details)?.[DETAILS_KEY]);
  if (payload?.version !== 1 || !Array.isArray(payload.changes)) return undefined;
  const valid = payload.changes.every((value: unknown) => {
    const item = asRecord(value);
    return item !== undefined &&
      typeof item.toolCallId === "string" &&
      (item.tool === "edit" || item.tool === "write") &&
      typeof item.path === "string" &&
      typeof item.kind === "string" &&
      ["edit", "create", "overwrite", "unknown"].includes(item.kind) &&
      (item.diff === undefined || typeof item.diff === "string") &&
      (item.note === undefined || typeof item.note === "string") &&
      (item.beforeBytes === undefined || validSize(item.beforeBytes)) &&
      (item.afterBytes === undefined || validSize(item.afterBytes)) &&
      (item.toolReportedError === undefined || typeof item.toolReportedError === "boolean");
  });
  if (!valid) return undefined;
  // Older sessions may contain unbounded diffs. Bound their display too, without
  // rewriting the saved transcript or changing model-facing results.
  const budget = new DisplayBudget();
  return (payload.changes as Change[]).map((change, index) => limitChange(change, budget, String(index)));
}

function validSize(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Shared by write generation, edit capture, and resumed-session rendering. */
export function limitChange(
  change: Change,
  budget?: DisplayBudget,
  key = change.toolCallId,
): Change {
  if (change.diff === undefined) return change;
  const reason = !textFits(change.diff, MAX_DIFF_BYTES, MAX_DIFF_LINES)
    ? "diff too large"
    : budget && !budget.charge(key, change.diff)
      ? "codemode diff budget exceeded"
      : undefined;
  if (!reason) return change;
  const { diff: _diff, ...metadata } = change;
  return { ...metadata, note: `Diff omitted: ${reason}.${change.note ? ` ${change.note}` : ""}` };
}

export type BeforeWrite =
  | { kind: "missing" }
  | { kind: "text"; content: string }
  | { kind: "omitted"; sizeBytes: number }
  | { kind: "unavailable"; reason: string };

/** The Change kind a write gets from what was there before it. */
export function writeKind(before: BeforeWrite): Change["kind"] {
  if (before.kind === "missing") return "create";
  if (before.kind === "text" || before.kind === "omitted") return "overwrite";
  return "unknown";
}

/** The snapshot is used for presentation, not retained as a file backup. */
export function writeChange(
  toolCallId: string,
  path: string,
  before: BeforeWrite,
  content: string,
): Change {
  const base: Change = {
    toolCallId,
    tool: "write",
    path,
    kind: writeKind(before),
  };
  if (before.kind === "unavailable") return { ...base, note: before.reason };
  if (before.kind === "omitted" || !writeTextFits(content) ||
      (before.kind === "text" && !writeTextFits(before.content))) {
    const beforeBytes = before.kind === "missing" ? 0 : before.kind === "omitted"
      ? before.sizeBytes : Buffer.byteLength(before.content, "utf8");
    const afterBytes = Buffer.byteLength(content, "utf8");
    return {
      ...base, beforeBytes, afterBytes,
      note: `Diff omitted: file too large (byte or line limit; before: ${beforeBytes} bytes; after: ${afterBytes} bytes).`,
    };
  }
  if (content.includes("\0")) return { ...base, note: "Binary content; text diff unavailable." };

  const oldContent = before.kind === "missing" ? "" : before.content;
  const oldDisplay = displayText(oldContent);
  const newDisplay = displayText(content);
  const diff = generateDiffString(oldDisplay, newDisplay).diff;
  let note: string | undefined;
  if (before.kind === "missing" && content.length === 0) {
    note = "Created an empty file.";
  } else if (oldContent === content) {
    note = "No content changes.";
  } else if (oldDisplay === newDisplay) {
    note = "Only line endings or the UTF-8 BOM changed (normalized in this view).";
  }
  const change = limitChange({ ...base, diff, ...(note ? { note } : {}) });
  return change.diff === undefined ? {
    ...change, beforeBytes: Buffer.byteLength(oldContent, "utf8"), afterBytes: Buffer.byteLength(content, "utf8"),
  } : change;
}
