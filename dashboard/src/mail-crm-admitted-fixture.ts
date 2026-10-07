import { z } from "zod";

// Mail producer's selected fields, admitted by Root; not Root's fresh fixture IDs.
export const ADMITTED_MR_PROJECTION = {
  proof_level: "recorded-isolated-mr",
  admission_sha256: "60fd58c1abe0d644ded8d3975626496219848cb3e3a63a4a83bbe4f1c56cd28a",
  root_monitor: "mon_TXWKTNEZN16M8YTX",
  producer_monitor: "mon_94EH2T7RWNRQZTCM",
  source_locator: "mr-source",
  source_digest: "3ac2e7d65d19810da9abcc8a25652ee976016630e850b4024ce9cd582b6ecd6f",
  receive_command: "mail.inbox.receive",
  receive_version: 5,
  receive_idempotency_key: "mail-command:6ba99e0383ea85f8cc84b193b2fb708c7a8c1567e245d47c2bc7ef6780402e5f",
  receive_audit_hash: "b023efd4c8938c6ffddffc79f23ab7f8a6b840997d04a89e19b8022203c6e06f",
  mapping_command: "mail.mapWork",
  mapping_authority: "explicit-human-fixture",
  mapping_version: 7,
  mapping_idempotency_key: "mail-command:28b61bec4c5942e5eee7a020bae7c3d83e958385b06b2b32aac0f1e0e1712934",
  mapping_audit_hash: "3ae07aa07654b86881da2e7d8fd2ea21862fb475fd5751179814200a86de8036",
  mapping_state_hash: "3eb45ea549c5c099a6979ff86a431c5798819e8477e67bdfd5e2894a4b0f04c8",
} as const;

const selected = ADMITTED_MR_PROJECTION;
const schema = z.object({
  proof_level: z.literal(selected.proof_level),
  admission_sha256: z.literal(selected.admission_sha256),
  root_monitor: z.literal(selected.root_monitor),
  producer_monitor: z.literal(selected.producer_monitor),
  source_locator: z.literal(selected.source_locator),
  source_digest: z.literal(selected.source_digest),
  receive_command: z.literal(selected.receive_command),
  receive_version: z.literal(selected.receive_version),
  receive_idempotency_key: z.literal(selected.receive_idempotency_key),
  receive_audit_hash: z.literal(selected.receive_audit_hash),
  mapping_command: z.literal(selected.mapping_command),
  mapping_authority: z.literal(selected.mapping_authority),
  mapping_version: z.literal(selected.mapping_version),
  mapping_idempotency_key: z.literal(selected.mapping_idempotency_key),
  mapping_audit_hash: z.literal(selected.mapping_audit_hash),
  mapping_state_hash: z.literal(selected.mapping_state_hash),
}).strict().readonly();

export type MailCrmReceiptEvidence = z.infer<typeof schema>;

export function readAdmittedMailCrmFixture(value: unknown = selected): MailCrmReceiptEvidence {
  return schema.parse(value);
}
