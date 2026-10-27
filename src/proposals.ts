import { diffLines } from "diff";
import { asRecord } from "./changes.ts";
import {
  MAX_DIFF_BYTES, MAX_DIFF_LINES, MAX_TEXT_BYTES, MAX_TEXT_LINES, lineCount, textFits,
} from "./limits.ts";

/**
 * A nested edit/write built from the call's supplied arguments only, before any
 * permission gate runs. Display-only and session-local: never persisted in
 * tool result details or shown to the model. It is a replacement preview, not
 * a dry run: the file is not read, so matching is not checked.
 */
export interface Proposal {
  toolCallId: string;
  tool: "edit" | "write";
  path: string;
  /**
   * "unverified": the call ended with an error. That may be a denial, a failed
   * match or a cancellation, and an error does not prove the file is unchanged.
   */
  status: "pending" | "unverified";
  /** First non-empty line of the call's error text, bounded (sanitized when rendered). */
  error?: string;
  /** Unnumbered display lines: "- ", "+ ", "  " (context) or "· " (replacement header). */
  diff?: string;
  /** Edit replacement line counts, from the supplied text. */
  added?: number;
  removed?: number;
  /** Write proposed-content size. */
  bytes?: number;
  lines?: number;
  note?: string;
}

/** Inputs larger than this are summarized instead of diffed (display budget only). */
export const MAX_PROPOSAL_INPUT_BYTES = MAX_TEXT_BYTES;
export const MAX_PROPOSAL_INPUT_LINES = 2 * MAX_TEXT_LINES;
const MAX_PATH_CHARS = 1_024;
/** Bounds the line comparison inside one replacement; beyond it, show plain -/+ lines. */
const MAX_EDIT_LENGTH = 1_000;

const UNAVAILABLE = "Preview unavailable:";

function boundedPath(value: unknown): string {
  if (typeof value !== "string" || !value) return "(no path supplied)";
  return value.length > MAX_PATH_CHARS ? `${value.slice(0, MAX_PATH_CHARS)}…` : value;
}

function displayText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface Replacement { oldText: string; newText: string }

function isReplacement(value: unknown): value is Replacement {
  const item = asRecord(value);
  return typeof item?.oldText === "string" && typeof item.newText === "string";
}

/** Unnumbered lines for one replacement, with context for lines both sides share. */
function replacementLines(oldText: string, newText: string): { lines: string[]; added: number; removed: number } {
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  const parts = diffLines(oldText, newText, { maxEditLength: MAX_EDIT_LENGTH });
  if (!parts) {
    for (const line of splitLines(oldText)) { lines.push(`- ${line}`); removed++; }
    for (const line of splitLines(newText)) { lines.push(`+ ${line}`); added++; }
    return { lines, added, removed };
  }
  for (const part of parts) {
    for (const line of splitLines(part.value)) {
      if (part.removed) { lines.push(`- ${line}`); removed++; }
      else if (part.added) { lines.push(`+ ${line}`); added++; }
      else lines.push(`  ${line}`);
    }
  }
  return { lines, added, removed };
}

type Prepare = (args: unknown) => unknown;

/**
 * Never throws and never touches the filesystem. `prepare` is Pi's own edit
 * argument normalization (JSON-string edits, a single edit object, legacy
 * top-level oldText/newText); it receives a clone because it mutates input.
 */
