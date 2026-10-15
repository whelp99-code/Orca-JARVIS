import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import {
  companyCheckpointSchema,
  companyOperationTerminalStates,
  finishProgressRequestSchema,
  finishProgressResponseSchema,
  freshnessReadRequestSchema,
  freshnessReadResponseSchema,
  reserveProgressRequestSchema,
  reserveProgressResponseSchema,
  type CompanyCheckpoint,
  type CompanyFreshnessProvider,
  type CompanyProgressOperation,
  type CompanyScope,
  type CompanyTerminalState,
  type FinishProgressRequest,
  type FinishProgressResponse,
  type FreshnessReadRequest,
  type FreshnessReadResponse,
  type ReserveProgressRequest,
  type ReserveProgressResponse,
} from "../../src/company-freshness.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { z } from "zod";

const PROGRESS_DOMAIN = "second-brain/TEST_ONLY-memory-progress/v1";
const factoryInputSchema = z.object({
  scope: z.object({
    provider_instance_id: z.string(),
    workspace_id: z.string(),
  }).strict(),
  initial_checkpoint: companyCheckpointSchema,
}).strict();

type Reservation = {
  operation_id: string;
  operation: CompanyProgressOperation;
  event_digest: string;
  reservation_id: string;
  expected_checkpoint: CompanyCheckpoint;
  reserved_checkpoint: CompanyCheckpoint;
  state: "reserved" | "finished";
  evidence_digest?: string;
  terminal_state?: CompanyTerminalState;
  finish_expected_checkpoint?: CompanyCheckpoint;
  finished_checkpoint?: CompanyCheckpoint;
};

let casProbe: (() => void) | undefined;

export function setTestOnlyMemoryCasProbe(probe: (() => void) | undefined): void {
  casProbe = probe;
}

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  return parsed.data;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function domainDigest(canonical: string): string {
  return `sha256:${createHash("sha256").update(`${PROGRESS_DOMAIN}\0`).update(canonical).digest("hex")}`;
}

function reservationIdFor(operationId: string): string {
  return `reservation:TEST_ONLY:${operationId.slice("sha256:".length)}`;
}

function advance(head: CompanyCheckpoint, record: Record<string, string>): CompanyCheckpoint {
  const sequence = head.intent_sequence + 1;
  if (!Number.isSafeInteger(sequence)) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  const next = structuredClone(head);
  next.intent_sequence = sequence;
  next.intent_root = domainDigest(canonicalize({
    previous_root: head.intent_root,
    sequence,
    record,
  }));
  return parseContract(companyCheckpointSchema, next);
}

class TestOnlyMemoryProvider implements CompanyFreshnessProvider {
  private head: CompanyCheckpoint;
  private generation = 0;
  private readonly reservations = new Map<string, Reservation>();

  constructor(
    private readonly scope: CompanyScope,
    initial: CompanyCheckpoint,
  ) {
    this.head = structuredClone(initial);
  }

  readFreshness(request: FreshnessReadRequest): FreshnessReadResponse {
    const parsed = parseContract(freshnessReadRequestSchema, request);
    this.requireScope(parsed.scope);
    const unfinished = [...this.reservations.values()].some(item => item.state === "reserved");
    const status = unfinished
      ? "uncertain"
      : sameValue(parsed.observed_checkpoint, this.head) ? "ready" : "mismatch";
    return parseContract(freshnessReadResponseSchema, {
      schema_version: 2,
      scope: parsed.scope,
      challenge: parsed.challenge,
      status,
      checkpoint: status === "ready" ? structuredClone(this.head) : null,
    });
  }

  reserveProgress(request: ReserveProgressRequest): ReserveProgressResponse {
    const parsed = parseContract(reserveProgressRequestSchema, request);
    this.requireScope(parsed.scope);
    const existing = this.reservations.get(parsed.operation_id);
    if (existing) {
      const same = existing.operation === parsed.operation
        && existing.event_digest === parsed.event_digest
        && sameValue(existing.expected_checkpoint, parsed.expected_checkpoint);
      return this.reserveReply(parsed, same ? "already_reserved" : "conflict", existing);
    }
    if (!sameValue(parsed.expected_checkpoint, this.head)) {
      return this.reserveReply(parsed, "conflict");
    }
    const committed = this.cas(() => sameValue(parsed.expected_checkpoint, this.head), () => {
      const reservationId = reservationIdFor(parsed.operation_id);
      const record = {
        operation_id: parsed.operation_id,
        operation: parsed.operation,
        event_digest: parsed.event_digest,
        reservation_id: reservationId,
        state: "reserved",
      };
      const checkpoint = advance(this.head, record);
      const reservation: Reservation = {
        operation_id: parsed.operation_id,
        operation: parsed.operation,
        event_digest: parsed.event_digest,
        reservation_id: reservationId,
        expected_checkpoint: structuredClone(parsed.expected_checkpoint),
        reserved_checkpoint: checkpoint,
        state: "reserved",
      };
      this.head = checkpoint;
      this.reservations.set(parsed.operation_id, reservation);
      return reservation;
    });
    return this.reserveReply(parsed, committed ? "reserved" : "conflict", committed ?? undefined);
  }

