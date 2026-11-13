import { isCodemodeTool } from "./tools.ts";
import { limitChange, type Change, type DiffDetails } from "./changes.ts";
import { DisplayBudget } from "./budget.ts";
import { limitProposal, type Proposal } from "./proposals.ts";

interface Call {
  rootId: string;
  order: number;
}

interface Batch {
  callIds: Set<string>;
  changes: Map<string, Change>;
  nextOrder: number;
  diffBudget: DisplayBudget;
  /** Pre-approval previews: a separate map and budget, never part of details(). */
  proposals: Map<string, Proposal>;
  proposalBudget: DisplayBudget;
  invalidate?: () => void;
}

/** Session-local, keyed by call id: parallel codemode calls cannot mix data. */
export class Capture {
  private calls = new Map<string, Call>();
  private batches = new Map<string, Batch>();
  /** Called with every current proposal after anything that may change them; listeners dedupe. */
  onProposalsChange?: (proposals: Proposal[]) => void;

  start(id: string, name: string, parentId?: string): void {
    const parentRoot = parentId ? this.calls.get(parentId)?.rootId : undefined;
    if (!parentRoot && !isCodemodeTool(name)) return;
    const rootId = parentRoot ?? id;
    let batch = this.batches.get(rootId);
    if (!batch) {
      batch = {
        callIds: new Set(), changes: new Map(), nextOrder: 0, diffBudget: new DisplayBudget(),
        proposals: new Map(), proposalBudget: new DisplayBudget(),
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
    batch.diffBudget.release(change.toolCallId);
    const bounded = limitChange(change, batch.diffBudget);
    batch.changes.set(change.toolCallId, bounded);
    // The completed diff replaces the call's proposal.
    const replaced = this.deleteProposal(batch, change.toolCallId);
    this.redraw(batch);
    // A Change alone never changes the snapshot; only a replaced proposal does.
    if (replaced) this.notify();
  }

  /** Record a nested call's pre-approval preview; only nested calls are accepted. */
  propose(proposal: Proposal): void {
    if (!this.isNested(proposal.toolCallId)) return;
    const batch = this.batches.get(this.rootFor(proposal.toolCallId)!);
    if (!batch) return;
    this.deleteProposal(batch, proposal.toolCallId);
    const bounded = limitProposal(proposal, batch.proposalBudget);
    batch.proposals.set(proposal.toolCallId, bounded);
    this.redraw(batch);
    this.notify();
  }

  reportError(id: string, error?: string): void {
    const rootId = this.rootFor(id);
    const batch = rootId ? this.batches.get(rootId) : undefined;
    if (!batch) return;
    const change = batch.changes.get(id);
    const proposal = batch.proposals.get(id);
    if (change) batch.changes.set(id, { ...change, toolReportedError: true });
    // Blocked, failed and cancelled calls look alike here; no classification is attempted.
    // An error does not prove the file is unchanged: report it as unverified, with its reason.
    if (proposal && (proposal.status !== "unverified" || (!proposal.error && error))) {
      batch.proposals.set(id, { ...proposal, status: "unverified", ...(proposal.error ?? error ? { error: proposal.error ?? error } : {}) });
    }
    if (change || proposal) this.redraw(batch);
    if (proposal) this.notify();
  }

  /** Every root's proposals, roots in start order, calls in call-start order. */
  allProposals(): Proposal[] {
    return [...this.batches.keys()].flatMap(rootId => this.proposals(rootId));
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
    if (batch.proposals.size) this.notify();
  }

  clear(): void {
    this.calls.clear();
    this.batches.clear();
    this.notify();
  }

  private notify(): void {
    try {
      this.onProposalsChange?.(this.allProposals());
    } catch {
      // A consumer must never affect the tool pipeline.
    }
  }

  private deleteProposal(batch: Batch, id: string): boolean {
    const proposal = batch.proposals.get(id);
    if (!proposal) return false;
    batch.proposals.delete(id);
    batch.proposalBudget.release(id);
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
