import { createHash } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";
import {
  companyOperationTerminalStates, freshnessReadResponseSchema, reserveProgressResponseSchema, finishProgressResponseSchema,
  type CompanyCheckpoint, type CompanyFreshnessProvider, type CompanyScope,
  type FreshnessReadRequest, type FreshnessReadResponse, type ReserveProgressRequest, type ReserveProgressResponse,
  type FinishProgressRequest, type FinishProgressResponse,
} from "../../src/company-freshness.js";

type Reserved = { request: ReserveProgressRequest; checkpoint: CompanyCheckpoint; id: string;
  finish?: { request: FinishProgressRequest; checkpoint: CompanyCheckpoint } };
const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);

/** Consumer unit model only. No SB CLI, persistence, witness, TPM, or rollback-resistance claim. */
export class TestOnlyCompanyDbProtocol implements CompanyFreshnessProvider {
  readonly kind = "sb_company_db" as const;
  readonly publications: Array<{ phase: "reserve" | "finish"; operation: ReserveProgressRequest["operation"] }> = [];
  reads = 0;
  dropReserveOnce = false;
  dropFinishOnce = false;
  private current: CompanyCheckpoint;
  private readonly retained = new Set<string>();
  private readonly reservations = new Map<string, Reserved>();
  constructor(readonly scope: CompanyScope, checkpoint: CompanyCheckpoint) {
    this.current = structuredClone(checkpoint);
    this.retained.add(canonicalize(checkpoint));
  }
  get checkpoint(): CompanyCheckpoint { return structuredClone(this.current); }
  attest(checkpoint: CompanyCheckpoint): void {
    this.current = structuredClone(checkpoint);
    this.retained.add(canonicalize(checkpoint));
  }
  private root(value: unknown): string {
    return `sha256:${createHash("sha256").update("TEST_ONLY/company-db-consumer\0").update(canonicalize(value)).digest("hex")}`;
  }
  private advance(record: unknown): CompanyCheckpoint {
    const next = this.checkpoint;
    next.intent_sequence++;
    next.intent_root = this.root({ previous_root: next.intent_root, sequence: next.intent_sequence, record });
    return next;
  }
  readFreshness(request: FreshnessReadRequest): FreshnessReadResponse {
    this.reads++;
    const status = !same(request.scope, this.scope) || !this.retained.has(canonicalize(request.observed_checkpoint))
      ? "mismatch" : [...this.reservations.values()].some(row => !row.finish) ? "uncertain" : "ready";
    return freshnessReadResponseSchema.parse({ schema_version: 2, scope: request.scope, challenge: request.challenge, status,
      checkpoint: status === "ready" ? this.checkpoint : null });
  }
  reserveProgress(request: ReserveProgressRequest): ReserveProgressResponse {
    const old = this.reservations.get(request.operation_id);
    const matches = old && old.request.operation === request.operation && old.request.event_digest === request.event_digest
      && same(old.request.expected_checkpoint, request.expected_checkpoint);
    if (old) return reserveProgressResponseSchema.parse({ schema_version: 2, scope: request.scope, challenge: request.challenge,
      outcome: matches ? "already_reserved" : "conflict", reservation_id: matches ? old.id : null,
      checkpoint: matches ? structuredClone(old.checkpoint) : null });
    if (!same(request.scope, this.scope) || !same(request.expected_checkpoint, this.current)
      || [...this.reservations.values()].some(row => !row.finish)) return {
      schema_version: 2, scope: request.scope, challenge: request.challenge, outcome: "conflict", reservation_id: null, checkpoint: null,
    };
    const checkpoint = this.advance({ operation_id: request.operation_id, operation: request.operation, state: "reserved" });
    const row: Reserved = { request: structuredClone(request), checkpoint, id: `reservation:company-db:${request.operation_id.slice(7)}` };
    this.reservations.set(request.operation_id, row);
    this.attest(checkpoint);
    this.publications.push({ phase: "reserve", operation: request.operation });
    if (this.dropReserveOnce) { this.dropReserveOnce = false; throw new Error("TEST_ONLY_RESERVE_ACK_LOST"); }
    return { schema_version: 2, scope: request.scope, challenge: request.challenge,
      outcome: "reserved", reservation_id: row.id, checkpoint: structuredClone(checkpoint) };
  }
  finishProgress(request: FinishProgressRequest): FinishProgressResponse {
    const row = this.reservations.get(request.operation_id);
    const match = row && row.id === request.reservation_id
      && (companyOperationTerminalStates[row.request.operation] === request.terminal_state
        || (request.terminal_state === "cancelled" && ["decide_approve", "decide_reject"].includes(row.request.operation)));
    if (row?.finish) {
      const exact = match && row.finish.request.evidence_digest === request.evidence_digest
        && row.finish.request.terminal_state === request.terminal_state && same(row.finish.request.expected_checkpoint, request.expected_checkpoint);
      return finishProgressResponseSchema.parse({ schema_version: 2, scope: request.scope, challenge: request.challenge,
        outcome: exact ? "already_recorded" : "conflict", checkpoint: exact ? structuredClone(row.finish.checkpoint) : null });
    }
    if (!row || !match || !same(request.scope, this.scope) || !same(request.expected_checkpoint, this.current)) return {
      schema_version: 2, scope: request.scope, challenge: request.challenge, outcome: "conflict", checkpoint: null,
    };
    const checkpoint = this.advance({ operation_id: request.operation_id, evidence_digest: request.evidence_digest, state: "finished" });
    const store = ["accept", "reject", "mark_processed", "delete"].includes(row.request.operation) ? "second_brain" : "jarvis";
    const head = checkpoint.stores[store];
    head.receipt_sequence++;
    head.receipt_root = this.root({ previous_root: head.receipt_root, sequence: head.receipt_sequence, evidence: request.evidence_digest });
    if (request.terminal_state === "cancelled" || !["decide_approve", "accept"].includes(row.request.operation)) {
      head.terminal_sequence++;
      head.terminal_root = this.root({ previous_root: head.terminal_root, sequence: head.terminal_sequence, evidence: request.evidence_digest });
    }
    row.finish = { request: structuredClone(request), checkpoint };
    this.attest(checkpoint);
    this.publications.push({ phase: "finish", operation: row.request.operation });
    if (this.dropFinishOnce) { this.dropFinishOnce = false; throw new Error("TEST_ONLY_FINISH_ACK_LOST"); }
    return { schema_version: 2, scope: request.scope, challenge: request.challenge, outcome: "recorded", checkpoint: structuredClone(checkpoint) };
  }
}
