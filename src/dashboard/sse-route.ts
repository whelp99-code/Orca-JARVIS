import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReconcileHub } from "./events.js";

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

  const sink = {
    write(frame: string): void {
      if (!response.writableEnded && !response.destroyed) response.write(frame);
    },
    close(): void {
      if (!response.writableEnded && !response.destroyed) response.end();
    },
  };

  const unsubscribe = hub.connect(sink, lastEventId(request));
  const heartbeat = setInterval(() => {
    sink.write(":\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let open = true;
  const cleanup = (): void => {
    if (!open) return;
    open = false;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.on("close", cleanup);
  response.on("close", cleanup);
}

function lastEventId(request: IncomingMessage): string | undefined {
  const value = request.headers["last-event-id"];
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 256) return value;
  return value === undefined ? undefined : "invalid";
}
