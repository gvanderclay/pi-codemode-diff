import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * PTY-only stand-in for a permission gate: every edit/write tool_call opens an
 * inline select prompt and waits for the user's choice. Not shipped.
 */
export default function selectGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const path = String((event.input as { path?: unknown }).path);
    const choice = await ctx.ui.select("TEST GATE: allow " + event.toolName + " on " + path + "?", ["Allow", "Block"]);
    return choice === "Allow" ? undefined : { block: true, reason: "Blocked by test gate" };
  });
}
