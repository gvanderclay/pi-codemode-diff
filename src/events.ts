import { cutLines } from "./budget.ts";
import type { Proposal } from "./proposals.ts";
import { inlineText, safeText } from "./text.ts";

/** Event bus channel for cross-extension consumers (e.g. permission forwarders). */
export const PROPOSALS_EVENT = "codemode-diff:proposals";
export const MAX_EVENT_PREVIEW_BYTES = 16 * 1024;
export const MAX_EVENT_PREVIEW_LINES = 200;
const MAX_EVENT_LINE_CHARS = 2_000;

/**
 * Version-1 contract. Each emission is a full snapshot of the session's current
 * proposals (all codemode roots); an empty list means none. Display-only:
 * built from call arguments without reading files, never model-facing.
 */
export interface ProposalsEvent {
  version: 1;
  proposals: Array<{
    toolCallId: string;
    tool: "edit" | "write";
    /** Sanitized and bounded, as rendered. */
    path: string;
    status: "pending" | "unverified";
    /** Plain text, sanitized: "- ", "+ ", "  " and "· replacement i/n …" lines; ≤ 16 KiB and ≤ 200 lines. */
    preview?: string;
    added?: number;
    removed?: number;
    note?: string;
    error?: string;
  }>;
}

function boundedPreview(diff: string): string {
  const lines = safeText(diff).split("\n").map(line =>
    line.length > MAX_EVENT_LINE_CHARS ? line.slice(0, MAX_EVENT_LINE_CHARS) + "…" : line);
  return cutLines(lines, MAX_EVENT_PREVIEW_BYTES, MAX_EVENT_PREVIEW_LINES, rest => `… ${rest} more lines`);
}

export function proposalsEvent(proposals: readonly Proposal[]): ProposalsEvent {
  return {
    version: 1,
    proposals: proposals.map(proposal => ({
      toolCallId: proposal.toolCallId,
      tool: proposal.tool,
      path: inlineText(proposal.path),
      status: proposal.status,
      ...(proposal.diff !== undefined ? { preview: boundedPreview(proposal.diff) } : {}),
      ...(proposal.added !== undefined ? { added: proposal.added } : {}),
      ...(proposal.removed !== undefined ? { removed: proposal.removed } : {}),
      ...(proposal.note !== undefined ? { note: inlineText(proposal.note) } : {}),
      ...(proposal.error !== undefined ? { error: inlineText(proposal.error) } : {}),
    })),
  };
}

/**
 * Returns a listener that emits a proposals snapshot only when it differs from
 * the last one emitted (starting from the empty snapshot). Never throws.
 */
export function proposalsPublisher(emit: (event: ProposalsEvent) => void): (proposals: readonly Proposal[]) => void {
  let lastSnapshot = JSON.stringify(proposalsEvent([]));
  return (proposals) => {
    try {
      const event = proposalsEvent(proposals);
      const snapshot = JSON.stringify(event);
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      emit(event);
    } catch {
      // Never throw into the tool pipeline.
    }
  };
}
