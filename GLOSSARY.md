# Glossary

Domain terms used in the code, tests and reviews of pi-codemode-diff.

**Codemode call** (root call): one call of Pi's `codemode` tool. It owns a batch of nested calls. Only the exact tool name `codemode` counts.

**Nested call**: an `edit` or `write` call a codemode script makes. Its `parentToolCallId` chain leads to a codemode call.

**Batch**: everything recorded for one codemode call: its nested calls in start order, their Changes and Proposals, and their display budgets.

**Change**: a completed file mutation by a nested call, with a display diff or a note. Changes are persisted in the codemode result's `details` under `piCodemodeDiff` (schema version 1), and are read back from details on resume.

**Proposal**: a pre-approval preview of a nested call, built from its arguments alone, without reading the file. A Proposal is live only: it is never persisted, never shown to the model, and is replaced by the call's Change when one is recorded. Status `pending` while the call waits or runs. Status `unverified` when the call ended with an error, because an error does not prove the file is unchanged.

**Display budget**: byte and line limits on what is displayed. Over a limit, text is omitted or cut and a notice says so. Budgets never restrict file mutations or model-facing results.

**Display text**: text prepared for a terminal or the proposals event. Control characters are replaced, tabs expanded and line endings normalized. Inline display text also escapes newlines.

**Proposals event**: the `codemode-diff:proposals` event-bus message. It holds a full snapshot of the session's current Proposals and is a version-1 contract for other extensions.
