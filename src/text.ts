/** File contents/path names must not inject terminal escape sequences. */
export function safeText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�").replace(/\t/g, "   ");
}

export function inlineText(text: string): string {
  return safeText(text).replace(/\n/g, "\\n");
}

/**
 * Display-only normalization: strip one leading UTF-8 BOM, then convert CRLF
 * and lone CR line endings to LF. Never applied to written bytes.
 */
export function displayText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
