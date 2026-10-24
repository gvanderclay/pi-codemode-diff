# Native Go diff factory

This Go module implements the `pi-codemode-diff-native` npm package's
`Extension() *sdk.Extension` factory for PiG. Use the
[package installation guide](https://github.com/hyein-cbio/pi-codemode-diff/blob/v0.1.5-pig/native/README.md)
for npm installation, extracted-package paths, optional `codemode_o` and fused
build instructions. Load this factory or the TypeScript diff extension, never
both in one session.

## Execution contract

- The exact parent tools `codemode` and `codemode_o` establish isolated capture
  batches. Descendants of helper tools are included; unrelated prefixes and
  direct file-tool calls do not establish batches.
- The factory adds version-1 `details.piCodemodeDiff` and completed persisted
  `pi-codemode-diff:pig` entries. Entries record the actual parent name; legacy
  names default to `codemode`. Model-facing results are not rewritten.
- Native write and edit share one per-file queue, with tickets reserved at
  `tool_execution_start`. Existing symlink aliases share a key; cancellation,
  blocking and path rewrites drain unused reservations. Snapshot/read/match/
  write/diff work stays inside the relevant reservation.
- The edit port preserves argument preparation, original-file matching for
  disjoint edits, fuzzy matching, overlap/ambiguity errors, line endings/BOM,
  cancellation, result text and diff/patch metadata. Independent Pi SDK fixtures
  check these contracts.
- Display previews, budgets, normalization, error notices and saved rendering
  follow the TypeScript diff implementation. PiG uses separate completed entries,
  not Pi's inline/live presentation.

The SDK does not expose PiG's host mutation queue or pluggable built-in filesystem
operations, so both mutation executors belong to this factory. Another extension
replacing either tool must supply compatible coordination. The queue does not
cover shell commands, external processes or custom/remote filesystem providers.

## Runtime and toolchains

The module language floor is Go 1.26. Standalone development uses SDK v0.4.1;
PiG source/fused loading stages its matching SDK. Current checks used Go 1.27.3.
The factory imports no PiG internal packages.

The Go factory requires no Node at runtime. Source builds need Go; a fused
binary can run the factory without Go or Node. The optional `pi-opencode-mode`
extension providing `codemode_o` is separate and still needs Node.

## Development

The npm tarball omits `*_test.go` and `testdata/`. For tests and benchmarks,
use a full repository checkout and run from `native/pig`:

```bash
go test -race ./...
go vet ./...
go test -run '^$' -bench . -benchmem
```

From a packed package's `pig` directory, `go build ./...` checks independent
compilation. Fixture regeneration needs the full repository's development
dependencies; from its root:

```bash
npm ci
node --import tsx native/tests/generate-fixtures.ts
node --import tsx native/tests/generate-edit-fixtures.ts
```

The extension owns no background goroutines. Mutexes guard capture and mutation
state; reservations drain on completion, cancellation or lifecycle cleanup.
Rendering uses bounded saved data and the current theme, without transcript
history scans or IPC reads. The SDK owns transport/request lifetimes.

## Verification records

- [OpenCode parity](OPENCODE.md): Pi 1.4.0 / PiG 0.5.1, macOS/arm64, TS/source/
  fused CLI comparisons and actual PTYs for both supported parent names.
- [Historical parity](PARITY.md): earlier Linux/amd64 versions and queue stress
  probes; this retains its original scope.
- [Historical compatibility](COMPATIBILITY.md): earlier stable releases and their
  input-rewrite limitations.

These records do not certify Windows filesystem equivalence, arbitrary extension
stacks or byte-identical Pi/PiG UIs. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for
licensing and source attribution. Pi is the reference implementation; Michael
Kinsy created PiG, originally developed at Hewlett Packard Enterprise.
