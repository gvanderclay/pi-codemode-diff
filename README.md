# pi-codemode-diff

Show file diffs for `edit` and `write` calls inside Pi's `codemode` tool. Diffs stay in session display metadata, **not in model-facing tool output**.

This is a personal fork of [hyein-cbio/pi-codemode-diff](https://github.com/hyein-cbio/pi-codemode-diff) (MIT; original copyright retained in [LICENSE](LICENSE)). It supports plain Pi's native `codemode` only: upstream's PiG/native Go package and `codemode_o` (OpenCode) support are removed, and it adds a pre-approval preview of proposed changes. Do not load it alongside upstream's package.

```diff
File changes (2) · 2 files

src/config.ts [write · new] +1 -0
+1 export const timeout = 5000;

src/main.ts [edit] +1 -1
-4 const timeout = 1000;
+4 const timeout = 5000;
```

## Install

Requires **Pi >=1.0.1** and **Node.js >=22.19**. Pi 1.0.0 lacks the renderer API this extension needs. `codemode` must be active; this extension does not enable it or any disabled file tool.

```bash
pi install git:github.com/gvanderclay/pi-codemode-diff
```

The `pi-codemode-diff` package on npm is upstream's, not this fork.

Run `/reload` in an existing session. Only the exact tool name `codemode` establishes a capture root; prefix-like tools do not.

The original tool still renders its script, output, warnings and duration. Its result content, structured content, script return values, usage and success/error status are unchanged. Permissions, activation, file mutation queues and diff budgets are unchanged too. This extension never delegates or replays failed scripts.

## Preview and full view

- Collapsed results show the first **3 changes**, with **8 visual lines per diff**.
- **Ctrl+O** expands/collapses tool output; customized Pi expansion bindings are reflected in the hint.
- Expansion shows all retained diff hunks, not the entire unchanged file.
- Changes to the same path remain separate, in call-start order. The header also counts distinct recorded paths, without resolving aliases or symlinks.
- Unavailable diffs are counted across the entire call, including changes outside the preview. Each change retains an explanatory notice. Empty diffs and preview-folded diffs are not counted as unavailable.
- Single-line replacements highlight changed words. Large/complex comparisons and whitespace changes that cannot be reconstructed exactly keep line colors instead.

## Proposed changes before approval

When a nested `edit` or `write` starts, the live codemode card shows a separate **Proposed changes** section built from the call's arguments. Pi emits the nested `tool_execution_start` event, and waits for it, before any `tool_call` handler runs. The preview is therefore built, and a redraw requested, before permission handlers run, in either extension load order. It is rendered while an interactive approval prompt (for example `@gotgenes/pi-permission-system`'s `ask` dialog) waits, provided the card fits in the terminal above the prompt. Ctrl+O expands it with the rest of the tool output.

```diff
Proposed changes (1)

src/main.ts [edit · proposed] +1 -1
Preview built from the call's arguments without reading the file; not applied yet.
- const timeout = 1000;
+ const timeout = 5000;
```

- **A replacement preview, not a dry run.** Each `edits[]` entry is shown as unnumbered `-`/`+` lines, with lines shared by `oldText` and `newText` as context. The file is **not read** before approval, so the preview does not check that `oldText` matches, is unique or does not overlap. It has no file line numbers. Pi's fuzzy matching and line-ending/BOM normalization can make the applied diff differ.
- Arguments are normalized with Pi's own edit `prepareArguments` (JSON-string `edits`, a single edit object, legacy top-level `oldText`/`newText`). Malformed or empty input shows a "Preview unavailable" note.
- `write` shows only the proposed content and its size, labelled **proposed content**. Because the previous file is not read, it does not say whether the write creates or overwrites a file.
- Lifecycle: a successful call's completed diff replaces its proposal. A call that ends with an error is marked **Did not complete — changes not verified**, followed by the first line of its error text (sanitized, up to 200 characters). A denial, a failed match and a cancellation are not told apart, and an error does not prove the file is unchanged (for example, a cancellation after the write). Proposals disappear when the parent call ends, and on `agent_end` and session start/shutdown. Each nested call keeps its own proposal, including parallel calls and repeated edits to one file. Collapsed view shows pending calls first.
- Proposals are display-only and session-local. They are never added to result `details` (the version-1 schema is unchanged), to model-facing content or to the saved session. Permission decisions and file mutation are unchanged.
- Budgets: replacement input over 256 KiB or 4,000 lines, or a proposal over 64 KiB or 2,000 lines, is omitted with a notice. Proposals in one parent call share a separate 256 KiB / 8,000-line budget. Paths and contents are sanitized like completed diffs.
- Scope: native `codemode` in Pi's interactive TUI. Direct (non-codemode) calls and forwarded delegate prompts get no preview. The preview is in the codemode card above the approval prompt, not inside the prompt.

### Proposals event for other extensions

Other extensions can follow the current proposals on Pi's extension event bus, channel `codemode-diff:proposals` (`pi.events.on("codemode-diff:proposals", handler)`). For example, a permission forwarder can show them next to a forwarded approval prompt. The payload type is `ProposalsEvent` in `src/events.ts`:

```ts
type ProposalsEvent = {
  version: 1;
  proposals: Array<{
    toolCallId: string;
    tool: "edit" | "write";
    path: string;
    status: "pending" | "unverified";
    preview?: string; // "- ", "+ ", "  ", "· replacement i/n …" lines; ≤ 16 KiB, ≤ 200 lines, then "… N more lines"
    added?: number; removed?: number;
    note?: string; error?: string;
  }>;
};
```

