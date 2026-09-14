import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assembleModelRequest, type ModelRequestV1 } from "./context-assembler.js";

export type ModelTransportCapture = {
  readonly session_id: string;
  readonly request: ModelRequestV1;
  readonly json: string;
  readonly bytes: number;
  readonly no_data: boolean;
};

export const TRANSPORT_FAILURE_CLASSES = ["known_not_sent", "explicit_negative", "unknown"] as const;
export type TransportFailureClass = (typeof TRANSPORT_FAILURE_CLASSES)[number];
export type ModelTransportResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string; readonly failure_class: TransportFailureClass };

export interface ModelTransport {
  send(capture: ModelTransportCapture): Promise<ModelTransportResult>;
}

export class RecordingModelTransport implements ModelTransport {
  readonly sent: ModelTransportCapture[] = [];

  record(capture: ModelTransportCapture): ModelTransportResult {
    this.sent.push(capture);
    return { accepted: true };
  }

  async send(capture: ModelTransportCapture): Promise<ModelTransportResult> {
    return this.record(capture);
  }
}

/** Log-only. File append is not a session consumer. */
export class FileModelTransport implements ModelTransport {
  constructor(readonly path: string) {}

  async send(capture: ModelTransportCapture): Promise<ModelTransportResult> {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(capture)}\n`);
    return { accepted: false, reason: "FILE_TRANSPORT_NOT_CONSUMER", failure_class: "explicit_negative" };
  }
}

/** Host-configured consumer: stdin capture JSON, accepted only on exit 0. */
export class CommandModelTransport implements ModelTransport {
  constructor(readonly command: string, readonly args: readonly string[] = []) {}

  async send(capture: ModelTransportCapture): Promise<ModelTransportResult> {
    return await new Promise(resolve => {
      const child = spawn(this.command, [...this.args], { stdio: ["pipe", "pipe", "pipe"] });
      const err: Buffer[] = [];
      let settled = false;
      let wrote = false;
      const finish = (result: ModelTransportResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      child.stderr.on("data", chunk => { err.push(Buffer.from(chunk)); });
      child.on("error", error => {
        finish({
          accepted: false,
          reason: error.message,
          failure_class: wrote ? "unknown" : "known_not_sent",
        });
      });
      child.on("close", (code, signal) => {
        if (code === 0) {
          finish({ accepted: true });
          return;
        }
        const stderr = Buffer.concat(err).toString("utf8").slice(0, 200);
        if (signal !== null) {
          finish({ accepted: false, reason: `signal ${signal} ${stderr}`, failure_class: "unknown" });
          return;
        }
        if (!wrote) {
          finish({
            accepted: false,
            reason: `exit ${String(code)} ${stderr}`,
            failure_class: "known_not_sent",
          });
          return;
        }
        finish({
          accepted: false,
          reason: `exit ${String(code)} ${stderr}`,
          failure_class: "explicit_negative",
        });
      });
      child.stdin.on("error", error => {
        finish({
          accepted: false,
          reason: error instanceof Error ? error.message : String(error),
          failure_class: wrote ? "unknown" : "known_not_sent",
        });
      });
      child.stdin.end(JSON.stringify(capture), () => { wrote = true; });
    });
  }
}

export function prepareModelTransport(input: unknown, session_id: string): ModelTransportCapture {
  const request = assembleModelRequest(input);
  const json = JSON.stringify(request);
  const bytes = Buffer.byteLength(json, "utf8");
  return {
    session_id,
    request,
    json,
    bytes,
    no_data: request.memories.length === 0,
  };
}

export async function sendAssembledModelRequest(
  input: unknown,
  session_id: string,
  transport: ModelTransport,
): Promise<ModelTransportResult> {
  return transport.send(prepareModelTransport(input, session_id));
}
