# pi-codemode-diff-native

Native Go package for [pi-codemode-diff](https://github.com/hyein-cbio/pi-codemode-diff). On [PiG](https://github.com/MichaelKinsy/PiG), it shows diffs for `edit` and `write` calls made inside codemode, and it keeps that diff data out of model context.

This package is the PiG implementation. The TypeScript package [`pi-codemode-diff`](https://www.npmjs.com/package/pi-codemode-diff) is the Pi implementation. Load one implementation per session.

The factory is `Extension()` in the `pig` module. PiG runs that factory as a Go source subprocess, or fuses it into a Piglet Binary through `piglet.yaml`. The extension uses no Node.js at runtime.

## Install

This package targets PiG 0.4.1. The Go module language version is 1.26; source builds and Piglet Binary builds were validated with Go 1.27.2. `codemode` must already be an active tool.

```bash
pig install npm:pi-codemode-diff-native
```

Run `/reload` in an existing PiG session after installation.

`package.json` declares the extension path `pig`. Install this package directory. PiG 0.4.1 rejects `pig install` of the `pig` module directory alone, because that directory is an extension rather than a package. From a checkout of the repository, a one-session load is:

```bash
pig -e "$PWD/native/pig" --tools read,bash,edit,write,codemode
```

A local persistent install from the repository root is `pig install "$PWD/native"`.

## What it does

- Captures successful nested `write` and `edit` results, including descendants of helper tools. A direct write produces no diff metadata.
- Isolates parallel parent calls and displays their changes in call-start order.
- Adds `details.piCodemodeDiff` to the parent result and appends a persisted `pi-codemode-diff:pig` custom entry when the parent completes.
- Leaves PiG's codemode card in place. The custom entry shows three changes and eight visual lines per diff while collapsed. Ctrl+O expands and collapses the entry.
- Runs `write` and `edit` on one shared per-file mutation queue, in both source and fused modes, so a queued write does not skip ahead of an edit of the same file.

Display budgets, the queue boundary, and the validation record are in the module guide: [native/pig/README.md](https://github.com/hyein-cbio/pi-codemode-diff/blob/main/native/pig/README.md).

## Fused Piglet Binary

`piglet.yaml` requires fused realization and selects the same Go factory. From the package root:

```bash
mkdir -p bin
pig piglet validate piglet.yaml
pig piglet build piglet.yaml --format binary --out bin/codemode-diff
bin/codemode-diff --tools read,bash,edit,write,codemode
```

After the binary is built, running it requires neither Go nor Node. Source mode still needs a Go toolchain on first build.

## Platforms

The published module includes `fs_access_unix.go` (`//go:build unix`) and `fs_access_windows.go` (`//go:build windows`). Validation currently targets Linux/amd64. Windows path conversion and complete platform filesystem error equivalence are outside that record. The native renderer follows the TypeScript display; it is a separate implementation of that view.

## Project

Source, the TypeScript implementation, and release notes live in the main repository: [github.com/hyein-cbio/pi-codemode-diff](https://github.com/hyein-cbio/pi-codemode-diff).

Report issues at [github.com/hyein-cbio/pi-codemode-diff/issues](https://github.com/hyein-cbio/pi-codemode-diff/issues).