export function editProposal(toolCallId: string, args: unknown, prepare?: Prepare): Proposal {
  const base = { toolCallId, tool: "edit" as const, status: "pending" as const };
  let prepared: unknown;
  try {
    const clone = structuredClone(args);
    prepared = prepare ? prepare(clone) : clone;
  } catch {
    return { ...base, path: boundedPath(asRecord(args)?.path), note: `${UNAVAILABLE} the edit arguments could not be read.` };
  }
  const input = asRecord(prepared);
  const path = boundedPath(input?.path);
  const edits = input?.edits;
  if (!Array.isArray(edits)) return { ...base, path, note: `${UNAVAILABLE} no edits[] replacements were supplied.` };
  if (!edits.length) return { ...base, path, note: `${UNAVAILABLE} edits[] is empty.` };
  if (!edits.every(isReplacement)) {
    return { ...base, path, note: `${UNAVAILABLE} each replacement needs string oldText and newText.` };
  }
  let inputBytes = 0;
  let inputLines = 0;
  for (const edit of edits) {
    // UTF-8 bytes are never fewer than JS code units: reject long input cheaply.
    inputBytes += edit.oldText.length + edit.newText.length;
    if (inputBytes > MAX_PROPOSAL_INPUT_BYTES) break;
    inputLines += lineCount(edit.oldText, MAX_PROPOSAL_INPUT_LINES) + lineCount(edit.newText, MAX_PROPOSAL_INPUT_LINES);
    if (inputLines > MAX_PROPOSAL_INPUT_LINES) break;
  }
  if (inputBytes > MAX_PROPOSAL_INPUT_BYTES || inputLines > MAX_PROPOSAL_INPUT_LINES) {
    return { ...base, path, note: `Preview omitted: replacement text too large (${edits.length} ${edits.length === 1 ? "replacement" : "replacements"}).` };
  }

  const out: string[] = [];
  let added = 0;
  let removed = 0;
  edits.forEach((edit, index) => {
    const part = replacementLines(displayText(edit.oldText), displayText(edit.newText));
    if (edits.length > 1) out.push(`· replacement ${index + 1}/${edits.length} +${part.added} -${part.removed}`);
    out.push(...part.lines);
    added += part.added;
    removed += part.removed;
  });
  const diff = out.join("\n");
  if (!textFits(diff, MAX_DIFF_BYTES, MAX_DIFF_LINES)) {
    return { ...base, path, added, removed, note: "Preview omitted: proposed diff too large." };
  }
  return { ...base, path, diff, added, removed };
}

/** Proposed write content only: the previous file is never read before approval. */
export function writeProposal(toolCallId: string, args: unknown): Proposal {
  const input = asRecord(args);
  const base = { toolCallId, tool: "write" as const, status: "pending" as const, path: boundedPath(input?.path) };
  const content = input?.content;
  if (typeof content !== "string") return { ...base, note: `${UNAVAILABLE} no string content was supplied.` };
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = lineCount(content, MAX_DIFF_LINES);
  if (bytes > MAX_DIFF_BYTES || lines > MAX_DIFF_LINES) {
    return { ...base, bytes, note: "Preview omitted: proposed content too large." };
  }
  const size = { bytes, lines };
  if (content.includes("\0")) return { ...base, ...size, note: "Binary content; preview unavailable." };
  const display = splitLines(displayText(content)).map(line => `  ${line}`).join("\n");
  if (!textFits(display, MAX_DIFF_BYTES, MAX_DIFF_LINES)) {
    return { ...base, ...size, note: "Preview omitted: proposed content too large." };
  }
  return { ...base, ...size, diff: display };
}

export const MAX_ERROR_CHARS = 200;

/** First non-empty line of a tool result's text blocks, truncated for display. */
export function firstErrorLine(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const item = asRecord(block);
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    for (const raw of item.text.slice(0, 64 * 1024).split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      if (line) return line.length > MAX_ERROR_CHARS ? line.slice(0, MAX_ERROR_CHARS) + "…" : line;
    }
  }
  return undefined;
}

/** Per-root budget, separate from completed diffs. */
export function limitProposal(proposal: Proposal, remainingBytes: number, remainingLines: number): Proposal {
  if (proposal.diff === undefined || textFits(proposal.diff, remainingBytes, remainingLines)) return proposal;
  const { diff: _diff, ...metadata } = proposal;
  return { ...metadata, note: "Preview omitted: codemode preview budget exceeded." };
}
