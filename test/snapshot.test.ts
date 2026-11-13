import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { writeKind, type BeforeWrite } from "../src/changes.ts";
import { MAX_TEXT_BYTES, MAX_TEXT_LINES } from "../src/limits.ts";
import { classifyPrevious, readPrevious } from "../src/snapshot.ts";

async function tempDir(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-codemode-diff-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function unavailableReason(before: BeforeWrite): string {
  assert.equal(before.kind, "unavailable");
  return before.kind === "unavailable" ? before.reason : "";
}

function omittedSize(before: BeforeWrite): number {
  assert.equal(before.kind, "omitted");
  return before.kind === "omitted" ? before.sizeBytes : -1;
}

test("classifyPrevious separates text, binary, invalid UTF-8 and oversized content", () => {
  assert.deepEqual(classifyPrevious(Buffer.from("a\nb")), { kind: "text", content: "a\nb" });
  assert.deepEqual(classifyPrevious(Buffer.alloc(0)), { kind: "text", content: "" });
  assert.match(unavailableReason(classifyPrevious(Buffer.from("a\0b"))), /binary/);
  assert.match(unavailableReason(classifyPrevious(Buffer.from([0xff, 0xfe, 0x41]))), /not UTF-8/);
  const lines = Buffer.from("x\n".repeat(MAX_TEXT_LINES + 1));
  assert.deepEqual(classifyPrevious(lines), { kind: "omitted", sizeBytes: lines.length });
  // Normalization belongs to display text, not to the classifier.
  assert.deepEqual(classifyPrevious(Buffer.from("이전 😀\r\n")), { kind: "text", content: "이전 😀\r\n" });
});

test("writeKind maps every previous-content variant to a Change kind", () => {
  assert.equal(writeKind({ kind: "missing" }), "create");
  assert.equal(writeKind({ kind: "text", content: "old" }), "overwrite");
  assert.equal(writeKind({ kind: "omitted", sizeBytes: 0 }), "overwrite");
  assert.equal(writeKind({ kind: "unavailable", reason: "Unreadable" }), "unknown");
});

test("readPrevious reports missing paths and non-files without reading content", async t => {
  const directory = await tempDir(t);
  assert.deepEqual(await readPrevious(join(directory, "absent"), false), { kind: "missing" });
  await mkdir(join(directory, "folder"));
  assert.match(unavailableReason(await readPrevious(join(directory, "folder"), false)), /not a regular file/);
});

test("readPrevious reads small text, omits skipped content and oversized files", async t => {
  const directory = await tempDir(t);
  const text = join(directory, "text");
  await writeFile(text, "이전 😀\r\n");
  assert.deepEqual(await readPrevious(text, false), { kind: "text", content: "이전 😀\r\n" });
  assert.equal(omittedSize(await readPrevious(text, true)), Buffer.byteLength("이전 😀\r\n"));
  const large = join(directory, "large");
  await writeFile(large, Buffer.alloc(MAX_TEXT_BYTES + 1, 0x78));
  assert.equal(omittedSize(await readPrevious(large, false)), MAX_TEXT_BYTES + 1);
});
