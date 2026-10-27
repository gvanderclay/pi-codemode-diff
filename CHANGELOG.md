# Changelog

## Unreleased

- Show a **Proposed (not applied)** section in the live codemode card for nested `edit`/`write` calls, built from their arguments when the call starts. It is on screen before any `tool_call` handler runs, so it is visible while a permission prompt waits. It is a replacement preview, not a dry run: no file is read before approval.
- A completed diff replaces the proposal; a call that ends with an error is marked "Not applied". Proposals are dropped at parent end, `agent_end` and session start/shutdown. They are never persisted, and the version-1 `details` schema, model-facing output and permission behavior are unchanged.
- Test the display timing with Pi's real tool component and a waiting `tool_call` gate, plus a tmux script (`test/pty/preapproval_tui.py`) for the real Pi binary, optionally with `@gotgenes/pi-permission-system`.

## 0.1.5

- Capture and display nested `edit`/`write` changes from the optional `codemode_o` tool, alongside native `codemode`.
- Preserve each tool's original renderer, output, warnings, duration, result status and version-1 diff metadata; isolate mixed concurrent parent calls.
- Add the explicit `src/pig-index.ts` entry for PiG hosts without the private automatic-detection shim. Completed PiG entries record the actual parent tool name and remain compatible with old entries.
- Test real `pi-opencode-mode@0.1.0` integration, both load orders, failures, permissions, persistence and packed artifacts.
- Make the TypeScript and separate Go native npm package documentation self-contained, and validate their packed documentation links and runtime files.
- Fix relative `--pig-typescript-entry` paths in CLI/TUI verification and add regression tests.

Earlier releases are listed in the [GitHub releases](https://github.com/hyein-cbio/pi-codemode-diff/releases).
