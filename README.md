# pi-codemode-diff

Show file diffs for `edit` and `write` calls inside Pi's `codemode` and the optional `codemode_o` tool. Diffs stay in session display metadata, **not in model-facing tool output**.

This npm package is the **TypeScript implementation for Pi**. PiG users can install the separate [pi-codemode-diff-native](https://www.npmjs.com/package/pi-codemode-diff-native) Go package instead. Neither package depends on the other. Load only one diff implementation per session.

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
pi install npm:pi-codemode-diff@0.1.5
```

Run `/reload` in an existing session. Alternatively, install this release from Git:

```bash
pi install git:github.com/hyein-cbio/pi-codemode-diff@v0.1.5
```

### Optional OpenCode tool

`codemode_o` is provided by a separate extension, not bundled here:

```bash
pi install npm:pi-opencode-mode@0.1.0
```

Load both extensions and run `/reload`. Either load order works. Only the exact names `codemode` and `codemode_o` establish capture roots; prefix-like tools do not.

The original tool still renders its script, output, warnings and duration. Its result content, structured content, script return values, usage and success/error status are unchanged. Permissions, activation, file mutation queues and diff budgets are unchanged too. OpenCode's own syntax/execution limits still apply: use `return` or `await tools.*`, not Pi-only `text()`. This extension never delegates or replays failed scripts.

`pi-opencode-mode@0.1.0` is a development dependency for integration tests only; ordinary installation of this package does not install it.

## Preview and full view

- Collapsed results show the first **3 changes**, with **8 visual lines per diff**.
- **Ctrl+O** expands/collapses tool output; customized Pi expansion bindings are reflected in the hint.
- Expansion shows all retained diff hunks, not the entire unchanged file.
- Changes to the same path remain separate, in call-start order. The header also counts distinct recorded paths, without resolving aliases or symlinks.
- Unavailable diffs are counted across the entire call, including changes outside the preview. Each change retains an explanatory notice. Empty diffs and preview-folded diffs are not counted as unavailable.
- Single-line replacements highlight changed words. Large/complex comparisons and whitespace changes that cannot be reconstructed exactly keep line colors instead.

## Capture and persistence

Successful nested edits reuse the edit tool's `details.diff`. Nested writes delegate to Pi's built-in write definition, taking a bounded previous-content snapshot inside its file mutation queue before writing. Direct edit/write calls keep their original behavior and do not acquire parent diff metadata.

Display data uses the unchanged version-1 `details.piCodemodeDiff` schema. Parallel parent calls are isolated by call ID, including mixed `codemode`/`codemode_o` calls. Helper-tool descendants are captured as well. Display order does not imply a global mutation order across parallel calls.

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

## PiG users

The recommended separately published package is [pi-codemode-diff-native](https://www.npmjs.com/package/pi-codemode-diff-native); its [own installation guide](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5-pig/native/README.md) covers Go source and fused binaries.

This TypeScript package also includes a PiG-specific entry. PiG cannot wrap callable `next()` renderers across its Node subprocess boundary, so that entry preserves the parent card and appends persisted, non-model-facing completed diff entries instead of Pi's inline/live section.

PiG 0.5.1 removed the private SDK export used by automatic detection. **Do not use the default package entry on that host.** Select the explicit file from this package instead, replacing the placeholder with its absolute installed/extracted directory:

```bash
pig -e /absolute/path/to/pi-codemode-diff/src/pig-index.ts
```

Do not load it alongside the default entry or the native implementation. Older PiG hosts exposing the exact `__runtime().api` identity can still use automatic detection. No environment-variable, executable-name, path-name or missing-renderer heuristic is used. Old PiG entries without a supported parent name render as `codemode`; metadata-only sessions are not backfilled.

## Local development

From a full repository checkout:

```bash
npm ci
npm run typecheck
npm test
npm run test:coverage
python3 -m unittest discover -s native/tests -p 'test_*.py'
```

Try the source without changing Pi settings:

```bash
pi -e /absolute/path/to/pi-codemode-diff/src/index.ts
```

Pi installs the `diff` runtime dependency for npm/git installations. It does not install dependencies for a local path: run `npm install --omit=dev --omit=peer --ignore-scripts` in the package root for local runtime use, or `npm ci` for development. Host-provided Pi modules are peers, not bundled runtime dependencies. `/reload` picks up source changes.

Tests cover capture isolation, result preservation, bounded snapshots/diffs, filesystem edge cases, renderer composition, saved metadata, reload/resume and both tool roots. Package tests inspect both independent npm artifacts and load the extracted TS entries through Pi. Offline integration fixtures isolate workspaces, settings, credentials and sessions; they use scripted local models.

Type checking and SDK tests have been checked with Pi 1.0.2 and 1.4.0. Actual Pi 1.4.0 / PiG 0.5.1 checks cover TypeScript, Go source and fused delivery, including PTY expansion/reload/resume. These are bounded scenario/version checks, not universal host or third-party-stack compatibility. The optional direct PiG Node-loader fixture needs a matching complete runtime tree and is skipped by default.

See [OpenCode parity](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5/native/pig/OPENCODE.md) for exact scope and evidence, [CHANGELOG.md](CHANGELOG.md) for release changes, and the [issue tracker](https://github.com/hyein-cbio/pi-codemode-diff/issues) for reports.

## License

[MIT](LICENSE).
