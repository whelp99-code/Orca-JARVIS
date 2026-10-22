import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { controlCommandDigest, controlValueDigest } from "./control-plane-contract.js";
import type { CompanyCommandV2 } from "./company-candidate-v2-contract.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

export const companyCancellationSchema = z.object({
  revocation_id: z.string().min(1), request_id: z.string().min(1), command_digest: z.string(),
  reason: z.string().min(1), revoked_by: z.string().min(1),
  revoked_at: z.string().refine(value => Number.isFinite(Date.parse(value))),
  receipt_id: z.string().nullable(), payload_json: z.string(), payload_digest: z.string(),
}).strict();

/** Cancellation is a committed revocation, never a fabricated approve/reject receipt. */
export function readCompanyCancellation(authority: AuthorityDb, command: CompanyCommandV2) {
  const row = authority.db.prepare(
    `SELECT v.revocation_id,v.request_id,v.command_digest,v.reason,v.revoked_by,v.revoked_at,
       v.receipt_id,v.payload_json,v.payload_digest
     FROM control_command_requests r JOIN control_command_revocations v USING(request_id)
     WHERE r.request_id=? AND r.state='cancelled' AND r.action='company.candidate.transition'
       AND r.schema_version=2 AND r.lease_fence=0 AND r.command_digest=v.command_digest
       AND NOT EXISTS (SELECT 1 FROM control_command_redemptions d WHERE d.request_id=r.request_id)
     ORDER BY v.revoked_at,v.revocation_id LIMIT 1`,
  ).get(command.request_id);
  if (!row) return undefined;
  const proof = companyCancellationSchema.parse(row);
  const payload = canonicalize({ request_id: command.request_id, reason: proof.reason,
    revoked_by: proof.revoked_by, revoked_at: proof.revoked_at });
  if (proof.command_digest !== controlCommandDigest(command) || proof.payload_json !== payload
    || proof.payload_digest !== controlValueDigest(payload)) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
  return proof;
}
