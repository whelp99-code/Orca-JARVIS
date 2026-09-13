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

export type ModelTransportResult = { readonly accepted: true } | { readonly accepted: false; readonly reason: string };

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
    return { accepted: false, reason: "FILE_TRANSPORT_NOT_CONSUMER" };
  }
}

/** Host-configured consumer: stdin capture JSON, accepted only on exit 0. */
export class CommandModelTransport implements ModelTransport {
  constructor(readonly command: string, readonly args: readonly string[] = []) {}

  async send(capture: ModelTransportCapture): Promise<ModelTransportResult> {
    return await new Promise(resolve => {
      const child = spawn(this.command, [...this.args], { stdio: ["pipe", "pipe", "pipe"] });
      const err: Buffer[] = [];
      child.stderr.on("data", chunk => { err.push(Buffer.from(chunk)); });
      child.on("error", error => { resolve({ accepted: false, reason: error.message }); });
      child.on("close", code => {
        if (code === 0) {
          resolve({ accepted: true });
          return;
        }
        resolve({
          accepted: false,
          reason: `exit ${String(code)} ${Buffer.concat(err).toString("utf8").slice(0, 200)}`,
        });
      });
      child.stdin.end(JSON.stringify(capture));
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
