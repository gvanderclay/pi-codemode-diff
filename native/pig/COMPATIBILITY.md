# Latest-release compatibility

Checked on **2026-10-16**, Linux/amd64. The extension works in the tested latest Pi and PiG releases, including Go source and fused modes. The strict Pi/PiG parity gate remains **red for two existing PiG release input-rewrite differences**; extension-on/off controls show no added regression.

## Versions actually checked

| Component | Latest stable version | Evidence |
| --- | --- | --- |
| Pi coding agent, Pi AI, Pi TUI | **1.3.0** | npm `latest`, installed CLI, release changelog dated 2026-10-15; [Pi tag](https://github.com/earendil-works/pi/releases/tag/v1.3.0) |
| PiG | **0.4.1+1.0.3** | Official Git tag and Go module `@latest`; installed release reports commit `3ee745c8cda3c1a9a8d71112c140790c4d64d78d`; [PiG tag](https://github.com/MichaelKinsy/PiG/releases/tag/v0.4.1) |
| PiG Go SDK | **0.4.1** | Official SDK tag and Go module `@latest`; matches this module's requirement |

PiG still pins Pi **1.0.3**, so the latest Pi and latest PiG do not target the same upstream revision. PiG main is `e63c61c338e2aaf0d130513db2c2e63fe2e7dafd`; it also prints `0.4.1+1.0.3` but includes fixes after the release tag. These binaries must be distinguished by source identity, not just their version text.

The stable-release fused binary was rebuilt with `PIG_SOURCE_ROOT` pointing to a clean checkout of the **release tag**, not main. Stock release and fused source therefore match. The stock release uses Go 1.27.1; the extension/source/fused builds use Go 1.27.2. Node is v24.19.0. Agent homes, provider configuration, sessions, and target files are isolated; all model responses come from a scripted local endpoint.

## Results

The real CLI comparison ran **25 scenarios twice across six paths: 300 invocations**. Paths are Pi control, Pi TypeScript, PiG control, PiG TypeScript, PiG Go source, and PiG fused.

- Enabling the extension preserves written bytes, parent success/error status, and model-facing tool content in **all 25 scenarios** on each host.
- PiG TypeScript, Go source, and fused agree on files, status, model-facing results, diff metadata, and completed custom entries in **all 25 scenarios**.
- Pi 1.3.0 and released PiG agree in **23 of 25 scenarios**. The two differences are the input-rewrite cases described below. Diff data never appears in the model-facing tool content.
- Sequential write/edit succeeds **20/20**, dependent parallel write/edit succeeds **20/20**, successful edits later overwritten occur **0/20**, and twelve queued writes followed by a dependent edit succeed **3/3**, on every path.
- Actual PTYs pass preview, expansion/collapse, `/reload`, a subsequent write, resume, and expansion after resume on all four extension paths.
- Go source and fused also pass resume/reload/TUI with Node absent. Fused execution passes with an empty PATH, without Node or Go.

The original PiG-only verifier passes its first sixteen scenarios, then fails its explicit rewritten-path assertion on the release. Its full-suite failure log is retained. The remaining runtime probes were invoked separately, and their summary explicitly records that the complete seventeen-scenario suite did not pass.

## Existing PiG release limitation

The `rewritten_path` and `edit_rewritten` probes install an additional extension that mutates `event.input.path` inside `tool_call`.

Pi applies the changed path. Released PiG 0.4.1 executes the original path. This happens **with this extension disabled as well as enabled**. All three PiG implementations preserve that host behavior; the resulting file and displayed path naturally differ from Pi's. Parent success/error and model-facing content still agree in these probes.

The unchanged strict `cross_host.py` gate therefore exits **1**, reporting `full_parity: false`. This result is not converted into a full pass or excluded from its recorded comparisons.

PiG main contains [65b7c13e](https://github.com/MichaelKinsy/PiG/commit/65b7c13e), which applies tool-call input edits. Both affected cases were run twice against Pi 1.3.0 and matching main-source stock/fused binaries: **24 targeted invocations pass**, with the accompanying queue probes passing three rounds per path. This targeted check does not claim a fresh full-suite run against main. The earlier full main-source/Pi 1.0.3 result remains in [PARITY.md](PARITY.md).

For normal local write/edit/diff use, the tested release is compatible with this extension. Integrations that depend on another extension rewriting tool inputs should use a PiG revision containing the host fix, or await a release containing it. This repository does not patch the host or simulate an input rewrite that the host ignored.

## Latest SDK checks and small test fix

An isolated copy installed Pi coding agent, Pi AI, and Pi TUI **1.3.0**, leaving this repository's development lockfile unchanged.

Runtime tests initially passed all 89 cases. Type checking exposed two test-only renderer contexts missing `durationMs` and `outputPad`, added by Pi 1.1. Both fixtures now supply these fields through a spread that also compiles with the older SDK.

After that change:

- Latest 1.3.0: type checking and **89/89 tests pass**, zero skips, including the actual released PiG Node loader fixture.
- Existing 1.0.2: type checking and **89/89 tests pass**, zero skips.
- Regenerating the TypeScript diff/rendering and edit executor oracles with 1.3.0 produces **byte-identical fixture files**. The native implementation's expected diff, write metadata, word rendering, persisted validation, and nineteen edit cases therefore remain valid against the latest SDK.
- Pi's `write`, `edit`, mutation queue, and edit-diff implementation files are also byte-identical between the installed 1.0.3 and 1.3.0 packages.

No production extension change or dependency upgrade was necessary for this latest-version check. Windows and arbitrary third-party extension stacks are outside this Linux validation.

## Evidence and reproduction

Compact records in [the validation directory](../validation/2026-10-16/):

- [Version discovery](../validation/2026-10-16/latest-discovery.json) and [compatibility assessment](../validation/2026-10-16/latest-assessment.json).
- [Strict stable-release comparison, including failures](../validation/2026-10-16/latest-stable.json), with executable SHA-256 hashes.
- [Latest-release TUI](../validation/2026-10-16/latest-stable-tui.json) and [Node-free runtime, with full-suite limitation](../validation/2026-10-16/latest-stable-no-node.json).
- [Targeted main-source input-rewrite checks](../validation/2026-10-16/latest-main-hooks.json).

Raw CLI events, provider requests, files, and PTY transcripts remain under `/workspace/scratch/pi-pig-latest-stable`, `/workspace/scratch/pi-pig-latest-stable-tui`, `/workspace/scratch/pi-pig-latest-release-no-node`, and `/workspace/scratch/pi-pig-latest-main-hooks`. Initial/final SDK logs are `/workspace/scratch/pi-sdk-1.3.0-typecheck.log`, `/workspace/scratch/pi-sdk-1.3.0-tests-final.log`, and `/workspace/scratch/pi-sdk-1.0.2-backcompat.log`.

Install Pi 1.3.0 separately. Build fused from PiG's release checkout as described in the module README, then run:

```bash
python3 native/tests/cross_host.py \
  --pi /path/to/pi-1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --pig /path/to/released/pig \
  --fused /path/to/release041/codemode-diff \
  --runs 2 --queue-rounds 20

python3 native/tests/cross_host_tui.py \
  --pi /path/to/pi-1.3.0/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --pig /path/to/released/pig \
  --fused /path/to/release041/codemode-diff
```

The first command is expected to return 1 for the released PiG's two host differences. Use a new empty `--output` directory to retain every run's evidence.