  finishProgress(request: FinishProgressRequest): FinishProgressResponse {
    const parsed = parseContract(finishProgressRequestSchema, request);
    this.requireScope(parsed.scope);
    const existing = this.reservations.get(parsed.operation_id);
    if (!existing || existing.reservation_id !== parsed.reservation_id) {
      return this.finishReply(parsed, "conflict");
    }
    if (existing.state === "finished") {
      const same = existing.evidence_digest === parsed.evidence_digest
        && existing.terminal_state === parsed.terminal_state
        && existing.finish_expected_checkpoint !== undefined
        && sameValue(existing.finish_expected_checkpoint, parsed.expected_checkpoint);
      return this.finishReply(parsed, same ? "already_recorded" : "conflict", existing);
    }
    if (companyOperationTerminalStates[existing.operation] !== parsed.terminal_state) {
      return this.finishReply(parsed, "conflict");
    }
    if (!sameValue(parsed.expected_checkpoint, this.head)) {
      return this.finishReply(parsed, "conflict");
    }
    const committed = this.cas(() => sameValue(parsed.expected_checkpoint, this.head), () => {
      const record = {
        operation_id: parsed.operation_id,
        reservation_id: existing.reservation_id,
        evidence_digest: parsed.evidence_digest,
        terminal_state: parsed.terminal_state,
        state: "finished",
      };
      const checkpoint = advance(this.head, record);
      existing.state = "finished";
      existing.evidence_digest = parsed.evidence_digest;
      existing.terminal_state = parsed.terminal_state;
      existing.finish_expected_checkpoint = structuredClone(parsed.expected_checkpoint);
      existing.finished_checkpoint = checkpoint;
      this.head = checkpoint;
      return existing;
    });
    return this.finishReply(parsed, committed ? "recorded" : "conflict", committed ?? undefined);
  }

  private requireScope(scope: CompanyScope): void {
    if (!sameValue(scope, this.scope)) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  }

  private cas<T>(ready: () => boolean, apply: () => T): T | undefined {
    const generation = this.generation;
    if (!ready()) return undefined;
    const probe = casProbe;
    casProbe = undefined;
    probe?.();
    if (this.generation !== generation || !ready()) return undefined;
    const value = apply();
    this.generation += 1;
    return value;
  }

  private reserveReply(
    request: ReserveProgressRequest,
    outcome: "reserved" | "already_reserved" | "conflict",
    reservation?: Reservation,
  ): ReserveProgressResponse {
    if (outcome === "conflict" || !reservation) {
      return parseContract(reserveProgressResponseSchema, {
        schema_version: 2,
        scope: request.scope,
        challenge: request.challenge,
        outcome: "conflict",
        checkpoint: null,
        reservation_id: null,
      });
    }
    return parseContract(reserveProgressResponseSchema, {
      schema_version: 2,
      scope: request.scope,
      challenge: request.challenge,
      outcome,
      checkpoint: structuredClone(reservation.reserved_checkpoint),
      reservation_id: reservation.reservation_id,
    });
  }

  private finishReply(
    request: FinishProgressRequest,
    outcome: "recorded" | "already_recorded" | "conflict",
    reservation?: Reservation,
  ): FinishProgressResponse {
    if (outcome === "conflict" || !reservation?.finished_checkpoint) {
      return parseContract(finishProgressResponseSchema, {
        schema_version: 2,
        scope: request.scope,
        challenge: request.challenge,
        outcome: "conflict",
        checkpoint: null,
      });
    }
    return parseContract(finishProgressResponseSchema, {
      schema_version: 2,
      scope: request.scope,
      challenge: request.challenge,
      outcome,
      checkpoint: structuredClone(reservation.finished_checkpoint),
    });
  }
}

export function createTestOnlyMemoryProvider(input: {
  scope: CompanyScope;
  initial_checkpoint: CompanyCheckpoint;
}): CompanyFreshnessProvider {
  const parsed = parseContract(factoryInputSchema, input);
  const scopeProbe = freshnessReadRequestSchema.safeParse({
    schema_version: 2,
    scope: parsed.scope,
    installation_id: "installation:TEST_ONLY",
    challenge: "challenge:TEST_ONLY",
    observed_checkpoint: parsed.initial_checkpoint,
  });
  if (!scopeProbe.success) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  return new TestOnlyMemoryProvider(scopeProbe.data.scope, structuredClone(parsed.initial_checkpoint));
}
