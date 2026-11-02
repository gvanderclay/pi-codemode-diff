import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

test("unsupported hosts receive an upgrade error before any tool or event registration", () => {
  let registrations = 0;
  const oldHost = {
    on() { registrations++; },
    registerTool() { registrations++; },
  } as unknown as ExtensionAPI;
  assert.throws(() => extension(oldHost), /requires Pi >=1\.5\.0.*registerToolRenderer.*Update Pi/);
  assert.equal(registrations, 0, "An unsupported host must not receive a partial write override");
});

test("manifest and lockfile explicitly declare the tested minimum host version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  for (const [name, minimum] of Object.entries({
    "@earendil-works/pi-coding-agent": ">=1.5.0",
    "@earendil-works/pi-tui": ">=1.0.1",
  })) {
    assert.equal(manifest.peerDependencies[name], minimum);
    assert.equal(lock.packages[""].peerDependencies[name], manifest.peerDependencies[name]);
  }
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    assert.equal(manifest.devDependencies[name], "^1.5.0");
    assert.equal(lock.packages[""].devDependencies[name], manifest.devDependencies[name]);
    assert.equal(lock.packages[`node_modules/${name}`].version, "1.5.0");
  }
});
