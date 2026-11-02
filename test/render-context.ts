import type { KeybindingHints } from "@earendil-works/pi-coding-agent";

export const expandKey = "ctrl+shift+o";
export const keybindingHints: KeybindingHints = {
  keyText: keybinding => keybinding === "app.tools.expand" ? expandKey : "",
  keyHint: (keybinding, description) => `${keybindingHints.keyText(keybinding)} ${description}`,
};
