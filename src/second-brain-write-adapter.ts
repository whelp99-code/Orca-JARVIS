import type { AuthorityDb } from "./db.js";
import type {
  SecondBrainWriteOutcome,
  SecondBrainWriteRequestAdapter,
  SecondBrainWriteRequestV1,
} from "./second-brain-adapter-types.js";
import { memoryEffectValidationOptions } from "./second-brain-effect-authority.js";
import { parseMemoryEffectRequest } from "./memory-effect-write-request.js";
import { parseMemoryEffectAccepted, type MemoryEffectWriteRequestV2 } from "./second-brain-effect-v2.js";
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

  private dedicatedAuthority(request: MemoryEffectWriteRequestV2): boolean {
    const identity = [request.request_id, request.request_digest, request.envelope_digest,
      request.idempotency_key, request.delegation.delegation_id,
      request.delegation.delegation_digest, request.lane_id];
    switch (request.operation) {
      case "correct": return this.authority.db.prepare(
        `SELECT 1 FROM memory_correction_requests WHERE request_id=? AND request_digest=?
         AND envelope_digest=? AND idempotency_key=? AND delegation_id=? AND delegation_digest=?
         AND lane_id=? AND state='dispatching' AND dispatch_fence=1`,
      ).get(...identity) !== undefined;
      case "forget": return this.authority.db.prepare(
        `SELECT 1 FROM memory_deletion_requests WHERE request_id=? AND request_digest=?
         AND envelope_digest=? AND provider_idempotency_key=? AND delegation_id=? AND delegation_digest=?
         AND lane_id=? AND state='applying' AND dispatch_fence=1`,
      ).get(...identity) !== undefined;
      case "export": return this.authority.db.prepare(
        `SELECT 1 FROM memory_export_requests WHERE request_id=? AND request_digest=?
         AND envelope_digest=? AND provider_idempotency_key=? AND delegation_id=? AND delegation_digest=?
         AND lane_id=? AND state='writing' AND dispatch_fence=1`,
      ).get(...identity) !== undefined;
      default: { const exhaustive: never = request.operation; return exhaustive; }
    }
  }

  private async writeV2(request: MemoryEffectWriteRequestV2): Promise<SecondBrainWriteOutcome> {
    if (!this.dedicatedAuthority(request)) {
      return { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" };
    }
    try {
      const outcome = await this.transport.call("sb_write_request", { request });
      switch (outcome.kind) {
        case "data": {
          const result = parseMemoryEffectAccepted(outcome.value);
          if (result === undefined || result.request_id !== request.request_id
            || result.request_digest !== request.request_digest
            || result.envelope_digest !== request.envelope_digest
            || result.idempotency_key !== request.idempotency_key
            || result.operation !== request.operation || result.lane !== request.lane) {
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

  async write(value: unknown): Promise<SecondBrainWriteOutcome> {
    const now = this.clock();
    const v1 = parseSecondBrainWriteRequest(value, now);
    if (v1 !== undefined) {
      if (!hasSecondBrainWriteAuthority(this.authority, v1, now)) {
        return { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" };
      }
      return this.writeV1(v1);
    }
    const v2 = parseMemoryEffectRequest(value, memoryEffectValidationOptions(this.authority, now));
    if (v2 === undefined) return { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" };
    return this.writeV2(v2);
  }
}

export function createSecondBrainWriteRequestAdapter(
  transport: SecondBrainTransport,
  authority: AuthorityDb,
  clock: () => Date,
): SecondBrainWriteRequestAdapter {
  return new BoundedSecondBrainWriteRequestAdapter(transport, authority, clock);
}
