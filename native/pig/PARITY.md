# Pi and PiG parity report

This report covers Pi 1.0.3 and the specified PiG main-source revision. See [latest-release compatibility](COMPATIBILITY.md) for Pi 1.3.0 and the official PiG 0.4.1 release, including its two existing input-rewrite differences.

Validated on 2026-10-16 on Linux/amd64. **All tested cross-host comparisons pass after the shared write/edit queue fix**, including the previously failing same-file concurrent mutation reproducers. This establishes the tested contracts and versions; it does not claim equivalence of every host feature or arbitrary extension combinations.

## Executables and scope

- Pi 1.0.3, installed separately from npm, executed through its real CLI.
- PiG 0.4.1+1.0.3, built from commit `e63c61c338e2aaf0d130513db2c2e63fe2e7dafd`.
- The native fused binary built from that same PiG commit, with the corrected Go factory.
- Node v24.19.0 and Go 1.27.2. Unit-test Pi SDK: 1.0.2; real CLI reference: 1.0.3.
- pi-codemode-diff TypeScript v0.1.3 base `12c0f1cf15caba01561a826a2c7572621f70332b`, plus the current fix and native Go implementation.

Six paths run against a local scripted OpenAI-compatible endpoint: Pi without the extension, Pi with TypeScript, PiG without the extension, PiG with TypeScript, PiG with the Go source factory, and the fused Go Piglet Binary. No external model or provider credentials are used. Agent homes, settings, sessions, and files are disposable. Each host receives the same script and the same working-directory path.

The comparison checks exact written bytes, parent success/error status, model-facing tool content captured in the second provider request, and `details.piCodemodeDiff`. Only runtime durations are removed. Independent parent completions are matched by call ID; each parent's change order remains significant. Extension-off controls check that enabling the extension preserves file results, success/error status, and model-facing results.

## Fix

Previously, replacing PiG's write executor moved writes into the extension's queue while edits stayed in PiG's host queue. The queues could run independently even for the same file. A dependent edit could read stale content and fail, or report success before a later write overwrote its changes. Fusion alone did not fix this: sharing a process did not share the queue object.

The extension now owns both file mutation executors on PiG:

- TypeScript registers the SDK's full edit definition alongside its write definition. Both import the same Node runtime mutation queue, preserving the SDK's preparation, cancellation, result details, and renderers.
- Go source and fused factories register write and edit with one native per-file queue. Tickets are reserved at `tool_execution_start`, including edits. Reads, matching, writes, and diff generation stay inside the reservation. Skipped/cancelled calls drain safely; rewritten paths reserve the actual target.
- Different files can run independently. Both tools remain `defaultActive: false`, so registration does not activate disabled tools.
- Pi keeps its original execution path. No PiG core, protocol, or SDK changes were made.

Load one implementation. A third-party extension replacing write or edit separately must coordinate its executor. The queue does not govern shell commands, external processes, or custom filesystem providers.

## Executable behavior

**25 scenarios pass twice on all six paths: 300 executable invocations.** The original 17 scenarios and eight additional edit scenarios were run as separate batches, each with the full queue probes. Both batches report `full_parity: true`.

The original cases cover direct and nested writes, edit/overwrite, script failure after writing, failed edits, read-only calls, long and oversized content, binary and invalid UTF-8 snapshots, line-ending/BOM normalization, empty creation, parallel parents, parallel writes through existing symlink aliases, blocked writes, late tool errors, deeper helper descendants, and hook-rewritten paths.

Additional cases cover direct edits, BOM/CRLF preservation, disjoint original-file replacements, Unicode fuzzy matching, ambiguous matches, overlapping edits, blocked edits followed by writes, and edit path rewrites followed by writes to the original path. The last two check that unused reservations do not deadlock subsequent work.

For every tested case:

- Pi TypeScript and all three PiG extension paths agree on written bytes, parent status, model-facing results, and diff metadata.
- Each extension-on result agrees with its host's extension-off control for file bytes, status, and model-facing content.
- Diff metadata does not enter model-facing tool content.
- Pi records no `pi-codemode-diff:pig` entries. PiG records one completed custom entry per parent with changes. These are intentional presentation/storage differences.

## Same-file mutation regression results

These are controlled reproducer counts, not production failure rates. Each row below is the result after the fix; both validation batches produced these counts.

