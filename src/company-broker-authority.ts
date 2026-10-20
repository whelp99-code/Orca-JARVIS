import { z } from "zod";

/** Shared signature profile; individual routes still own the purpose/operation allowlist. */
export const companyBrokerAuthoritySchema = z.object({
  schema_version: z.literal(1),
  provider_instance_id: z.string().min(1).max(128),
  workspace_id: z.string().min(1).max(128),
  principal_id: z.string().min(1).max(128),
  agent_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
  projects: z.array(z.string().min(1).max(128)).max(128),
  policy_revision: z.string().min(1).max(256),
  purpose: z.string().min(1).max(64),
  operation: z.enum(["handoff", "accept", "reject", "mark_processed", "read_transition_receipt",
    "read_freshness", "reserve_progress", "finish_progress", "auto_process_internal", "read_auto_report"]),
  request_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  deletion_sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  deletion_set_root: z.string().min(1).max(80),
  issued_at: z.string().min(1).max(64),
  expires_at: z.string().min(1).max(64),
  nonce: z.string().min(1).max(128),
  signing_key_id: z.string().min(1).max(128),
  signature: z.string().min(1).max(256),
}).strict();
