# pi-codemode-diff-native

Native Go diff display for **PiG**. Captures `edit` and `write` calls inside `codemode` and optional `codemode_o`, without adding diffs to model-facing tool output.

This is an **independently published npm package**. It contains the Go source factory and a fused-build manifest, not the TypeScript implementation or Node runtime dependencies. Pi users should install the separate [pi-codemode-diff](https://www.npmjs.com/package/pi-codemode-diff) package. Neither package requires the other. **Load one diff implementation per session.**

## Install

```bash
pig install npm:pi-codemode-diff-native@0.1.5-pig
```

Run `/reload` in an existing PiG session. The package declares `pig` as its extension path; it is built on first source use, not shipped as a precompiled executable.

### Requirements

- PiG: historical `codemode` checks cover 0.4.1+1.0.3; current `codemode` and `codemode_o` checks use **0.5.1+1.3.0.1402973a**.
- A host-compatible Go toolchain for source compilation and fused builds. The module language floor is **Go 1.26**; current checks use **Go 1.27.3**. PiG stages its matching SDK when loading/building the factory; standalone module tests use SDK v0.4.1.
- An active parent tool and active file tools. This extension does not install/enable `codemode`, `codemode_o`, `write` or `edit`.

An npm-based installation needs npm and its Node runtime to download the package. **The Go diff factory itself requires no Node at runtime.** Go source mode needs a Go toolchain on first build; a successfully fused binary needs neither Go nor Node to run this factory.

### Optional OpenCode tool

`codemode_o` comes from the separate `pi-opencode-mode` extension:

```bash
pig install npm:pi-opencode-mode@0.1.0
```

Reload after installing both packages. That OpenCode extension **requires Node**, even when this diff factory is fused. Its syntax, timeout, call-count and output limits are unchanged. The diff factory never delegates or replays a failed script.

## Local or extracted package

The commands in this section start in **this package root**, containing `package.json`, `pig/` and `piglet.yaml`. For a full repository checkout, first `cd native`.

```bash
# Persistent local install: keep this directory at its installed location.
pig install "$PWD"

# Or try the factory for one session without persisting an installation:
pig -e "$PWD/pig" --tools read,edit,write,codemode
```

Install the package root, not the `pig` module directory. Direct `-e` loading of that individual factory remains supported.

The [native GitHub release](https://github.com/hyein-cbio/pi-codemode-diff/releases/tag/v0.1.5-pig) also carries the npm source tarball and its SHA-256 checksum. It contains this package's files only. After checking the checksum:

```bash
tar -xzf pi-codemode-diff-native-0.1.5-pig.tgz
cd package
pig install "$PWD"
```

GitHub's automatic **Source code** downloads contain the full repository, not just this npm package. No precompiled binary is attached to this release.

## Fused Piglet Binary

From this package root:

```bash
mkdir -p bin
pig piglet validate piglet.yaml
pig piglet build piglet.yaml --format binary --out bin/codemode-diff
bin/codemode-diff --tools read,edit,write,codemode
```

The manifest requires fused realization, selects the same Go factory, and disables extension/skill discovery. Fusion changes delivery, not capture semantics or queue ownership. Load any optional OpenCode extension explicitly if using `codemode_o`; it is not included in this binary's Go factory.

Use the source revision matching your PiG host for reproducible builds. A release builder can resolve matching source itself; set `PIG_SOURCE_ROOT` when deliberately building from a source checkout. Matching version strings alone are not a substitute for source identity.

## Display and persistence

- Only exact `codemode` and `codemode_o` names establish capture roots. Helper descendants are captured; direct edit/write calls do not get parent diff metadata.
- Parallel parents are isolated by call ID, including mixed tool roots. Changes appear in call-start order, not necessarily global file mutation order.
- The factory preserves the parent's script/output card and appends a completed `pi-codemode-diff:pig` custom entry. PiG does not have Pi's inline/live diff presentation.
- Collapsed entries preview **3 changes** and **8 visual lines per diff**; **Ctrl+O** expands/collapses. Expansion reveals retained hunks, not the entire unchanged file.
- Headers count changes and distinct recorded paths. Missing diffs are summarized across the whole call, including outside the preview. Empty diffs and preview-folded diffs are not unavailable.
- Theme colors, bounded word highlighting, Unicode-width wrapping and terminal-control sanitization apply to display only.
- Parent results retain version-1 `details.piCodemodeDiff`; entries also store `toolName` and `toolCallId`. Old entries without a supported name render as `codemode`.
- Saved entries work after resume and reload. Old metadata-only sessions are not backfilled. Script failures retain completed writes; observed changes with a final tool error/cancellation show a warning.

Result content, structured content, script return values, usage and success/error are left to the host. Diff entries stay outside model context. Explicitly returning file contents in a script still sends those contents to the model.

### Display budgets

| Data | UTF-8 bytes | Logical lines |
| --- | ---: | ---: |
| Each previous/new write input | 256 KiB | 2,000 |
| Each retained diff | 64 KiB | 2,000 |
| Total retained diffs per parent | 256 KiB | 8,000 |

Exceeding an inclusive budget omits the whole diff and retains a notice, without restricting the file operation. Snapshots are bounded and discarded after diff generation. Binary, invalid UTF-8, unreadable and nonregular previous content produce notices instead of invented diffs. Write display normalization does not alter written bytes. Diffs can contain sensitive source code and increase session storage; review sessions before sharing them.

## Mutation boundary and limitations

The factory runs **both write and edit through one per-file queue**, in source and fused modes. It reserves tickets at `tool_execution_start`, before concurrent handlers can reorder work. Existing symlink aliases share a canonical key. Writes snapshot inside their reservation; edits hold it through reading, matching and writing. Cancelled/blocked reservations drain without letting later operations overtake active ones. Rewritten paths reserve the actual target; unrelated files remain independent.

The factory reuses the edit contract through a tested native port: argument adapters, original-file matching for disjoint replacements, fuzzy matching/errors, BOM/line endings, cancellation, success text, diff/patch and first-changed-line metadata. The [module notes](pig/README.md) describe validation.

- Other extensions replacing either file tool need compatible coordination. Shell commands, external processes and custom/remote filesystems are not governed by this queue or captured as diffs.
- This is change visibility, not undo, checkpoints, backups or byte-exact recovery. Forced termination and every cancellation path are not guaranteed capture boundaries.
- Old PiG 0.4.1 releases have an existing input-rewrite limitation, including with this extension disabled; see the [historical compatibility report](pig/COMPATIBILITY.md).
- Current executable checks cover macOS/arm64; earlier checks cover Linux/amd64. Windows path conversion, complete platform filesystem error equivalence, arbitrary extension stacks and pixel/byte-identical Pi/PiG UIs are not certified.

## Development and validation

The npm tarball intentionally omits Go tests/fixtures and repository-only validation scripts. To run them, use the [full source checkout for this release](https://github.com/hyein-cbio/pi-codemode-diff/tree/v0.1.5-pig), then:

```bash
# From the full repository root, not the npm package root:
(cd native/pig && go test -race ./... && go vet ./...)
python3 -m unittest discover -s native/tests -p 'test_*.py'
```

The packed Go module can be compiled independently with `(cd pig && go build ./...)`. TypeScript is required only for repository oracle regeneration/cross-host development, not for the native factory's execution.

See [OpenCode parity](pig/OPENCODE.md) for actual Pi 1.4.0 / PiG 0.5.1 scenario counts, PTY reload/resume checks and evidence. These are bounded version/platform checks, not universal parity. See [CHANGELOG.md](CHANGELOG.md) for this package's release notes.

## License and support

[MIT](LICENSE); third-party notices are in [pig/NOTICE](pig/NOTICE). Report problems in the [issue tracker](https://github.com/hyein-cbio/pi-codemode-diff/issues).
