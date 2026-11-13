import {
  truncateToVisualLines,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { isCodemodeTool } from "./tools.ts";
import type { Capture } from "./capture.ts";
import { readChanges, type Change } from "./changes.ts";
import { coloredDiff } from "./diff.ts";
import type { Proposal } from "./proposals.ts";
import { inlineText, safeText } from "./text.ts";

export const PREVIEW_CHANGES = 3;
export const PREVIEW_LINES = 8;

function expandHint(theme: Theme, key: string): string {
  return theme.fg("dim", key ? `${key} to expand` : "expand tool output");
}

class DiffPreview implements Component {
  private width?: number;
  private lines?: string[];

  constructor(private text: string, private theme: Theme, private expandKey: string) {}

  render(width: number): string[] {
    if (this.width !== width || !this.lines) {
      const { visualLines, skippedCount } = truncateToVisualLines(this.text, PREVIEW_LINES, width, 0, "start");
      this.lines = visualLines;
      if (skippedCount) {
        this.lines = [...visualLines, truncateToWidth(
          `${this.theme.fg("muted", `… (${skippedCount} more lines,`)} ${expandHint(this.theme, this.expandKey)}${this.theme.fg("muted", ")")}`,
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

interface Row {
  path: string;
  label: string;
  counts?: { added: number; removed: number };
  size?: { bytes: number; lines?: number };
  lead: Array<{ color: "warning" | "muted"; text: string }>;
  diff?: string;
  note?: string;
  trail: Array<{ color: "warning" | "muted"; text: string }>;
}

interface FileChangeListOptions {
  title: "File changes" | "Proposed changes";
  titleColor: "toolTitle" | "warning";
  moreNoun: "changes" | "proposed changes";
  unavailableCount: boolean;
}

function fileChangeList(rows: readonly Row[], options: FileChangeListOptions, expanded: boolean, theme: Theme, expandKey: string): Container {
  const section = new Container();
  if (!rows.length) return section;
  section.addChild(new Spacer(1));
  // Count the whole batch, including rows hidden by the collapsed preview.
  // Paths are compared as recorded; counting must not perform filesystem reads.
  const files = new Set(rows.map(row => row.path)).size;
  // An empty diff is available (e.g. an unchanged write), not missing.
  const unavailable = options.unavailableCount ? rows.filter(row => row.diff === undefined).length : 0;
  const summary = `${options.title} (${rows.length}) · ${files} ${files === 1 ? "file" : "files"}` +
    (unavailable ? ` · ${unavailable} ${unavailable === 1 ? "diff" : "diffs"} unavailable` : "");
  section.addChild(new Text(theme.fg(options.titleColor, theme.bold(summary)), 0, 0));

  const shown = expanded ? rows : rows.slice(0, PREVIEW_CHANGES);
  for (const row of shown) {
    section.addChild(new Spacer(1));
    const counts = row.counts === undefined ? "" : ` ${theme.fg("toolDiffAdded", `+${row.counts.added}`)} ${theme.fg("toolDiffRemoved", `-${row.counts.removed}`)}`;
    const lines = row.size?.lines === undefined ? "" : ` · ${row.size.lines} ${row.size.lines === 1 ? "line" : "lines"}`;
    const size = row.size === undefined ? "" : " " + theme.fg("muted", row.size.bytes + " bytes" + lines);
    const header = theme.fg("toolTitle", inlineText(row.path)) + " " + theme.fg("muted", "[" + row.label + "]") + counts + size;
    section.addChild(new Text(header, 0, 0));
    for (const line of row.lead) section.addChild(new Text(theme.fg(line.color, inlineText(line.text)), 0, 0));
    if (row.diff) {
      const styled = coloredDiff(safeText(row.diff), theme);
      section.addChild(expanded ? new Text(styled, 0, 0) : new DiffPreview(styled, theme, expandKey));
    }
    if (row.note) section.addChild(new Text(theme.fg("muted", inlineText(row.note)), 0, 0));
    for (const line of row.trail) section.addChild(new Text(theme.fg(line.color, inlineText(line.text)), 0, 0));
  }
  if (shown.length < rows.length) {
    section.addChild(new Text(
      `${theme.fg("muted", `… (${rows.length - shown.length} more ${options.moreNoun},`)} ${expandHint(theme, expandKey)}${theme.fg("muted", ")")}`,
      0,
      0,
    ));
  }
  return section;
}

export function countChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  // Pi's display diff uses +<line number> / -<line number>, not patch headers.
  for (const line of diff.split("\n")) {
    if (/^\+\s*\d+ /.test(line)) added++;
    if (/^-\s*\d+ /.test(line)) removed++;
  }
  return { added, removed };
}

export function diffSection(changes: readonly Change[], expanded: boolean, theme: Theme, expandKey: string): Container {
  const rows = changes.map((change): Row => ({
    path: change.path,
    label: change.kind === "create" ? "write · new" : change.kind === "overwrite" ? "write · overwrite" : change.tool,
    counts: change.diff === undefined ? undefined : countChanges(change.diff),
    lead: [],
    diff: change.diff,
    note: change.note,
    trail: change.toolReportedError
      ? [{ color: "warning", text: "File change observed, but the tool reported an error or cancellation." }]
      : [],
  }));
  return fileChangeList(rows, {
    title: "File changes", titleColor: "toolTitle", moreNoun: "changes", unavailableCount: true,
  }, expanded, theme, expandKey);
}

/**
 * Pre-approval previews built from supplied arguments only. Labelled as not
 * applied: the text has not been matched against the file.
 */
export function proposalSection(proposals: readonly Proposal[], expanded: boolean, theme: Theme, expandKey: string): Container {
  // The calls awaiting approval or execution matter most: list them first.
  const ordered = [
    ...proposals.filter(proposal => proposal.status === "pending"),
    ...proposals.filter(proposal => proposal.status !== "pending"),
  ];
  const rows = ordered.map((proposal): Row => ({
    path: proposal.path,
    label: proposal.tool === "write" ? "write · proposed content" : "edit · proposed",
    counts: proposal.tool === "edit" && proposal.added !== undefined
      ? { added: proposal.added, removed: proposal.removed ?? 0 }
      : undefined,
    size: proposal.bytes === undefined ? undefined : { bytes: proposal.bytes, lines: proposal.lines },
    // An error can follow a write; it does not prove the file is unchanged.
    lead: proposal.status === "unverified"
      ? [
        { color: "warning", text: "Did not complete — changes not verified." },
        ...(proposal.error ? [{ color: "muted" as const, text: "Error: " + proposal.error }] : []),
      ]
      : [{ color: "muted", text: "Preview built from the call's arguments without reading the file; not applied yet." }],
    diff: proposal.diff,
    note: proposal.note,
    trail: [],
  }));
  return fileChangeList(rows, {
    title: "Proposed changes", titleColor: "warning", moreNoun: "proposed changes", unavailableCount: false,
  }, expanded, theme, expandKey);
}

export class SectionMemo<T> {
  private cached?: {
    items: readonly T[];
    expanded: boolean;
    theme: Theme;
    expandKey: string;
    section: Container;
  };

  get(
    items: readonly T[], expanded: boolean, theme: Theme, expandKey: string,
    build: (items: readonly T[], expanded: boolean, theme: Theme, expandKey: string) => Container,
  ): Container {
    const cached = this.cached;
    if (cached && cached.items.length === items.length && items.every((item, i) => item === cached.items[i]) &&
        cached.expanded === expanded && cached.theme === theme && cached.expandKey === expandKey) {
      return cached.section;
    }
    const section = build(items, expanded, theme, expandKey);
    this.cached = { items: [...items], expanded, theme, expandKey, section };
    return section;
  }

  clear(): void {
    this.cached = undefined;
  }
}

class WrappedResult extends Container {
  baseComponent?: Component;
  changes = new SectionMemo<Change>();
  proposals = new SectionMemo<Proposal>();

  override invalidate(): void {
    super.invalidate();
    this.changes.clear();
    this.proposals.clear();
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
        // Persisted details are authoritative once the root call has a result; the capture covers live partial results.
        const changes = readChanges(result.details) ?? capture.changes(context.toolCallId);
        const expandKey = context.keyText("app.tools.expand");
        component.addChild(component.changes.get(changes, options.expanded, theme, expandKey, diffSection));
        // Proposals are live-only: never read from (or written to) result details.
        const proposals = options.isPartial ? capture.proposals(context.toolCallId) : [];
        component.addChild(component.proposals.get(proposals, options.expanded, theme, expandKey, proposalSection));
        return component;
      },
    };
  });
}
