# codemode_o parity — 2026-10-24

This checkout extends the TypeScript and native Go diff implementations to the
**exact** parent tools `codemode` and `codemode_o`. The version-1
`details.piCodemodeDiff` schema, result content, success/error, script values,
usage, permission hooks, write/edit queue and diff budgets are unchanged.
Completed PiG entries additionally record `toolName`; missing or unsupported
saved names fall back to `codemode`.

## Verified environment

- macOS/arm64, Node v26.12.1, Go 1.27.3.
- Actual Pi CLI 1.4.0.
- Stock PiG and the locally built fused binary both report
  **0.5.1+1.3.0.1402973a**. The fused build used the stock builder's matching
  source resolution, without host/core patches. Executable SHA-256 values are
  in the JSON evidence.
- `pi-opencode-mode@0.1.0`, pinned as a test-only development dependency.
- Standalone Go module checks use its unchanged SDK v0.4.1 dependency.
  PiG source/fused loading stages the matching host SDK.

The diff factory itself remains Node-free, but **codemode_o's OpenCode extension
requires Node**, including when the diff factory is fused. This run makes no
Node-free OpenCode claim and does not port the OpenCode runtime to Go.

## Results

**17 OpenCode scenarios × 6 execution paths × 2 load orders = 204 CLI invocations,
all strict comparisons pass.** Paths are Pi control/TypeScript, PiG
control/TypeScript, Go source and fused Go. Explicit-extension load order was
reversed; fused factories are inherently preloaded.

Scenarios: create/edit/overwrite, script failure after a completed write, failed
edit, read-only, long preview, oversized old snapshot, binary and invalid UTF-8,
line-ending/BOM normalization, empty creation, mixed parent calls, blocked and
disabled writes, late tool-result errors, helper descendants, native-required
rejection without replay, and sequential queued mutations. Assertions check the
expected statuses/change counts as well as cross-host equality.

Compared fields include exact written bytes, parent success/error,
model-facing results, ordered diff metadata, and PiG custom-entry data. Only
durations are normalized. Extension-off controls verify the extension does not
change execution. Pi intentionally uses inline diffs rather than PiG entries.

**Existing codemode regression:** all 25 original scenarios pass on the same six
paths (150 invocations). Four queue probes run three rounds on each path
(24 additional invocations): sequential/dependent edits succeed 3/3,
obsolete edits never report success then get overwritten (0/3), and twelve-write
batches drain correctly 3/3. This is a bounded regression run, not the earlier
20-round stress record.

**Actual PTYs:** Pi TS, PiG TS, Go source and fused Go pass preview, Ctrl+O
expansion/collapse, reload, further write, resume and expansion after resume.
Saved PiG entries retain the `codemode_o` label. The original `codemode` PTY suite also passes on all four extension paths. Terminal cleanup output is drained by the verifier to avoid a full-PTY shutdown deadlock on macOS.

A separate native `codemode` write probe passes with Node absent for Go source, and with an empty PATH (Node and Go absent) for fused Go. This is two bounded native-runtime probes, not Node-free OpenCode execution.

**Unit checks:** Go race tests and vet pass, including mixed concurrent roots,
exact-name exclusion, budgets, cleanup, saved rendering and the existing
independent TypeScript diff/edit oracles. Default Pi SDK 1.0.2 typecheck and
coverage suite pass (107 tests, one optional PiG loader skip); package smoke
checks load both TS entry files. Pi SDK 1.4.0 typecheck and the final suite also
pass in an isolated copy (107 passes, one skip), and the real Pi CLI comparisons
above use 1.4.0.

## PiG 0.5.1 TypeScript selection

This PiG version removed the private `__runtime()` SDK export, but still cannot
wrap callable `next()` renderers across its process boundary (D89). The default
entry deliberately remains fail-closed; it cannot detect this host automatically.
Use the explicit TS entry **instead of**, never alongside, the default or Go
implementation:

```bash
pig -e /path/to/pi-codemode-diff/src/pig-index.ts \
  -e /path/to/pi-opencode-mode/index.js \
  --tools read,edit,write,codemode,codemode_o
```

Or select `native/pig` instead of `src/pig-index.ts` to use the Go factory.
The package's default entry remains unchanged for Pi. No environment-variable,
executable-name, path-name or missing-renderer heuristic was added.

A first real-host run exposed the removed shim and correctly failed on missing
TS completed entries; it was not counted as a passing comparison. The optional
direct Node-loader fixture could not load this host's cached source tree because
its vendored Chalk dependency tree was incomplete. It remains optional/skipped
in the default suite. The actual PiG CLI and PTY checks above execute the real
host runtime and are separate evidence.

## Reproduce

Build a matching fused binary without installing it:

```bash
pig piglet build native/piglet.yaml --format binary --out /tmp/codemode-diff
python3 native/tests/opencode_parity.py --pi /path/to/pi/dist/cli.js \
  --pig /path/to/pig --fused /tmp/codemode-diff
# Repeat with --opencode-first.
python3 native/tests/opencode_tui.py --pi /path/to/pi/dist/cli.js \
  --pig /path/to/pig --fused /tmp/codemode-diff
python3 native/tests/cross_host.py --pi /path/to/pi/dist/cli.js \
  --pig /path/to/pig --fused /tmp/codemode-diff \
  --pig-typescript-entry "$PWD/src/pig-index.ts" --runs 1 --queue-rounds 3
(cd native/pig && go test -race ./... && go vet ./...)
npm run typecheck
npm run test:coverage
```

Each verifier isolates settings, credentials, sessions and files and uses a
loopback scripted provider; there is no remote model. `--output` must select a
new empty directory. Raw events, provider requests and terminal transcripts
remain in the temporary evidence directories printed by each command.

Compact evidence is retained in the repository under
[../validation/2026-10-24](https://github.com/hyein-cbio/pi-codemode-diff/tree/v0.1.5-pig/native/validation/2026-10-24/):
[OpenCode last](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5-pig/native/validation/2026-10-24/opencode-after.json),
[OpenCode first](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5-pig/native/validation/2026-10-24/opencode-first.json),
[OpenCode TUI](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5-pig/native/validation/2026-10-24/opencode-tui.json), and
[codemode regression](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5-pig/native/validation/2026-10-24/codemode-regression.json),
[codemode TUI](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5-pig/native/validation/2026-10-24/codemode-tui.json), and
[native Node-free probes](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5-pig/native/validation/2026-10-24/native-node-free.json).
These records do not supersede historical Linux/version-specific reports.
Windows, other host releases, arbitrary extension stacks and byte-identical
inline/custom-entry UIs are not certified. This validation run did not install,
publish or push packages; subsequent release operations are recorded separately.
