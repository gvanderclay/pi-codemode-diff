/** Only Pi's native codemode tool owns file-diff batches; prefixes are not enough. */
export function isCodemodeTool(name: unknown): name is "codemode" {
  return name === "codemode";
}
