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
