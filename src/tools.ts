/** Only these two orchestrators own file-diff batches; prefixes are not enough. */
export function isCodemodeTool(name: unknown): name is "codemode" | "codemode_o" {
  return name === "codemode" || name === "codemode_o";
}
