import type { SecondBrainWriteOutcome, SecondBrainWriteRequestAdapter } from "./second-brain-adapter-types.js";
import type { SecondBrainTransport } from "./second-brain-transport.js";
import { SecondBrainTransportError } from "./second-brain-transport.js";
import { parseSecondBrainWriteRequest, parseSecondBrainWriteResult } from "./second-brain-write-request.js";

class BoundedSecondBrainWriteRequestAdapter implements SecondBrainWriteRequestAdapter {
  constructor(private readonly transport: SecondBrainTransport) {}

  async write(value: unknown): Promise<SecondBrainWriteOutcome> {
    const request = parseSecondBrainWriteRequest(value);
    if (request === undefined) return { kind: "invalid", code: "SECOND_BRAIN_WRITE_REQUEST_INVALID" };
    try {
      const outcome = await this.transport.call("sb_write_request", { request });
      switch (outcome.kind) {
        case "data": return parseSecondBrainWriteResult(outcome.value)
          ?? { kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" };
        case "error": return { kind: "unavailable", code: outcome.code };
        case "no_data": return { kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" };
        default: { const exhaustive: never = outcome; return exhaustive; }
      }
    } catch (error) {
      if (!(error instanceof SecondBrainTransportError)) throw error;
      return error.disposition === "uncertain"
        ? { kind: "uncertain", code: error.code }
        : { kind: "unavailable", code: error.code };
    }
  }
}

export function createSecondBrainWriteRequestAdapter(transport: SecondBrainTransport): SecondBrainWriteRequestAdapter {
  return new BoundedSecondBrainWriteRequestAdapter(transport);
}
