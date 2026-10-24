# Changelog — pi-codemode-diff-native

## 0.1.5-pig

- Support the exact `codemode_o` parent name in both Go source and fused factories, alongside native `codemode`.
- Keep capture isolation, queues, budgets and version-1 metadata; label completed entries with the actual parent name and restore legacy entries as `codemode`.
- Verify Pi/PiG execution parity and actual PTY expansion/reload/resume for both tool roots. The optional OpenCode runtime is not ported to Go and still requires Node.
- Publish a dedicated package-root README, license and changelog with package-root installation/fused-build commands and native-specific npm metadata.
- Keep Go tests, fixtures and repository-only validation scripts outside the runtime npm tarball; retain complete runtime source, module files and third-party notices.

Earlier releases are listed in the [GitHub releases](https://github.com/hyein-cbio/pi-codemode-diff/releases).
