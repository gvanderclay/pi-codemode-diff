# Changelog

## 0.1.5

- Capture and display nested `edit`/`write` changes from the optional `codemode_o` tool, alongside native `codemode`.
- Preserve each tool's original renderer, output, warnings, duration, result status and version-1 diff metadata; isolate mixed concurrent parent calls.
- Add the explicit `src/pig-index.ts` entry for PiG hosts without the private automatic-detection shim. Completed PiG entries record the actual parent tool name and remain compatible with old entries.
- Test real `pi-opencode-mode@0.1.0` integration, both load orders, failures, permissions, persistence and packed artifacts.
- Make the TypeScript and separate Go native npm package documentation self-contained, and validate their packed documentation links and runtime files.
- Fix relative `--pig-typescript-entry` paths in CLI/TUI verification and add regression tests.

Earlier releases are listed in the [GitHub releases](https://github.com/hyein-cbio/pi-codemode-diff/releases).
