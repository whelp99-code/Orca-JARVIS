import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import type { ObservationEnvelopeV1, Sha256Digest } from "./personal-contracts.js";

export type PersistenceRow = Readonly<Record<string, unknown>>;
export type PersistenceErrorFactory = (code: string, message?: string) => Error;

type AuditEvent = {
  readonly event: string;
  readonly subject: string;
  readonly digest: string;
  readonly correlation: string;
  readonly causation: string | null;
  readonly occurredAt: string;
};

export function isPersistenceRow(value: unknown): value is PersistenceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function persistenceRow(value: unknown): PersistenceRow {
  if (!isPersistenceRow(value)) throw new TypeError("database row required");
  return value;
}

export function persistenceText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("database text required");
  return value;
}

export function persistenceNumber(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("database number required");
  return value;
}

export function isPersistenceTime(value: string): boolean {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && new Date(Date.parse(value)).toISOString() === value;
}

function isDigest(value: string): value is Sha256Digest {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

export function persistenceHash(value: unknown): Sha256Digest {
  const result = `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
  if (!isDigest(result)) throw new TypeError("canonical digest required");
  return result;
}

export function requireAdvisory(
  authority: ObservationEnvelopeV1["authority"],
  error: PersistenceErrorFactory,
  code: string,
): void {
  switch (authority.authority_kind) {
    case "none":
      return;
    case "control_receipt":
      throw error(code);
    default: {
      const exhaustive: never = authority;
      return exhaustive;
    }
  }
}

export function recordPersonalAudit(database: Database.Database, input: AuditEvent): void {
  database.prepare(
    "INSERT INTO personal_context_audit_events(event_type,subject_id,subject_digest,correlation_id,causation_id,occurred_at) VALUES(?,?,?,?,?,?)",
  ).run(input.event, input.subject, input.digest, input.correlation, input.causation, input.occurredAt);
}
