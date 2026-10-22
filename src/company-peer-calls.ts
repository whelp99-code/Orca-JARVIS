import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { parseCompanyJson } from "./company-candidate-json.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const rowSchema = z.object({
  operation_id: z.string(), provider_instance_id: z.string(), workspace_id: z.string(), request_id: z.string(),
  operation: z.enum(["decide_approve", "decide_reject", "accept", "reject", "complete", "mark_processed"]),
  transition_request_digest: z.string(), original_arguments_json: z.string(),
  state: z.enum(["prepared", "invoking", "uncertain", "found"]),
  receipt_projection_json: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
});
export type CompanyPeerCall = z.infer<typeof rowSchema>;
export type CompanyPeerIntent = Readonly<{
  operation_id: string; provider_instance_id: string; workspace_id: string; request_id: string;
  operation: CompanyPeerCall["operation"]; transition_request_digest: string; arguments: unknown;
}>;

/** A committed intent is not a peer receipt, nor permission to replay an uncertain mutation. */
export class CompanyPeerCalls {
  constructor(private readonly authority: AuthorityDb) {}

  read(operationId: string): CompanyPeerCall | undefined {
    const row = this.authority.db.prepare("SELECT * FROM company_peer_calls WHERE operation_id=?").get(operationId);
    return row === undefined ? undefined : rowSchema.parse(row);
  }

  prepare(intent: CompanyPeerIntent, now: Date, guard?: () => void): CompanyPeerCall {
    const original = canonicalize(intent.arguments);
    return this.authority.db.transaction(() => {
      guard?.();
      if (this.authority.db.prepare("SELECT 1 FROM company_progress_intent_refusals WHERE operation_id=?").get(intent.operation_id)) {
        throw new JarvisError("COMPANY_RESERVATION_CONFLICT");
      }
      const previous = this.read(intent.operation_id);
      if (previous) {
        if (previous.provider_instance_id !== intent.provider_instance_id || previous.workspace_id !== intent.workspace_id
          || previous.request_id !== intent.request_id || previous.operation !== intent.operation
          || previous.transition_request_digest !== intent.transition_request_digest
          || previous.original_arguments_json !== original) throw new JarvisError("COMPANY_EXECUTION_UNCERTAIN");
        return previous;
      }
      const owner = z.object({ request_id: z.string() }).optional().parse(this.authority.db.prepare(
        `SELECT request_id FROM company_progress_reservations
         WHERE provider_instance_id=? AND workspace_id=? AND evidence_digest IS NULL
         UNION ALL SELECT request_id FROM company_peer_calls
         WHERE provider_instance_id=? AND workspace_id=? AND state IN ('prepared','invoking','uncertain')
           AND NOT EXISTS (SELECT 1 FROM company_progress_intent_refusals f WHERE f.operation_id=company_peer_calls.operation_id) LIMIT 1`,
      ).get(intent.provider_instance_id, intent.workspace_id, intent.provider_instance_id, intent.workspace_id));
      if (owner) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN", `COMPANY_PROGRESS_UNCERTAIN: request_id=${owner.request_id}`);
      this.authority.db.prepare(
        `INSERT INTO company_peer_calls(operation_id,provider_instance_id,workspace_id,request_id,operation,
         transition_request_digest,original_arguments_json,state,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,'prepared',?,?)`,
      ).run(intent.operation_id, intent.provider_instance_id, intent.workspace_id, intent.request_id, intent.operation,
        intent.transition_request_digest, original, now.toISOString(), now.toISOString());
      const row = this.read(intent.operation_id);
      if (!row) throw new JarvisError("COMPANY_EXECUTION_UNCERTAIN");
      return row;
    }).immediate();
  }

  invoking(operationId: string, now: Date): void {
    const changed = this.authority.db.prepare(
      "UPDATE company_peer_calls SET state='invoking',updated_at=? WHERE operation_id=? AND state='prepared'",
    ).run(now.toISOString(), operationId);
    if (changed.changes !== 1) throw new JarvisError("COMPANY_EXECUTION_UNCERTAIN");
  }

  uncertain(operationId: string, now: Date): void {
    this.authority.db.prepare(
      "UPDATE company_peer_calls SET state='uncertain',updated_at=? WHERE operation_id=? AND state='invoking'",
    ).run(now.toISOString(), operationId);
  }

  found(operationId: string, projection: unknown, now: Date): void {
    const json = canonicalize(projection);
    const changed = this.authority.db.prepare(
      `UPDATE company_peer_calls SET state='found',receipt_projection_json=?,updated_at=?
       WHERE operation_id=? AND state IN ('prepared','invoking','uncertain')`,
    ).run(json, now.toISOString(), operationId);
    if (changed.changes === 1) return;
    const previous = this.read(operationId);
    if (!previous || previous.state !== "found" || previous.receipt_projection_json !== json) {
      throw new JarvisError("COMPANY_EXECUTION_UNCERTAIN");
    }
  }

  projection(call: CompanyPeerCall): unknown {
    if (call.state !== "found" || call.receipt_projection_json === null) throw new JarvisError("COMPANY_EXECUTION_UNCERTAIN");
    return parseCompanyJson(call.receipt_projection_json);
  }
}
