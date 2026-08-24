import { decodeControlFrame, encodeControlFrame } from "./control-protocol-codec.js";
import { CONTROL_PROTOCOL_NAME, CONTROL_PROTOCOL_VERSION, type CommandIntent, type ControlFrame } from "./control-protocol.js";

export type ControlTransport = (frame: string) => string;

export class JarvisControlClient {
  constructor(private readonly transport: ControlTransport, private readonly generation = "gen-1") {}

  request(intent: CommandIntent, id = `req-${intent.ingressIdempotencyKey}`): ControlFrame {
    const frame: ControlFrame = {
      protocol: CONTROL_PROTOCOL_NAME,
      version: CONTROL_PROTOCOL_VERSION,
      id,
      traceId: `trace-${intent.ingressIdempotencyKey}`,
      generation: this.generation,
      sentAt: intent.requestedAt,
      type: "request",
      method: "command.request",
      payload: intent,
    };
    const decoded = decodeControlFrame(this.transport(encodeControlFrame(frame)), { pendingRequestIds: new Set([id]) });
    if (!decoded.ok) throw new Error(decoded.error.code);
    return decoded.frame;
  }
}
