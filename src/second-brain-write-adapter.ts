import type { AuthorityDb } from "./db.js";
import type {
  SecondBrainWriteOutcome,
  SecondBrainWriteRequestAdapter,
} from "./second-brain-adapter-types.js";
import type { SecondBrainTransport } from "./second-brain-transport.js";
import { SecondBrainTransportError } from "./second-brain-transport.js";
import { hasSecondBrainWriteAuthority } from "./second-brain-write-authority.js";
import { parseSecondBrainWriteRequest } from "./second-brain-write-request.js";
import { parseSecondBrainWriteResult } from "./second-brain-write-result.js";

class BoundedSecondBrainWriteRequestAdapter implements SecondBrainWriteRequestAdapter {
  constructor(
    private readonly transport: SecondBrainTransport,
    private readonly authority: AuthorityDb,
    private readonly clock: () => Date,
  ) {}

  async write(value: unknown): Promise<SecondBrainWriteOutcome> {
    const now = this.clock();
    const request = parseSecondBrainWriteRequest(value, now);
    if (request === undefined || !hasSecondBrainWriteAuthority(this.authority, request, now)) {
      return { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" };
    }
    try {
      const outcome = await this.transport.call("sb_write_request", { request });
      switch (outcome.kind) {
        case "data": {
          const result = parseSecondBrainWriteResult(outcome.value);
          if (result?.kind !== "accepted" || result.candidate_id !== request.candidate_id
            || result.request_id !== request.request_id || result.request_digest !== request.request_digest
            || result.idempotency_key !== request.idempotency_key || result.operation !== request.operation) {
            return { kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" };
          }
          return result;
        }
        case "error":
          return { kind: "unavailable", code: outcome.code };
        case "no_data":
          return { kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" };
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    } catch (error) {
      if (!(error instanceof SecondBrainTransportError)) throw error;
      return error.disposition === "uncertain"
        ? { kind: "uncertain", code: error.code }
        : { kind: "unavailable", code: error.code };
    }
  }
}

export function createSecondBrainWriteRequestAdapter(
  transport: SecondBrainTransport,
  authority: AuthorityDb,
  clock: () => Date,
): SecondBrainWriteRequestAdapter {
  return new BoundedSecondBrainWriteRequestAdapter(transport, authority, clock);
}
