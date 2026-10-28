import {
  keyText,
  truncateToVisualLines,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { isCodemodeTool } from "./tools.ts";
import type { Capture } from "./capture.ts";
import { countChanges, readChanges, type Change } from "./changes.ts";
import { coloredDiff } from "./diff.ts";
import type { Proposal } from "./proposals.ts";

export const PREVIEW_CHANGES = 3;
export const PREVIEW_LINES = 8;

/** File contents/path names must not inject terminal escape sequences. */
export function safeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�").replace(/\t/g, "   ");
}

export function inlineText(text: string): string {
  return safeText(text).replace(/\n/g, "\\n");
}

function expandHint(theme: Theme): string {
  const key = keyText("app.tools.expand");
  return theme.fg("dim", key ? `${key} to expand` : "expand tool output");
}

class DiffPreview implements Component {
  private width?: number;
  private lines?: string[];

  constructor(private text: string, private theme: Theme) {}

  render(width: number): string[] {
    if (this.width !== width || !this.lines) {
      const { visualLines, skippedCount } = truncateToVisualLines(this.text, PREVIEW_LINES, width, 0, "start");
      this.lines = visualLines;
      if (skippedCount) {
        this.lines = [...visualLines, truncateToWidth(
          `${this.theme.fg("muted", `… (${skippedCount} more lines,`)} ${expandHint(this.theme)}${this.theme.fg("muted", ")")}`,
          width,
          "…",
        )];
      }
      this.width = width;
    }
    return this.lines;
  }

  invalidate(): void {
    this.width = undefined;
    this.lines = undefined;
  }
}

export function diffSection(changes: readonly Change[], expanded: boolean, theme: Theme): Container {
  const section = new Container();
  if (!changes.length) return section;
  section.addChild(new Spacer(1));
  // Count the whole batch, including changes hidden by the collapsed preview.
  // Paths are compared as recorded; counting must not perform filesystem reads.
  const files = new Set(changes.map(change => change.path)).size;
  // An empty diff is available (e.g. an unchanged write), not missing.
  const unavailable = changes.filter(change => change.diff === undefined).length;
  const summary = `File changes (${changes.length}) · ${files} ${files === 1 ? "file" : "files"}` +
    (unavailable ? ` · ${unavailable} ${unavailable === 1 ? "diff" : "diffs"} unavailable` : "");
  section.addChild(new Text(theme.fg("toolTitle", theme.bold(summary)), 0, 0));

  const shown = expanded ? changes : changes.slice(0, PREVIEW_CHANGES);
  for (const change of shown) {
    section.addChild(new Spacer(1));
    const { added, removed } = countChanges(change.diff ?? "");
    const label = change.kind === "create" ? "write · new" : change.kind === "overwrite" ? "write · overwrite" : change.tool;
    const counts = change.diff === undefined ? "" : ` ${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}`;
    const header = `${theme.fg("toolTitle", inlineText(change.path))} ${theme.fg("muted", `[${label}]`)}${counts}`;
    section.addChild(new Text(header, 0, 0));
    if (change.diff) {
      const styled = coloredDiff(safeText(change.diff), theme);
      section.addChild(expanded ? new Text(styled, 0, 0) : new DiffPreview(styled, theme));
    }
    if (change.note) section.addChild(new Text(theme.fg("muted", inlineText(change.note)), 0, 0));
    if (change.toolReportedError) {
      section.addChild(new Text(theme.fg("warning", "File change observed, but the tool reported an error or cancellation."), 0, 0));
    }
  }
  if (shown.length < changes.length) {
    section.addChild(new Text(
      `${theme.fg("muted", `… (${changes.length - shown.length} more changes,`)} ${expandHint(theme)}${theme.fg("muted", ")")}`,
      0,
      0,
    ));
  }
  return section;
}

/**
 * Pre-approval previews built from supplied arguments only. Labelled as not
 * applied: the text has not been matched against the file.
 */
export function proposalSection(proposals: readonly Proposal[], expanded: boolean, theme: Theme): Container {
  const section = new Container();
  if (!proposals.length) return section;
  section.addChild(new Spacer(1));
  section.addChild(new Text(theme.fg("warning", theme.bold("Proposed changes (" + proposals.length + ")")), 0, 0));
  // The calls awaiting approval or execution matter most: list them first.
  const ordered = [
    ...proposals.filter(proposal => proposal.status === "pending"),
    ...proposals.filter(proposal => proposal.status !== "pending"),
  ];
  const shown = expanded ? ordered : ordered.slice(0, PREVIEW_CHANGES);
  for (const proposal of shown) {
    section.addChild(new Spacer(1));
    const label = proposal.tool === "write" ? "write · proposed content" : "edit · proposed";
    const counts = proposal.tool === "edit" && proposal.added !== undefined
      ? " " + theme.fg("toolDiffAdded", "+" + proposal.added) + " " + theme.fg("toolDiffRemoved", "-" + (proposal.removed ?? 0))
      : "";
    const lines = proposal.lines === undefined ? "" : " · " + proposal.lines + (proposal.lines === 1 ? " line" : " lines");
    const size = proposal.bytes === undefined ? "" : " " + theme.fg("muted", proposal.bytes + " bytes" + lines);
    section.addChild(new Text(theme.fg("toolTitle", inlineText(proposal.path)) + " " + theme.fg("muted", "[" + label + "]") + counts + size, 0, 0));
    if (proposal.status === "unverified") {
      // An error can follow a write; it does not prove the file is unchanged.
      section.addChild(new Text(theme.fg("warning", "Did not complete — changes not verified."), 0, 0));
      if (proposal.error) section.addChild(new Text(theme.fg("muted", "Error: " + inlineText(proposal.error)), 0, 0));
    } else {
      section.addChild(new Text(theme.fg("muted", "Preview built from the call's arguments without reading the file; not applied yet."), 0, 0));
    }
    if (proposal.diff) {
      const styled = coloredDiff(safeText(proposal.diff), theme);
      section.addChild(expanded ? new Text(styled, 0, 0) : new DiffPreview(styled, theme));
    }
    if (proposal.note) section.addChild(new Text(theme.fg("muted", inlineText(proposal.note)), 0, 0));
  }
  if (shown.length < ordered.length) {
    section.addChild(new Text(
      theme.fg("muted", "… (" + (ordered.length - shown.length) + " more proposed,") + " " + expandHint(theme) + theme.fg("muted", ")"),
      0,
      0,
    ));
  }
  return section;
}

function sameItems<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
  return a?.length === b.length && b.every((item, i) => item === a[i]);
}

class WrappedResult extends Container {
  baseComponent?: Component;
  private changes?: readonly Change[];
  private expanded?: boolean;
  private theme?: Theme;
  private section?: Container;
  private proposals?: readonly Proposal[];
  private proposalExpanded?: boolean;
  private proposalTheme?: Theme;
  private pending?: Container;

