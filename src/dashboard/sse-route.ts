import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReconcileHub } from "./events.js";
import { createBoundedSseSink } from "./sse-bounded-sink.js";

const EVENTS_PATH = "/api/v1/events";
const HEARTBEAT_MS = 15_000;

export type DashboardSseInput = {
  readonly path: string;
  readonly hub: ReconcileHub;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
};

export function tryHandleDashboardSse(input: DashboardSseInput): boolean {
  if (input.path !== EVENTS_PATH) return false;
  attachSseClient(input);
  return true;
}

function attachSseClient(input: DashboardSseInput): void {
  const { response, request, hub, requestId } = input;
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.setHeader("X-Request-Id", requestId);
  response.flushHeaders();

  let open = true;
  let unsubscribe = (): void => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = (): void => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    heartbeat = undefined;
    unsubscribe();
    request.off("close", requestClosed);
  };
  const sink = createBoundedSseSink(response, () => hub.resync(sink), cleanup);
  const requestClosed = (): void => { sink.close(); };
  request.once("close", requestClosed);
  try { unsubscribe = hub.connect(sink, lastEventId(request)); }
  catch (error) { sink.close(); throw error; }
  // connect writes the initial snapshot/replay synchronously and may already have closed the sink.
  if (!open) { unsubscribe(); return; }
  heartbeat = setInterval(() => { sink.write(":\n\n"); }, HEARTBEAT_MS);
  heartbeat.unref();
}

function lastEventId(request: IncomingMessage): string | undefined {
  const value = request.headers["last-event-id"];
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 256) return value;
  return value === undefined ? undefined : "invalid";
}
