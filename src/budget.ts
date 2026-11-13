import { MAX_BATCH_DIFF_BYTES, MAX_BATCH_DIFF_LINES, lineCount, textFits } from "./limits.ts";

/** Running display charges for one batch; completed diffs and proposals use separate ledgers. */
export class DisplayBudget {
  private charges = new Map<string, { bytes: number; lines: number }>();
  private usedBytes = 0;
  private usedLines = 0;

  constructor(
    private maxBytes = MAX_BATCH_DIFF_BYTES,
    private maxLines = MAX_BATCH_DIFF_LINES,
  ) {}

  /** Releases key's previous charge, then records text only if it fits. A failed charge holds nothing. */
  charge(key: string, text: string): boolean {
    this.release(key);
    if (!textFits(text, this.maxBytes - this.usedBytes, this.maxLines - this.usedLines)) return false;
    const charge = { bytes: Buffer.byteLength(text, "utf8"), lines: lineCount(text) };
    this.charges.set(key, charge);
    this.usedBytes += charge.bytes;
    this.usedLines += charge.lines;
    return true;
  }

  /** Forgets key's charge; no-op for an unknown key. */
  release(key: string): void {
    const charge = this.charges.get(key);
    if (!charge) return;
    this.charges.delete(key);
    this.usedBytes -= charge.bytes;
    this.usedLines -= charge.lines;
  }

  /** Remaining bytes and lines; for tests and diagnostics. */
  remaining(): { bytes: number; lines: number } {
    return { bytes: this.maxBytes - this.usedBytes, lines: this.maxLines - this.usedLines };
  }
}

/**
 * Joins kept lines with "\n"; when lines are dropped, the last line is
 * trailer(number of dropped lines) and the result stays within maxBytes and maxLines.
 */
export function cutLines(
  lines: readonly string[],
  maxBytes: number,
  maxLines: number,
  trailer: (dropped: number) => string,
): string {
  const kept: string[] = [];
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = Buffer.byteLength(lines[i], "utf8") + (kept.length ? 1 : 0);
    const remaining = lines.length - i - 1;
    // Reserve room for the trailer unless this is the last line.
    const reserve = remaining ? Buffer.byteLength(trailer(lines.length - i), "utf8") + 1 : 0;
    const fitsLines = kept.length + 1 + (remaining ? 1 : 0) <= maxLines;
    if (!fitsLines || bytes + cost + reserve > maxBytes) {
      kept.push(trailer(lines.length - i));
      return kept.join("\n");
    }
    kept.push(lines[i]);
    bytes += cost;
  }
  return kept.join("\n");
}
