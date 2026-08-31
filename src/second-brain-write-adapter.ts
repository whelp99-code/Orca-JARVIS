import type { AuthorityDb } from "./db.js";
import type {
  SecondBrainWriteOutcome,
  SecondBrainWriteRequestAdapter,
  SecondBrainWriteRequestV1,
} from "./second-brain-adapter-types.js";
import { JarvisError } from "./db.js";
import { hasMemoryEffectWriteAuthority, memoryEffectValidationOptions, prepareMemoryEffectDispatch,
  recordMemoryEffectAccepted, recordMemoryEffectDispatchFailure } from "./second-brain-effect-authority.js";
import { parseMemoryEffectAccepted, parseMemoryEffectWriteRequest,
  type MemoryEffectWriteRequestV2 } from "./second-brain-effect-v2.js";
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

  private async writeV1(request: SecondBrainWriteRequestV1): Promise<SecondBrainWriteOutcome> {
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

  private async writeV2(request: MemoryEffectWriteRequestV2, now: Date): Promise<SecondBrainWriteOutcome> {
    try {
      prepareMemoryEffectDispatch(this.authority, request, now);
    } catch (error) {
      return { kind: "invalid", code: error instanceof JarvisError ? error.code : "MEMORY_EFFECT_AUTHORITY_INVALID" };
    }
    try {
      const outcome = await this.transport.call("sb_write_request", { request });
      switch (outcome.kind) {
        case "data": {
          const result = parseMemoryEffectAccepted(outcome.value);
          if (result === undefined) {
            recordMemoryEffectDispatchFailure(this.authority, request.request_id, "failed",
              "SECOND_BRAIN_WRITE_RESULT_INVALID", this.clock());
            return { kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" };
          }
          try { recordMemoryEffectAccepted(this.authority, request, result, this.clock()); }
          catch (error) {
            return { kind: "invalid", code: error instanceof JarvisError ? error.code : "MEMORY_EFFECT_RESULT_INVALID" };
          }
          return result;
        }
        case "error":
          recordMemoryEffectDispatchFailure(this.authority, request.request_id, "failed", outcome.code, this.clock());
          return { kind: "unavailable", code: outcome.code };
        case "no_data":
          recordMemoryEffectDispatchFailure(this.authority, request.request_id, "failed",
            "SECOND_BRAIN_WRITE_RESULT_INVALID", this.clock());
          return { kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" };
        default: { const exhaustive: never = outcome; return exhaustive; }
      }
    } catch (error) {
      if (!(error instanceof SecondBrainTransportError)) throw error;
      recordMemoryEffectDispatchFailure(this.authority, request.request_id, "uncertain", error.code, this.clock());
      return error.disposition === "uncertain"
        ? { kind: "uncertain", code: error.code }
        : { kind: "unavailable", code: error.code };
    }
  }

  async write(value: unknown): Promise<SecondBrainWriteOutcome> {
    const now = this.clock();
    let v1: SecondBrainWriteRequestV1 | undefined;
    try { v1 = parseSecondBrainWriteRequest(value, now); } catch { v1 = undefined; }
    if (v1 !== undefined) {
      if (!hasSecondBrainWriteAuthority(this.authority, v1, now)) {
        return { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" };
      }
      return this.writeV1(v1);
    }
    const v2 = parseMemoryEffectWriteRequest(value, memoryEffectValidationOptions(this.authority, now));
    if (v2 === undefined || !hasMemoryEffectWriteAuthority(this.authority, v2, now)) {
      return { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" };
    }
    return this.writeV2(v2, now);
  }
}

export function createSecondBrainWriteRequestAdapter(
  transport: SecondBrainTransport,
  authority: AuthorityDb,
  clock: () => Date,
): SecondBrainWriteRequestAdapter {
  return new BoundedSecondBrainWriteRequestAdapter(transport, authority, clock);
}
