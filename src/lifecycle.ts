import {
  isEditToolResult,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Capture } from "./capture.ts";
import { asRecord, DETAILS_KEY, editChange } from "./changes.ts";
import { editProposal, firstErrorLine, writeProposal } from "./proposals.ts";
import { isCodemodeTool } from "./tools.ts";

/**
 * What Pi 1.5 guarantees about a nested call, which this ordering depends on:
 *
 * - A nested call that executes runs tool_execution_start (awaited, before any
 *   tool_call handler such as a permission gate) → tool_call → tool_result →
 *   tool_execution_end.
 * - A call that never executes (blocked by a tool_call handler, tool not found,
 *   validation failure, abort) gets tool_execution_start → tool_execution_end
 *   with isError true and NO tool_result.
 * - tool_execution_end carries the final outcome after every tool_result
 *   handler; another extension's tool_result handler can flip isError either way.
 */
export class NestedCallLifecycle {
  constructor(
    private readonly capture: Capture,
    private readonly prepareEdit?: (args: unknown) => unknown,
  ) {}

  executionStarted(event: ToolExecutionStartEvent): void {
    try {
      this.capture.start(event.toolCallId, event.toolName, event.parentToolCallId);
      // Pi awaits this nested event before any tool_call handler (permission
      // gates included), so the preview exists before an approval prompt opens.
      if (!this.capture.isNested(event.toolCallId)) return;
      if (event.toolName === "edit") this.capture.propose(editProposal(event.toolCallId, event.args, this.prepareEdit));
      else if (event.toolName === "write") this.capture.propose(writeProposal(event.toolCallId, event.args));
    } catch {
      // A preview must never affect the call itself.
    }
  }

  toolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
    try {
      if (this.capture.isNested(event.toolCallId)) {
        if (isEditToolResult(event) && !event.isError && typeof event.input.path === "string") {
          this.capture.add(editChange(event.toolCallId, event.input.path, event.details?.diff));
        }
        if (event.isError) this.capture.reportError(event.toolCallId, firstErrorLine(event.content));
      }

      if (!isCodemodeTool(event.toolName)) return undefined;
      const details = this.capture.details(event.toolCallId);
      if (!details) return undefined;
      // Only details change. Script values, content, usage, structuredContent,
      // tool success/failure and the model's context are left to the host.
      return { details: { ...asRecord(event.details), [DETAILS_KEY]: details } };
    } catch {
      // Never throw into the tool pipeline.
      return undefined;
    }
  }

  executionEnded(event: ToolExecutionEndEvent): void {
    try {
      // This event carries the final outcome after every tool_result handler.
      // A later extension may reject a write whose mutation we already observed.
      if (this.capture.isNested(event.toolCallId)) {
        if (event.isError) this.capture.reportError(event.toolCallId, firstErrorLine(asRecord(event.result)?.content));
        else this.capture.settle(event.toolCallId);
      }
      this.capture.end(event.toolCallId);
    } catch {
      // Never throw into the tool pipeline.
    }
  }

  clear(): void {
    this.capture.clear();
  }
}
