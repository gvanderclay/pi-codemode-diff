import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readChanges } from "../src/changes.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

const exec = promisify(execFile);

/** Every local Markdown link must resolve inside the independently packed artifact. */
async function checkDocumentation(root: string, files: string[]): Promise<void> {
  for (const file of files.filter(path => path.endsWith(".md"))) {
    const content = await readFile(join(root, file), "utf8");
    for (const match of content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(target.split("#")[0])));
      assert.ok(!posix.isAbsolute(target) && !resolved.startsWith("../") &&
        (files.includes(resolved) || files.some(path => path.startsWith(resolved + "/"))),
      `${file}: link ${target} must resolve within the package or use an external URL`);
    }
  }
}

test("the native PiG package declares only the Go factory and stays separate from the TypeScript package", async () => {
  const nativeRoot = new URL("../native/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("package.json", nativeRoot), "utf8"));
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "pi-codemode-diff-native");
  assert.equal(manifest.version, `${root.version}-pig`);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.repository.directory, "native");
  assert.match(manifest.homepage, /\/native#readme$/);
  assert.ok(manifest.keywords?.includes("pig-package"), "PiG lists native packages by the pig-package keyword");
  assert.deepEqual(manifest.pi, { extensions: ["pig"] });
  assert.equal(manifest.dependencies, undefined, "The native wrapper must not require Node runtime dependencies");
  for (const path of ["go.mod", "extension.go"]) {
    assert.ok((await readFile(new URL(`pig/${path}`, nativeRoot), "utf8")).length > 0,
      `The declared Go factory must contain ${path}`);
  }
  assert.deepEqual(root.pi.extensions, ["./src/index.ts"]);
});

test("the packed native package has independent documentation and omits Go tests", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") {
    t.skip("This packaging smoke test uses the POSIX tar executable");
    return;
  }
  const nativeRoot = fileURLToPath(new URL("../native/", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "pi-codemode-diff-native-pack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = ["pack", "--json", "--ignore-scripts", "--pack-destination", directory];
  const npmCli = process.env.npm_execpath;
  const { stdout } = npmCli
    ? await exec(process.execPath, [npmCli, ...args], { cwd: nativeRoot })
    : await exec("npm", args, { cwd: nativeRoot });
  const [artifact] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const files = artifact.files.map(file => file.path);
  for (const required of [
    "package.json", "README.md", "CHANGELOG.md", "LICENSE", "piglet.yaml",
    "pig/extension.go", "pig/tools.go", "pig/go.mod", "pig/go.sum", "pig/LICENSE", "pig/NOTICE",
    "pig/fs_access_unix.go", "pig/fs_access_windows.go",
  ]) {
    assert.ok(files.includes(required), `${required} must be distributed`);
  }
  assert.ok(files.every(path => !/^(node_modules|src|tests|validation)\//.test(path) && !path.includes(".DS_Store")));
  const omitted = files.filter(path => path.endsWith("_test.go") || path.startsWith("pig/testdata/"));
  assert.deepEqual(omitted, [], "tests and fixtures must stay out of the tarball");
  await exec("tar", ["-xzf", join(directory, artifact.filename), "-C", directory]);
  await checkDocumentation(join(directory, "package"), files);
  const readme = await readFile(join(directory, "package/README.md"), "utf8");
  assert.match(readme, /pig install npm:pi-codemode-diff-native@/);
});

test("the packed npm artifact contains only distributable files and loads through real Pi", { timeout: 30_000 }, async t => {
  if (process.platform === "win32") {
    t.skip("This packaging smoke test uses the POSIX tar executable");
    return;
  }
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "pi-codemode-diff-pack-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = ["pack", "--json", "--ignore-scripts", "--pack-destination", directory];
  const npmCli = process.env.npm_execpath;
  const { stdout } = npmCli
    ? await exec(process.execPath, [npmCli, ...args], { cwd: repo })
    : await exec("npm", args, { cwd: repo });
  const [artifact] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const files = artifact.files.map(file => file.path);
  for (const required of [
    "package.json", "README.md", "CHANGELOG.md", "LICENSE",
    "src/index.ts", "src/capture.ts", "src/changes.ts", "src/write.ts", "src/render.ts",
    "src/host.ts", "src/pig.ts", "src/pig-index.ts", "src/diff.ts", "src/limits.ts", "src/tools.ts",
  ]) {
    assert.ok(files.includes(required), `${required} must be distributed`);
  }
  assert.ok(files.every(path => !/^(node_modules|test|coverage|native)\//.test(path) && !path.includes(".DS_Store")));
  await exec("tar", ["-xzf", join(directory, artifact.filename), "-C", directory]);
  await checkDocumentation(join(directory, "package"), files);
  const personalHome = /\/(?:Users|home)\/[^/\s]+\/|[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+[\\/]+/i;
  for (const path of files) {
    const content = await readFile(join(directory, "package", path), "utf8");
    assert.doesNotMatch(content, personalHome, `${path} must not contain a machine-specific home directory`);
  }
  // Provision the declared runtime dependency, as Pi does for npm/git installs,
  // without network access or installing duplicate host-provided modules.
  const manifest = JSON.parse(await readFile(join(directory, "package/package.json"), "utf8"));
  assert.ok(manifest.dependencies.diff);
  assert.equal(manifest.dependencies["pi-opencode-mode"], undefined);
  assert.equal(manifest.devDependencies["pi-opencode-mode"], "0.1.0");
  await mkdir(join(directory, "package/node_modules"));
  await cp(join(repo, "node_modules/diff"), join(directory, "package/node_modules/diff"), { recursive: true });
  const fixture = await runtimeFixture(t, { extensionPath: join(directory, "package/src/index.ts"), openCode: "after" });
  const result = await fixture.codemode('await tools.write({path: "packed.txt", content: "from the packed artifact"});');
  assert.equal(result.isError, false);
  assert.equal(readChanges(result.details)?.[0].path, "packed.txt");
  assert.equal(await readFile(join(fixture.cwd, "packed.txt"), "utf8"), "from the packed artifact");
  const openCode = await fixture.codemode('return await tools.write({path: "packed-o.txt", content: "OpenCode packed"});', "open-code", undefined, "codemode_o");
  assert.equal(openCode.isError, false);
  assert.equal(readChanges(openCode.details)?.[0].path, "packed-o.txt");
  assert.equal(await readFile(join(fixture.cwd, "packed-o.txt"), "utf8"), "OpenCode packed");
  const explicit = await runtimeFixture(t, { extensionPath: join(directory, "package/src/pig-index.ts"), openCode: "before" });
  const completed = await explicit.codemode('return await tools.write({path: "entry.txt", content: "explicit packed"});', "explicit", undefined, "codemode_o");
  assert.equal(completed.isError, false);
  const entries = explicit.session.sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "pi-codemode-diff:pig");
  assert.equal(entries.length, 1);
  assert.deepEqual(readChanges((entries[0] as { data: unknown }).data), readChanges(completed.details));
});