  getProposalSection(proposals: readonly Proposal[], expanded: boolean, theme: Theme): Container {
    if (!this.pending || !sameItems(this.proposals, proposals) || this.proposalExpanded !== expanded || this.proposalTheme !== theme) {
      this.pending = proposalSection(proposals, expanded, theme);
      this.proposals = proposals;
      this.proposalExpanded = expanded;
      this.proposalTheme = theme;
    }
    return this.pending;
  }

  getSection(changes: readonly Change[], expanded: boolean, theme: Theme): Container {
    const sameChanges = this.changes?.length === changes.length && changes.every((item, i) => item === this.changes?.[i]);
    if (!this.section || !sameChanges || this.expanded !== expanded || this.theme !== theme) {
      this.section = diffSection(changes, expanded, theme);
      this.changes = changes;
      this.expanded = expanded;
      this.theme = theme;
    }
    return this.section;
  }

  override invalidate(): void {
    super.invalidate();
    this.section = undefined;
    this.changes = undefined;
    this.pending = undefined;
    this.proposals = undefined;
  }
}

export function registerDiffRenderer(pi: ExtensionAPI, capture: Capture): void {
  pi.registerToolRenderer((name, next) => {
    if (!isCodemodeTool(name)) return next();
    const base = next();
    const renderBase = base?.renderResult;
    // Do not invent a replacement codemode renderer when the host has none.
    if (!base || !renderBase) return base;
    return {
      ...base,
      renderResult(result, options, theme, context) {
        const component = context.lastComponent instanceof WrappedResult ? context.lastComponent : new WrappedResult();
        // Pass the original renderer ITS last component, not our outer container.
        component.baseComponent = renderBase(result, options, theme, {
          ...context,
          lastComponent: component.baseComponent,
        });
        component.clear();
        component.addChild(component.baseComponent);
        capture.watch(context.toolCallId, context.invalidate);
        const changes = readChanges(result.details) ?? capture.changes(context.toolCallId);
        component.addChild(component.getSection(changes, options.expanded, theme));
        // Proposals are live-only: never read from (or written to) result details.
        const proposals = options.isPartial ? capture.proposals(context.toolCallId) : [];
        component.addChild(component.getProposalSection(proposals, options.expanded, theme));
        return component;
      },
    };
  });
}