| Execution path | Sequential write → edit, successes / 20 | Dependent parallel write + edit, expected edits / 20 | Successful edit later overwritten, occurrences / 20 | Queued-write batch then edit, expected edits / 3 |
| --- | ---: | ---: | ---: | ---: |
| Pi, extension off | 20 | 20 | 0 | 3 |
| Pi + TypeScript | 20 | 20 | 0 | 3 |
| PiG, extension off | 20 | 20 | 0 | 3 |
| PiG + TypeScript | 20 | 20 | 0 | 3 |
| PiG + Go source | 20 | 20 | 0 | 3 |
| PiG + fused Go | 20 | 20 | 0 | 3 |

The dependent probe starts from `seed` and submits a write of `base`, followed by an edit from `base` to `edited`, in one `Promise.allSettled`. Both calls succeed and the final content is `edited`.

The overwrite probe submits the same write followed by an edit of the obsolete `seed`. The write succeeds; the now-inapplicable edit rejects. A successful edit must never be reported and then overwritten in this schedule.

The queued-batch probe submits twelve writes to a 200-line file, followed by an edit dependent on the twelfth write. Every write computes a real bounded diff inside the queue. All thirteen operations succeed and the final edit is present.

For comparison, the retained **before-fix** results were:

| PiG extension path | Dependent edits / 20 | Successful edits overwritten / 20 | Queued batches / 3 |
| --- | ---: | ---: | ---: |
| TypeScript | 12 | 7 | 1 |
| Go source | 19 | 1 | 1 |
| Fused Go | 20 | 0 | 1 |

The shared executor design supplies the ordering guarantee; passing one timing-sensitive schedule alone would not establish it.

## Edit, lifecycle, and runtime checks

- Nineteen independent Pi SDK edit fixtures check argument preparation, exact file bytes, success text, display diff, unified patch, and first-changed-line metadata, or exact errors. Cases include legacy/JSON/object adapters, disjoint edits, BOM/CRLF, Unicode, invalid UTF-8 decoding, fuzzy matching, ambiguity, overlap, unchanged/empty edits, missing files, deletion, and distant patch hunks.
- TypeScript type checking and all 89 tests pass with no skips. The real PiG Node SDK/loader fixture additionally runs twenty dependent and twenty obsolete parallel write/edit pairs using the registered definitions.
- Go race tests, `go vet`, and `go fix -diff` pass. Queue checks cover aliases, cancellation, blocked reservations, lifecycle cleanup, and independent files; the original diff/rendering oracle remains green.
- Real PTYs pass on Pi TypeScript, PiG TypeScript, Go source, and fused Go: preview, Ctrl+O expansion/collapse, `/reload`, a write after reload, session resume, and expansion after resume. Pi shows inline diffs; PiG shows completed custom entries. Pixel and byte equality of the UIs is not asserted.
- The original PiG-only verifier also passes all 17 scenarios. Go source/fused run without Node, including TUI reload/resume. The fused execution probe passes with an empty PATH, without Node or Go.

Windows filesystem behavior and arbitrary third-party extension stacks are outside this Linux validation record.

## Evidence and reproduction

Compact machine-readable summaries are retained under [native/validation/2026-10-16](../validation/2026-10-16/): [before](../validation/2026-10-16/before.json), [original scenarios after](../validation/2026-10-16/after.json), [additional edits after](../validation/2026-10-16/edit-after.json), [TUI](../validation/2026-10-16/tui-after.json), and [Node-free runtime](../validation/2026-10-16/no-node-after.json). Cross-host summaries include executable SHA-256 hashes. The before summary represents the earlier implementation, not the current gate.

Raw events, stderr, second provider requests, normalized comparisons, and terminal transcripts remain in the workspace directories `/workspace/scratch/pi-pig-parity-fixed`, `/workspace/scratch/pi-pig-edit-parity-fixed`, `/workspace/scratch/pi-pig-tui-fixed`, and `/workspace/scratch/pi-pig-no-node-fixed`.

Build stock PiG and the fused binary from the same source revision as described in `README.md`. Install Pi 1.0.3 separately, then run from the repository root:

```bash
python3 native/tests/cross_host.py \
  --pi /path/to/pi-1.0.3/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --pig /path/to/matching/pig \
  --fused "$PWD/native/bin/codemode-diff" \
  --runs 2 --queue-rounds 20

python3 native/tests/cross_host_tui.py \
  --pi /path/to/pi-1.0.3/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --pig /path/to/matching/pig \
  --fused "$PWD/native/bin/codemode-diff"
```

The first command now runs all 25 scenarios and the queue probes. It exits with status 1 if any tested comparison differs. The PTY command waits for the provider turn to complete before issuing UI actions. Use a new empty `--output` directory for each run to preserve earlier evidence.

Regenerate the independent edit fixtures with `node --import tsx native/tests/generate-edit-fixtures.ts`, then run `go test -race ./...` inside `native/pig`.
