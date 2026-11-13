import { mkdir, writeFile } from "node:fs/promises";
import {
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Capture } from "./capture.ts";
import { writeChange, writeKind } from "./changes.ts";
import { writeTextFits } from "./limits.ts";
import { readPrevious } from "./snapshot.ts";

export function registerWriteCapture(pi: ExtensionAPI, capture: Capture): void {
  const builtin = createWriteToolDefinition(process.cwd());
  pi.registerTool({
    ...builtin,
    // Preserve the host's tool selection, including read-only/--no-tools sessions.
    defaultActive: false,
    async execute(id, input, signal, onUpdate, ctx) {
      if (!capture.isNested(id)) {
        return builtin.execute(id, input, signal, onUpdate, ctx);
      }

      const instrumented = createWriteToolDefinition(ctx.cwd, {
        operations: {
          mkdir: async (dir) => { await mkdir(dir, { recursive: true }); },
          // The built-in tool invokes this INSIDE withFileMutationQueue().
          // Do not wrap execute() in a second queue: that would deadlock.
          writeFile: async (absolutePath, content) => {
            const before = await readPrevious(absolutePath, !writeTextFits(content));
            if (signal?.aborted) throw new Error("Operation aborted");
            await writeFile(absolutePath, content, "utf8");
            // File writing has succeeded. Diff computation must not alter its outcome.
            try {
              capture.add(writeChange(id, input.path, before, content));
            } catch {
              capture.add({
                toolCallId: id,
                tool: "write",
                path: input.path,
                kind: writeKind(before),
                note: "Write completed, but its diff could not be generated.",
              });
            }
          },
        },
      });
      // Same schema, success text, cancellation checks and renderer as built-in write.
      return instrumented.execute(id, input, signal, onUpdate, ctx);
    },
  });
}
