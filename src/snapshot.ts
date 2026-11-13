import { open } from "node:fs/promises";
import type { BeforeWrite } from "./changes.ts";
import { MAX_TEXT_BYTES, writeTextFits } from "./limits.ts";

/** Classifies previous file bytes that were read in full (at most MAX_TEXT_BYTES). Pure: no I/O. */
export function classifyPrevious(bytes: Buffer): BeforeWrite {
  if (bytes.includes(0)) {
    return { kind: "unavailable", reason: "Previous content is binary; text diff unavailable." };
  }
  const content = bytes.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(bytes)) {
    return { kind: "unavailable", reason: "Previous content is not UTF-8; text diff unavailable." };
  }
  return writeTextFits(content) ? { kind: "text", content } : { kind: "omitted", sizeBytes: bytes.length };
}

export async function readPrevious(path: string, skipContent: boolean): Promise<BeforeWrite> {
  try {
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        return { kind: "unavailable", reason: "Previous content is not a regular file; text diff unavailable." };
      }
      if (skipContent || stat.size > MAX_TEXT_BYTES) {
        return { kind: "omitted", sizeBytes: stat.size };
      }
      // A stat check alone races with external writers. Read at most limit+1
      // bytes from the same descriptor, even if the file grows after stat().
      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_TEXT_BYTES) {
        return { kind: "omitted", sizeBytes: (await file.stat()).size };
      }
      return classifyPrevious(buffer.subarray(0, length));
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "unavailable", reason: "Previous content could not be read; text diff unavailable." };
  }
}
