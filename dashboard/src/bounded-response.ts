export class ResponseBodyTooLargeError extends Error {
  readonly name = "ResponseBodyTooLargeError";
  constructor() { super("RESPONSE_BODY_TOO_LARGE"); }
}

/** Bound retained body bytes while reading, then preserve Response.text() UTF-8/BOM semantics. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid response byte limit");
  if (response.body === null) return JSON.parse("");
  const reader = response.body.getReader();
  // Response.text() removes an optional UTF-8 BOM. It is the only wire-byte allowance.
  const buffer = new Uint8Array(maxBytes + 3);
  let size = 0;
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      const nextSize = size + value.byteLength;
      if (size < 3) buffer.set(value.subarray(0, Math.min(3 - size, value.byteLength)), size);
      const prefixSize = Math.min(nextSize, 3);
      const bomPrefix = (prefixSize < 1 || buffer[0] === 0xef)
        && (prefixSize < 2 || buffer[1] === 0xbb) && (prefixSize < 3 || buffer[2] === 0xbf);
      if (nextSize > maxBytes + (bomPrefix ? 3 : 0)) throw new ResponseBodyTooLargeError();
      buffer.set(value, size);
      size = nextSize;
    }
    const raw = new TextDecoder().decode(buffer.subarray(0, size));
    // Invalid UTF-8 is replaced by Response.text(); replacement bytes must also fit the original budget.
    if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new ResponseBodyTooLargeError();
    return JSON.parse(raw);
  } finally {
    // Cancellation may fail or remain pending in an injected stream. Never mask the budget error or wait for EOF.
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
