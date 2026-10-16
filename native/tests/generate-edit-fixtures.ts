// Independent edit executor oracle: node --import tsx native/tests/generate-edit-fixtures.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditToolDefinition, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const cases = [
  { name: "exact", before: "before\n", edits: [{ oldText: "before", newText: "after" }] },
  { name: "bom_crlf", before: "\ufeffone\r\ntwo\r\n", edits: [{ oldText: "two\n", newText: "second\nthird\n" }] },
  { name: "disjoint", before: "first\nmiddle\nlast\n", edits: [{ oldText: "last", newText: "end" }, { oldText: "first", newText: "start" }] },
  { name: "unicode", before: "이전 😀\n", edits: [{ oldText: "이전 😀", newText: "이후 🚀" }] },
  { name: "fuzzy", before: "const x = ‘old’;  \n", edits: [{ oldText: "const x = 'old';", newText: "const x = 'new';" }] },
  { name: "nfkc", before: "Ａ = １\n", edits: [{ oldText: "A = 1", newText: "A = 2" }] },
  { name: "invalid_utf8", hex: "61ff62e282", edits: [{ oldText: "a�b�", newText: "valid" }] },
  { name: "no_match", before: "before\n", edits: [{ oldText: "missing", newText: "after" }] },
  { name: "ambiguous", before: "same same\n", edits: [{ oldText: "same", newText: "new" }] },
  { name: "overlap", before: "abcdef\n", edits: [{ oldText: "abc", newText: "A" }, { oldText: "bcd", newText: "B" }] },
  { name: "unchanged", before: "before\n", edits: [{ oldText: "before", newText: "before" }] },
  { name: "empty_old", before: "before\n", edits: [{ oldText: "", newText: "new" }] },
  { name: "deletion", before: "before\n", edits: [{ oldText: "before\n", newText: "" }] },
  { name: "missing", edits: [{ oldText: "before", newText: "after" }] },
  { name: "empty_edits", before: "before\n", edits: [] },
  { name: "object_adapter", before: "before\n", edits: { oldText: "before", newText: "after" } },
  { name: "json_adapter", before: "before\n", edits: '[{"oldText":"before","newText":"after"}]' },
  { name: "legacy_adapter", before: "before\n", oldText: "before", newText: "after" },
  { name: "distant_hunks", before: Array.from({length:40}, (_,i)=>`line-${i}`).join("\n"), edits: [{oldText:"line-0\n",newText:"start\n"},{oldText:"line-39",newText:"end"}] },
];
const cwd = await mkdtemp(join(tmpdir(), "pi-edit-oracle-"));
const oracle = [];
try {
  for (const item of cases) {
    const { name, before, hex, ...args } = item;
    const bytes = hex !== undefined ? Buffer.from(hex,"hex") : before !== undefined ? Buffer.from(before) : undefined;
    const path = join(cwd,"file.txt");
    await rm(path, {force:true});
    if (bytes !== undefined) await writeFile(path,bytes);
    const tool = createEditToolDefinition(cwd);
    const input = {path:"file.txt", ...args};
    const prepared = await tool.prepareArguments!(input);
    let expected, error;
    try {
      const result = await tool.execute("oracle", prepared as never, undefined, undefined, {cwd} as ExtensionToolContext);
      expected = {content: result.content.filter(b=>b.type==="text").map(b=>b.text).join("\n"),details:result.details};
    } catch (e) { error = (e as Error).message; }
    const after = await readFile(path).catch(()=>undefined);
    oracle.push({name,before:bytes?.toString("hex"),input,prepared,after:after?.toString("hex"),expected,error});
  }
  await writeFile(new URL("../pig/testdata/edits.json",import.meta.url),JSON.stringify(oracle,null,2)+"\n");
} finally { await rm(cwd,{recursive:true,force:true}); }
