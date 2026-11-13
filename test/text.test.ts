import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { displayText, inlineText, safeText } from "../src/text.ts";

test("safeText replaces terminal control characters, keeps newlines and expands tabs", () => {
  assert.equal(safeText("\u001b[2J"), "\uFFFD[2J");
  assert.equal(safeText("a\u0000b\u0007c\u001f"), "a\uFFFDb\uFFFDc\uFFFD");
  assert.equal(safeText("\u007f\u0085\u009b"), "\uFFFD\uFFFD\uFFFD");
  assert.equal(safeText("a\nb"), "a\nb");
  assert.equal(safeText("a\tb"), "a   b");
});

test("inlineText escapes newlines as two characters after sanitizing", () => {
  assert.equal(inlineText("a\nb"), "a\\nb");
  assert.equal(inlineText("a\u001b\nb"), "a\uFFFD\\nb");
  assert.equal(inlineText("a\tb"), "a   b");
});

test("displayText strips one leading BOM and normalizes CRLF and lone CR", () => {
  assert.equal(displayText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(displayText("\uFEFFx"), "x");
  assert.equal(displayText("\uFEFF\uFEFFx"), "\uFEFFx");
  assert.equal(displayText("a\uFEFFb"), "a\uFEFFb");
  assert.equal(displayText(""), "");
});

test("display-text helpers stay a leaf module and the proposals event avoids the terminal UI", async () => {
  const leaf = await readFile(new URL("../src/text.ts", import.meta.url), "utf8");
  const events = await readFile(new URL("../src/events.ts", import.meta.url), "utf8");
  for (const [name, source] of [["src/text.ts", leaf], ["src/events.ts", events]] as const) {
    assert.doesNotMatch(source, /from "\.\/render\.ts"/, name + " must not import render.ts");
    assert.doesNotMatch(source, /@earendil-works\/pi-tui/, name + " must not import the terminal UI");
  }
  assert.doesNotMatch(leaf, /from "\.\//, "src/text.ts must not import other src modules");
});
