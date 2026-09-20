import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../jarvis-error.js";
import type { ApprovalRef, CommandEnvelope, ExecutionResult, ExecutionStatus } from "./types.js";

export type OperationMapping = {
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly lease_fence: string;
  readonly approval_digest: string;
  readonly capability: string;
  readonly outcome: string;
};

const SIDE_EFFECT_OUTCOMES = new Set(["scheduled", "SUCCESS"]);

export function approvalDigest(ref: ApprovalRef | undefined): string {
  if (ref === undefined) return "sha256:" + createHash("sha256").update("none").digest("hex");
  return ref.digest;
}

export function envelopeApprovalDigest(envelope: CommandEnvelope): string {
  if (envelope.approval_ref !== undefined) return envelope.approval_ref.digest;
  return "sha256:" + createHash("sha256").update(canonicalize({
    operation_id: envelope.operation_id,
    capability: envelope.capability,
  })).digest("hex");
}

export class Core5OperationLedger {
  constructor(private readonly database: Database.Database) {}

  get(operationId: string): OperationMapping | undefined {
    const row = this.database.prepare(
      "SELECT operation_id, attempt_id, lease_fence, approval_digest, capability, outcome FROM core5_integration_operations WHERE operation_id=?",
    ).get(operationId) as OperationMapping | undefined;
    return row;
  }

  schedule(envelope: CommandEnvelope): OperationMapping {
    const digest = envelopeApprovalDigest(envelope);
    const existing = this.get(envelope.operation_id);
    if (existing !== undefined) {
      if (SIDE_EFFECT_OUTCOMES.has(existing.outcome) && existing.lease_fence !== envelope.lease_fence) {
        throw new JarvisError("CORE5_DUPLICATE_SIDE_EFFECT", envelope.operation_id);
      }
      if (existing.approval_digest === digest && existing.lease_fence === envelope.lease_fence) {
        return existing;
      }
      if (SIDE_EFFECT_OUTCOMES.has(existing.outcome) && existing.approval_digest === digest) {
        throw new JarvisError("CORE5_DUPLICATE_SIDE_EFFECT", envelope.operation_id);
      }
      this.database.prepare(
        `UPDATE core5_integration_operations
         SET attempt_id=?, lease_fence=?, approval_digest=?, capability=?, outcome='scheduled'
         WHERE operation_id=?`,
      ).run(
        envelope.attempt_id,
        envelope.lease_fence,
        digest,
        envelope.capability,
        envelope.operation_id,
      );
      const updated = this.get(envelope.operation_id);
      if (updated === undefined) throw new JarvisError("CORE5_LEDGER_MISSING", envelope.operation_id);
      return updated;
    }
    this.database.prepare(
      `INSERT INTO core5_integration_operations(operation_id,attempt_id,lease_fence,approval_digest,capability,outcome,created_at)
       VALUES(?,?,?,?,?,'scheduled',?)`,
    ).run(
      envelope.operation_id,
      envelope.attempt_id,
      envelope.lease_fence,
      digest,
      envelope.capability,
      new Date().toISOString(),
    );
    const stored = this.get(envelope.operation_id);
    if (stored === undefined) throw new JarvisError("CORE5_LEDGER_MISSING", envelope.operation_id);
    return stored;
  }

  recordResult(result: ExecutionResult): OperationMapping {
    const existing = this.get(result.operation_id);
    if (existing === undefined) throw new JarvisError("CORE5_LEDGER_MISSING", result.operation_id);
    if (existing.attempt_id !== result.attempt_id || existing.lease_fence !== result.lease_fence) {
      throw new JarvisError("CORE5_LEDGER_MISMATCH", result.operation_id);
    }
    this.database.prepare(
      "UPDATE core5_integration_operations SET outcome=? WHERE operation_id=?",
    ).run(result.status, result.operation_id);
    const stored = this.get(result.operation_id);
    if (stored === undefined) throw new JarvisError("CORE5_LEDGER_MISSING", result.operation_id);
    return stored;
  }

  classify(status: ExecutionStatus): "success" | "fail" | "neither" {
    if (status === "SUCCESS") return "success";
    if (status === "FAIL") return "fail";
    return "neither";
  }
}