- **Snapshot semantics.** Each emission is the full list of the session's current proposals across all codemode calls. It is re-sent after every change: a proposal is added, becomes unverified, is replaced by its completed diff or removed, the parent call ends, or `agent_end` / session start/shutdown clears them. An empty list means none. An identical snapshot is never sent twice in a row. A nested call's proposal is in the snapshot before any `tool_call` handler (such as a permission gate) runs for it.
- **Versioned.** `version` changes only for incompatible payload changes. Ignore unknown fields, and ignore payloads whose version you don't support.
- Strings are sanitized and bounded like the rendered preview (no terminal control characters or ANSI). Previews are plain text built from the call's arguments without reading files, with the same "not a dry run" caveats. Treat the payload as untrusted display data: escape it for your own output, and never use it as a permission decision or as proof of what was written. The event is never model-facing, and emission errors never affect tool calls.

## Capture and persistence

Successful nested edits reuse the edit tool's `details.diff`. Nested writes delegate to Pi's built-in write definition, taking a bounded previous-content snapshot inside its file mutation queue before writing. Direct edit/write calls keep their original behavior and do not acquire parent diff metadata.

Display data uses the unchanged version-1 `details.piCodemodeDiff` schema. Parallel parent calls are isolated by call ID. Helper-tool descendants are captured as well. Display order does not imply a global mutation order across parallel calls.

Newly recorded diffs survive session resume and extension reload. Older sessions without captured diffs cannot be backfilled. A script failure does not erase writes already completed; observed writes that later report an error or cancellation show that status alongside the diff.

### Display safety budgets

| Data | UTF-8 bytes | Logical lines |
| --- | ---: | ---: |
| Each previous/new write input | 256 KiB | 2,000 |
| Each retained edit/write diff | 64 KiB | 2,000 |
| Total retained diffs per parent call | 256 KiB | 8,000 |

Limits are inclusive. Exceeding either dimension omits the **whole diff**, with a notice; it does not restrict the write. Existing-file snapshot reads are bounded to 256 KiB plus one overflow byte, even if a file grows after its size check. Oversized new inputs skip reading previous content.

Binary, invalid UTF-8, nonregular and unreadable previous content produce notices rather than guessed diffs. Write diff normalization of CRLF/CR line endings and the UTF-8 BOM is display-only; exact written bytes are unchanged. Normalization-only changes are reported. No previous-file backup is retained.

## Scope and limitations

- Changes through bash, Python, formatters or external processes are not detected.
- Other extensions replacing `write` or `edit`, including remote/custom filesystem tools, need compatible coordination; replacements are not automatically composed.
- Transcript compactors may hide collapsed diffs. Expand output or check extension conflicts.
- Displayed paths and contents are sanitized against terminal control characters. Stored diff data is unchanged and may contain sensitive source code: review sessions before sharing them.
- Budgets bound per-call diff payloads, not total session size, tool arguments or all metadata. Retained diffs increase session storage and rendering work, not model context.
- This is visibility tooling, not undo, checkpoints, backups or byte-exact recovery. Capture is not guaranteed through forced termination or every cancellation path.
- Print/JSON/RPC model-facing result content remains unchanged. Extra inline UI is rendered by Pi's terminal components. Explicitly returning/printing file contents from a script still sends those contents to the model.

## Local development

From a full repository checkout:

```bash
npm ci
npm run typecheck
npm test
npm run test:coverage
```

Try the source without changing Pi settings:

```bash
pi -e /absolute/path/to/pi-codemode-diff/src/index.ts
```

Pi installs the `diff` runtime dependency for npm/git installations. It does not install dependencies for a local path: run `npm install --omit=dev --omit=peer --ignore-scripts` in the package root for local runtime use, or `npm ci` for development. Host-provided Pi modules are peers, not bundled runtime dependencies. `/reload` picks up source changes.

To check the pre-approval preview in a real terminal, run `uv run test/pty/preapproval_tui.py --pi <pi-coding-agent>/dist/bundle/cli.js --permission-system <@gotgenes/pi-permission-system directory> [--output <new-empty-dir>]`. It drives an actual PTY with a scripted local model and keeps the transcripts and sessions as evidence. Its visibility checks read the current screen of a [pyte](https://pypi.org/project/pyte/) terminal emulator, not the byte transcript; `uv` installs pyte from the script's inline metadata (plain `python3` works when pyte is importable).

Tests cover capture isolation, result preservation, bounded snapshots/diffs, filesystem edge cases, renderer composition, saved metadata, reload/resume and the pre-approval preview. The package test inspects the npm artifact and loads the extracted entry through Pi. Offline integration fixtures isolate workspaces, settings, credentials and sessions; they use scripted local models.

Type checking and SDK tests have been checked with Pi 1.0.2 and 1.4.0. An actual Pi 1.4.0 PTY with `@gotgenes/pi-permission-system` 41.0.0 checks the pre-approval preview for an `edit` tool ask and a protected-path ask, on an emulated 120x40 screen: the proposal and the prompt are on screen together while it waits, Ctrl+O expands and collapses it, denial leaves the file unchanged and marks it unverified with the gate's reason, approval shows the real diff, and saved details hold only the completed change (record: `test/pty/validation/2026-10-27/preapproval-tui.json` in the repository). These are bounded scenario/version checks, not universal host or third-party-stack compatibility.

See [CHANGELOG.md](CHANGELOG.md) for changes and the [issue tracker](https://github.com/gvanderclay/pi-codemode-diff/issues) for reports.

## License

[MIT](LICENSE). Originally by the authors of [hyein-cbio/pi-codemode-diff](https://github.com/hyein-cbio/pi-codemode-diff).
