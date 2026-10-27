import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

/**
 * Test-only stand-in for a permission gate: a tool_call handler that awaits a
 * decision. Loaded by path (so its order relative to this package can vary);
 * the test installs the decision function on globalThis.
 */
export const GATE_KEY = "__piCodemodeDiffTestGate";

export type Gate = (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined> | undefined;

export default function gateExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", event => (globalThis as Record<string, unknown> & { [GATE_KEY]?: Gate })[GATE_KEY]?.(event));
}
