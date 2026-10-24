import {
  isEditToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { isCodemodeTool } from "./tools.ts";
import { Capture } from "./capture.ts";
import { asRecord, DETAILS_KEY } from "./changes.ts";
import { registerDiffRenderer } from "./render.ts";
import { isPiGHost } from "./host.ts";
import type { registerPiGDisplay } from "./pig.ts";
import { registerWriteCapture } from "./write.ts";

export default function codemodeDiff(pi: ExtensionAPI): void | Promise<void> {
  if (typeof pi.registerToolRenderer !== "function") {
    throw new Error("pi-codemode-diff requires Pi >=1.0.1: registerToolRenderer is unavailable. Update Pi and reload the extension.");
  }
  if (isPiGHost(pi)) return codemodeDiffPiG(pi);
  register(pi);
}

/** Explicit PiG entry for hosts whose SDK no longer exposes __runtime(). */
export function codemodeDiffPiG(pi: ExtensionAPI): Promise<void> {
  return import("./pig.ts").then(({ registerPiGDisplay }) => register(pi, registerPiGDisplay));
}

function register(pi: ExtensionAPI, createPiGDisplay?: typeof registerPiGDisplay): void {
  const capture = new Capture();
  const publishPiG = createPiGDisplay?.(pi, capture);

  pi.on("tool_execution_start", (event) => {
    capture.start(event.toolCallId, event.toolName, event.parentToolCallId);
  });

  pi.on("tool_result", (event) => {
    if (capture.isNested(event.toolCallId)) {
      if (isEditToolResult(event) && !event.isError && typeof event.input.path === "string") {
        capture.add({
          toolCallId: event.toolCallId,
          tool: "edit",
          path: event.input.path,
          kind: "edit",
          ...(typeof event.details?.diff === "string"
            ? { diff: event.details.diff }
            : { note: "The edit tool did not provide a display diff." }),
        });
      }
      if (event.isError) capture.reportError(event.toolCallId);
    }

    if (!isCodemodeTool(event.toolName)) return;
    const details = capture.details(event.toolCallId);
    if (!details) return;
    // Only details change. Script values, content, usage, structuredContent,
    // tool success/failure and the model's context are left to the host.
    return { details: { ...asRecord(event.details), [DETAILS_KEY]: details } };
  });

  pi.on("tool_execution_end", (event) => {
    // This event carries the final outcome after every tool_result handler.
    // A later extension may reject a write whose mutation we already observed.
    if (event.isError && capture.isNested(event.toolCallId)) {
      capture.reportError(event.toolCallId);
    }
    try {
      if (isCodemodeTool(event.toolName)) publishPiG?.(event.toolCallId, event.toolName);
    } finally {
      capture.end(event.toolCallId);
    }
  });
  pi.on("session_start", () => capture.clear());
  pi.on("session_shutdown", () => capture.clear());
  pi.on("agent_end", () => capture.clear());

  registerWriteCapture(pi, capture);
  if (!publishPiG) registerDiffRenderer(pi, capture);
}
