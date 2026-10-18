# Native Go extension for PiG

This module ports pi-codemode-diff's PiG behavior to a Go factory. The same `Extension() *sdk.Extension` runs as a Go source subprocess or as a fused component in a Piglet Binary. It uses no Node.js at runtime. The TypeScript package remains the Pi implementation.

## Requirements

- PiG 0.4.1, pinned to Pi 1.0.3.
- Go 1.27.2 for source builds and Piglet Binary builds. The module language floor is Go 1.26.
- An active `codemode` tool. This extension does not enable it.

The module uses the public Go SDK v0.4.1. It imports no PiG internal packages and makes no changes to PiG's source. A fused binary needs neither Go nor Node to run this extension after it is built.

Latest stable releases were rechecked on 2026-10-16: Pi **1.3.0**, PiG **0.4.1+1.0.3**, and Go SDK **0.4.1**. Core execution, shared queues, TUI, and Node-free runtime checks pass. Released PiG has an existing tool-input-rewrite limitation, also present with this extension disabled; the strict full parity gate retains those two failures. See [latest-release compatibility](COMPATIBILITY.md) for results, exact source identities, and evidence.

## Native release archives

The native release is **0.1.4-pig**, corresponding to the TypeScript/npm release **0.1.4**. Download the named source archives and `SHA256SUMS` from the [GitHub release](https://github.com/hyein-cbio/pi-codemode-diff/releases/tag/v0.1.4-pig). These attachments include `native/package.json`, the `native/pig` Go module, and `native/piglet.yaml`, without the TypeScript implementation or Node dependencies. No compiled binaries are attached.

After verifying the archive checksum, extract and install the package:

```bash
tar -xzf pi-codemode-diff-0.1.4-pig-source.tar.gz
cd pi-codemode-diff-0.1.4-pig
pig install "$PWD/native"
```

GitHub's automatic **Source code** downloads contain the whole repository; use the named native source attachments for the Go-only distribution. Development scripts under `native/tests` require a full repository checkout.

## Go source mode

From the repository root, load the factory for one session:

```bash
pig -e "$PWD/native/pig" --tools read,bash,edit,write,codemode
```

Or install the native package persistently, also from the repository root:

```bash
pig install "$PWD/native"
```

`native/package.json` declares `pig` as the package's extension path. Install the package directory (`native`), not the individual Go extension directory (`native/pig`): PiG 0.4.1 rejects the latter as "an extension, not a package". The `-e` command above still loads that individual extension directly.

This metadata is only a package-discovery wrapper; it adds no Node.js runtime requirement. Local installation references the directory in place, so keep it at the installed path. The repository-root package remains the TypeScript implementation; do not install both implementations together.

Enable codemode separately if it is not already in your default tools. Use `/reload` after source edits. Load one implementation: remove or disable the TypeScript extension when selecting the Go factory. Both implementations register `write`, `edit`, and the same custom-entry renderer.

The source directory is named `pig`, so the factory's registration identity is `pig`. Its Go module path is `github.com/hyein-cbio/pi-codemode-diff/native/pig`. PiG builds a native subprocess through its ordinary Go factory loader and stages its matching SDK without editing this module.

## Fused mode

The adjacent `native/piglet.yaml` requires fused realization. It selects the same Go factory and disables extension/skill discovery. Build from the repository root:

```bash
mkdir -p native/bin
pig piglet validate native/piglet.yaml
pig piglet build native/piglet.yaml --format binary --out native/bin/codemode-diff
native/bin/codemode-diff --tools read,bash,edit,write,codemode
```

When building from a PiG source checkout, set `PIG_SOURCE_ROOT` to that checkout. A release binary can fetch its matching source itself. The builder refuses subprocess fallback because the manifest sets `build.extensionRealization: fused`.

Fusion changes the delivery and process boundary. It uses the same factory, events, data format, and renderer. It does not turn the subprocess SDK's renderer marker into a callable native renderer.

## Behavior

- Captures successful nested writes and edit results, including descendants of helper tools. Direct writes produce no diff metadata.
- Isolates parallel parent calls and displays changes in call-start order.
- Adds `details.piCodemodeDiff` to the parent result and appends a persisted `pi-codemode-diff:pig` custom entry at completion. File diff data stays outside model-facing result content and provider requests.
- Preserves the host's codemode card. The custom entry contains three changes and eight visual lines per diff when collapsed. Ctrl+O expands and collapses the entry. The expansion hint uses generic text because the Go SDK does not expose Pi's `keyText` helper.
- The header distinguishes per-call changes from distinct recorded paths, e.g. `File changes (5) · 2 files`. Paths are compared exactly as recorded, without resolving aliases, symlinks, or case differences. It adds `· N diffs unavailable` for changes with no retained diff, including those outside the collapsed preview; per-change notices explain the reasons. Expanding cannot recover unavailable diffs. Empty diffs and preview-folded diffs are not counted as unavailable. This display-only summary also works for saved entries.
- Uses theme diff colors and bounded jsdiff-compatible word highlighting. Sanitizes control characters in displayed paths and file content. Wraps by grapheme width before applying the preview limit.
- Restores display from saved entries after resume and `/reload`. Old metadata-only sessions are not backfilled.
- Reports a captured mutation together with a final tool error or cancellation.

Display budgets match the TypeScript implementation:

| Data | UTF-8 bytes | Logical lines |
| --- | ---: | ---: |
| Each old/new write input | 256 KiB | 2,000 |
| Each retained diff | 64 KiB | 2,000 |
| All retained diffs per parent | 256 KiB | 8,000 |

Exceeding a budget omits the whole diff and retains a notice, without restricting the write. A snapshot reads at most 256 KiB plus one byte from the open descriptor. Binary, non-UTF-8, unreadable, and nonregular previous content produces a notice. Snapshots are discarded after diff generation. Diff data can contain source code and is retained in session files.

## File mutation boundary

The public Go SDK does not expose PiG's host mutation queue or pluggable built-in filesystem operations. This factory therefore executes both `write` and `edit` through **one shared per-file mutation queue**, in source and fused modes. Both tools set `defaultActive: false`, preserving the host's tool selection. No PiG core or SDK changes are required.

Reservations are taken at `tool_execution_start`, before concurrent Go handlers can reorder filesystem work. A write snapshots immediately before writing within its reservation. An edit holds the same reservation from reading through matching, writing, and result generation. Existing symlink aliases share a canonical key. Blocked and cancelled calls release their tickets without admitting later calls past an earlier active operation; lifecycle cleanup releases unused reservations. A hook that rewrites the input path releases the old reservation and reserves the actual target. Different files remain independent.

The edit implementation preserves the SDK's argument adapters, original-file matching for disjoint replacements, fuzzy matching, ambiguity and overlap errors, BOM and line endings, cancellation checks, success text, display diff, unified patch, and first-changed-line metadata. Nineteen independent Pi SDK fixtures verify its prepared arguments, exact file bytes, errors, and result metadata.

On PiG's TypeScript path, registering the SDK's complete edit definition alongside its write definition gives both tools the same Node runtime queue. Pi already shares that queue and keeps its existing path. The former split between extension writes and host edits is fixed; [cross-host parity results](PARITY.md) record the failing reproducers before the change and the passing checks afterward.

Load one implementation. Another extension that replaces either tool with its own executor must provide compatible coordination. These queues cover the extension's local `write` and `edit` operations; shell commands, external processes, custom filesystem providers, and third-party tool replacements require their own coordination.

Validation currently targets Linux/amd64. Windows path conversion, complete platform filesystem error equivalence, and arbitrary third-party extension stacks are not certified by these checks. The native renderer is not a byte-for-byte clone of Pi's inline renderer.

## Development and validation

Run the standalone Go module checks:

```bash
cd native/pig
go test -race ./...
go vet ./...
```

From the repository root, regenerate the independent TypeScript oracle when the behavior changes:

```bash
npm ci
node --import tsx native/tests/generate-fixtures.ts
node --import tsx native/tests/generate-edit-fixtures.ts
```

`testdata/typescript.json` and `testdata/edits.json` record results produced by the actual TypeScript implementation and Pi SDK. Tests cover line diff tie-breaking, word highlighting including Korean/emoji and whitespace fallbacks, persisted validation, size/line budgets, capture isolation, queue lifetime, Unicode widths, and terminal sanitization.

Compare the actual executables after building the fused binary. Use the same PiG source revision for the stock host and the fused builder. Matching `--version` strings alone does not establish that they contain the same fixes. For a source-checkout validation, set `PIG_SOURCE_ROOT` before the fused build, then build the stock host from that checkout:

```bash
(cd "$PIG_SOURCE_ROOT" && go build -o /tmp/pig-diff-verification-host ./cmd/pig)
python3 native/tests/verify.py \
  --pig /tmp/pig-diff-verification-host \
  --fused "$PWD/native/bin/codemode-diff"
```

The verifier uses a loopback OpenAI-compatible server with scripted tool calls. It isolates all agent homes, settings, files, and sessions. It compares written bytes, result content/status, and diff metadata after removing only elapsed times. It matches independent concurrent completions by call ID while preserving the order inside each parent's change array. Go runs use a PATH without Node; the verifier requires Go on the invoking PATH and no Node under `/usr/bin` or `/bin`. The TUI probes use a POSIX PTY to check completed entries, Ctrl+O, `/reload`, and restored renderers. A separate fused probe runs with an empty PATH, so neither Node nor Go is available. Evidence remains in the printed temporary directory. No remote model or provider credential is needed.

## Validation record

Validated on 2026-10-16 on Linux/amd64 with Go 1.27.2:

- TypeScript type checking and all 89 existing tests pass, including the actual PiG Node loader check without skips. The Pi SDK oracle is 1.0.2.
- Go race tests, `go vet`, and `go fix -diff` pass. The oracle contains 129 line-diff cases, 30 write-metadata cases, 167 word-rendering cases, and four persisted-data cases.
- All 25 cross-host scenarios pass twice across Pi/PiG controls, TypeScript, Go source, and fused paths (300 invocations). Sequential and dependent parallel mutations pass 20/20; successful edits overwritten by writes occur 0/20; queued batches pass 3/3 on every path. The independent edit oracle has 19 cases. See [the full report](PARITY.md).
- All 17 original executable scenarios also match across TypeScript, Go source, and fused implementations on PiG commit `e63c61c338e2aaf0d130513db2c2e63fe2e7dafd` (0.4.1+1.0.3). Cases include direct and nested writes, overwrite/edit, empty and oversized files, binary/non-UTF-8 content, normalization, read-only calls, failed scripts, parallel parents, symlink aliases, blocked writes, late errors, helper descendants, and hook-rewritten paths.
- Source and fused TUI entries, Ctrl+O expansion/collapse, `/reload`, further writes after reload, and restored renderers pass without Node. Fused nested writing also passes with an empty PATH.
- The installed release executable 0.4.1+1.0.3 passed the first 16 scenarios. Its Go `tool_call` hook did not apply the probe's input rewrite. The paired source-commit binaries apply it and pass the seventeenth scenario. This is a host revision boundary; the extension does not patch the host or reinterpret a refused rewrite.

Representative benchmarks on this cloud machine report about 91 µs / 76 KB / 54 allocations for a 500-line write diff and 2.0 ms / 564 KB / 8,066 allocations for a collapsed 2,000-line entry. These are resource baselines, not speedup claims. CPU samples include line counting, tokenization, grapheme processing, and GC. Diff input and retained data budgets bound this work. File descriptors close after each snapshot; the extension retains no backup or background worker.

Benchmarks cover a 500-line write diff and a collapsed 2,000-line entry:

```bash
cd native/pig
go test -run '^$' -bench . -benchmem
```

The extension owns no background goroutines. Event and tool state is guarded by mutexes; queue reservations drain on completion, cancellation, or lifecycle cleanup. Rendering reads saved bounded data and the current theme without IPC calls or transcript-history scans. The PiG SDK owns its transport and renderer request lifetimes.

See `NOTICE` for PiG and jsdiff source attribution and license terms. Pi is the reference implementation. Michael Kinsy created PiG, which was originally developed at Hewlett Packard Enterprise.
