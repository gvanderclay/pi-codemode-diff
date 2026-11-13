import type { KeybindingHints, ToolRenderers } from "@earendil-works/pi-coding-agent";

export const expandKey = "ctrl+shift+o";
export const keybindingHints: KeybindingHints = {
  keyText: keybinding => keybinding === "app.tools.expand" ? expandKey : "",
  keyHint: (keybinding, description) => `${keybindingHints.keyText(keybinding)} ${description}`,
};

type RenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];

export function renderContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    durationMs: undefined, outputPad: 0, args: {}, toolCallId: "root", invalidate() {}, lastComponent: undefined,
    ...keybindingHints, state: {}, cwd: "/tmp", executionStarted: true, argsComplete: true, isPartial: false,
    expanded: false, showImages: true, isError: false,
    ...overrides,
  };
}
