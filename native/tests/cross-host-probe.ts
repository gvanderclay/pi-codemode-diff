import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Identical fixture code on Pi and PiG isolates the extension under comparison.
export default function probe(api: ExtensionAPI) {
  api.on("tool_call", event => {
    const input = event.input as Record<string, unknown>;
    if (event.toolName === "write" && input.path === "redirect.txt") input.path = "redirected.txt";
    if (event.toolName === "write" && input.path === "blocked.txt") return { block: true, reason: "verification blocked write" };
    if (event.toolName === "edit" && input.path === "redirect-edit.txt") input.path = "redirected-edit.txt";
    if (event.toolName === "edit" && input.path === "blocked-edit.txt") return { block: true, reason: "verification blocked edit" };
  });
  api.on("tool_result", event => {
    if (event.toolName === "write" && event.input.path === "reject.txt") return { isError: true };
  });
  api.registerTool({
    name: "helper", label: "helper", description: "Write through a deeper nested call",
    parameters: { type: "object", properties: {} },
    async execute(_id, _input, signal, _update, ctx) {
      const outcome = await ctx.executeTool("write", { path: "helper.txt", content: "deeper descendant" }, { signal });
      return outcome.result;
    },
  });
}
