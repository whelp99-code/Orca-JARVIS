import { memoryRememberRecordTexts } from "./memory-remember-artifact.js";

/** Explicit plain-text-v1 body contract. Hash and persist the exact accepted bytes. */
export function parseMemoryPlainText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
    || Buffer.byteLength(value, "utf8") > 4_096) return undefined;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127
      || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  }
  try { memoryRememberRecordTexts(value); } catch { return undefined; }
  return value;
}
