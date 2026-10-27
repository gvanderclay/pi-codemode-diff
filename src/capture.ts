import { isCodemodeTool } from "./tools.ts";
import { limitChange, type Change, type DiffDetails } from "./changes.ts";
import { MAX_BATCH_DIFF_BYTES, MAX_BATCH_DIFF_LINES, lineCount } from "./limits.ts";
import { limitProposal, type Proposal } from "./proposals.ts";

interface Call {
  rootId: string;
  order: number;
}

interface Batch {
  callIds: Set<string>;
  changes: Map<string, Change>;
  nextOrder: number;
  diffBytes: number;
  diffLines: number;
  /** Pre-approval previews: a separate map and budget, never part of details(). */
  proposals: Map<string, Proposal>;
  proposalBytes: number;
  proposalLines: number;
  invalidate?: () => void;
}

/** Session-local, keyed by call id: parallel codemode calls cannot mix data. */
export class Capture {
  private calls = new Map<string, Call>();
  private batches = new Map<string, Batch>();

  start(id: string, name: string, parentId?: string): void {
    const parentRoot = parentId ? this.calls.get(parentId)?.rootId : undefined;
    if (!parentRoot && !isCodemodeTool(name)) return;
    const rootId = parentRoot ?? id;
    let batch = this.batches.get(rootId);
    if (!batch) {
      batch = {
        callIds: new Set(), changes: new Map(), nextOrder: 0, diffBytes: 0, diffLines: 0,
        proposals: new Map(), proposalBytes: 0, proposalLines: 0,
      };
      this.batches.set(rootId, batch);
    }
    batch.callIds.add(id);
    this.calls.set(id, { rootId, order: batch.nextOrder++ });
  }

  rootFor(id: string): string | undefined {
    return this.calls.get(id)?.rootId;
  }

  isNested(id: string): boolean {
    const root = this.rootFor(id);
    return root !== undefined && root !== id;
  }

  add(change: Change): void {
    const rootId = this.rootFor(change.toolCallId);
    const batch = rootId ? this.batches.get(rootId) : undefined;
    if (!batch) return;
    const previous = batch.changes.get(change.toolCallId)?.diff ?? "";
    const bytes = batch.diffBytes - Buffer.byteLength(previous, "utf8");
    const lines = batch.diffLines - lineCount(previous);
    const bounded = limitChange(change, MAX_BATCH_DIFF_BYTES - bytes, MAX_BATCH_DIFF_LINES - lines);
    batch.changes.set(change.toolCallId, bounded);
    batch.diffBytes = bytes + Buffer.byteLength(bounded.diff ?? "", "utf8");
    batch.diffLines = lines + lineCount(bounded.diff ?? "");
    // The completed diff replaces the call's proposal.
    this.deleteProposal(batch, change.toolCallId);
    this.redraw(batch);
  }

  /** Record a nested call's pre-approval preview; only nested calls are accepted. */
  propose(proposal: Proposal): void {
    if (!this.isNested(proposal.toolCallId)) return;
    const batch = this.batches.get(this.rootFor(proposal.toolCallId)!);
    if (!batch) return;
    this.deleteProposal(batch, proposal.toolCallId);
    const bounded = limitProposal(
      proposal, MAX_BATCH_DIFF_BYTES - batch.proposalBytes, MAX_BATCH_DIFF_LINES - batch.proposalLines,
    );
    batch.proposals.set(proposal.toolCallId, bounded);
    batch.proposalBytes += Buffer.byteLength(bounded.diff ?? "", "utf8");
    batch.proposalLines += lineCount(bounded.diff ?? "");
    this.redraw(batch);
  }

  /** A nested call ended without error: drop any proposal it did not replace. */
  settle(id: string): void {
    const rootId = this.rootFor(id);
    const batch = rootId ? this.batches.get(rootId) : undefined;
    if (batch && this.deleteProposal(batch, id)) this.redraw(batch);
  }

  reportError(id: string): void {
    const rootId = this.rootFor(id);
    const batch = rootId ? this.batches.get(rootId) : undefined;
    if (!batch) return;
    const change = batch.changes.get(id);
    const proposal = batch.proposals.get(id);
    if (change) batch.changes.set(id, { ...change, toolReportedError: true });
    // Blocked, failed and cancelled calls look alike here: report "not applied" only.
    if (proposal && proposal.status !== "not-applied") batch.proposals.set(id, { ...proposal, status: "not-applied" });
    if (change || proposal) this.redraw(batch);
  }

  proposals(rootId: string): Proposal[] {
    const batch = this.batches.get(rootId);
    if (!batch) return [];
    return [...batch.proposals.values()].sort((a, b) =>
      (this.calls.get(a.toolCallId)?.order ?? 0) - (this.calls.get(b.toolCallId)?.order ?? 0),
    );
  }

  changes(rootId: string): Change[] {
    const batch = this.batches.get(rootId);
    if (!batch) return [];
    return [...batch.changes.values()].sort((a, b) =>
      (this.calls.get(a.toolCallId)?.order ?? 0) - (this.calls.get(b.toolCallId)?.order ?? 0),
    );
  }

  details(rootId: string): DiffDetails | undefined {
    const changes = this.changes(rootId);
    return changes.length ? { version: 1, changes } : undefined;
  }

  watch(rootId: string, invalidate: () => void): void {
    const batch = this.batches.get(rootId);
    if (batch) batch.invalidate = invalidate;
  }

  /** Called after the root result has received its persistent rendering data. */
  end(id: string): void {
    const batch = this.batches.get(id);
    if (!batch) return;
    for (const callId of batch.callIds) this.calls.delete(callId);
    this.batches.delete(id);
  }

  clear(): void {
    this.calls.clear();
    this.batches.clear();
  }

  private deleteProposal(batch: Batch, id: string): boolean {
    const proposal = batch.proposals.get(id);
    if (!proposal) return false;
    batch.proposals.delete(id);
    batch.proposalBytes -= Buffer.byteLength(proposal.diff ?? "", "utf8");
    batch.proposalLines -= lineCount(proposal.diff ?? "");
    return true;
  }

  private redraw(batch: Batch): void {
    try {
      batch.invalidate?.();
    } catch {
      // A detached UI must never turn a successful file mutation into a failure.
    }
  }
}
