import type { ServerResponse } from "node:http";

export const SSE_FRAME_MAX_BYTES = 16_384;
export const SSE_BUFFER_MAX_BYTES = 131_072;
export const SSE_DRAIN_TIMEOUT_MS = 5_000;

/** Frames invalidate canonical reads. Coalesce blocked invalidations into one fresh snapshot. */
export function createBoundedSseSink(response: ServerResponse, snapshot: () => void, onClose: () => void) {
  let closed = false;
  let blocked = false;
  let dirty = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    response.off("drain", drain);
    response.off("close", close);
    onClose();
    if (!response.destroyed) response.destroy();
  }

  function drain(): void {
    if (closed) return;
    blocked = false;
    clearTimeout(deadline);
    deadline = undefined;
    if (!dirty) return;
    dirty = false;
    snapshot();
  }

  function write(frame: string): void {
    if (closed) return;
    if (response.destroyed || response.writableEnded) { close(); return; }
    if (blocked) {
      if (!frame.startsWith(":")) dirty = true;
      return;
    }
    const bytes = Buffer.byteLength(frame, "utf8");
    // Reserve framing bytes as well as payload; never grow the Node writable buffer past its cap.
    if (bytes > SSE_FRAME_MAX_BYTES || response.writableLength + bytes + 32 > SSE_BUFFER_MAX_BYTES) {
      close(); return;
    }
    try {
      if (response.write(frame)) return;
      blocked = true;
      deadline = setTimeout(close, SSE_DRAIN_TIMEOUT_MS);
      deadline.unref();
    } catch { close(); }
  }

  response.on("drain", drain);
  response.once("close", close);
  response.once("error", close);
  return { write, close };
}
