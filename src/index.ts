import {
  createEditToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Capture } from "./capture.ts";
import { PROPOSALS_EVENT, proposalsPublisher } from "./events.ts";
import { NestedCallLifecycle } from "./lifecycle.ts";
import { registerDiffRenderer } from "./render.ts";
import { registerWriteCapture } from "./write.ts";

export default function codemodeDiff(pi: ExtensionAPI): void {
  const capture = new Capture();
  // Snapshot of every current proposal for other extensions; identical consecutive snapshots are skipped.
  capture.onProposalsChange = proposalsPublisher(event => pi.events?.emit(PROPOSALS_EVENT, event));

  // Pi's own edit argument normalization; it reads nothing from disk.
  let prepareEdit: ((args: unknown) => unknown) | undefined;
  const prepare = (args: unknown) => {
    prepareEdit ??= createEditToolDefinition(process.cwd()).prepareArguments as (args: unknown) => unknown;
    return prepareEdit ? prepareEdit(args) : args;
  };
  const lifecycle = new NestedCallLifecycle(capture, prepare);

  pi.on("tool_execution_start", event => lifecycle.executionStarted(event));
  pi.on("tool_result", event => lifecycle.toolResult(event));
  pi.on("tool_execution_end", event => lifecycle.executionEnded(event));
  pi.on("session_start", () => lifecycle.clear());
  pi.on("session_shutdown", () => lifecycle.clear());
  pi.on("agent_end", () => lifecycle.clear());

  registerWriteCapture(pi, capture);
  registerDiffRenderer(pi, capture);
}
