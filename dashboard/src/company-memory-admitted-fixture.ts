import { z } from "zod";

// Selected fields from Root's accepted MS run, not a newly issued receipt or grant.
export const ADMITTED_MS_PROJECTION = {
  schema_version: 1,
  proof_level: "recorded-isolated-ms",
  package: "FP5-20261006-v1",
  admission_sha256: "132ea6810fcd87cfcb458172167136ba3e2466b3f38a2927da99dc804094cfdc",
  monitor: "mon_FBSEHRG42WJ9DHV7",
  workspace_id: "12345678-1234-4234-8234-123456789abc",
  candidate_id: "mail:v1:12345678-1234-4234-8234-123456789abc:outlook:fixture@example.invalid:original:<original@example.invalid>",
  source_locator: "original",
  source_event_id: "<original@example.invalid>",
  locator: { graph_id: "original", kind: "mail_message" },
  parser_version: "mail:company-memory:2",
  content_digest: "sha256:ef0bc3864d3574b94557d3bfd5ea893b5dc1be86a75a141d2a3bc98a0f22b6e0",
  request_digest: "sha256:2f2af688bd5421d2dfbc9c749ac608bb5eee8746183ea25e8973909689694402",
  admitted_receipt_id: "cmreceipt:v1:ea67fca1642fc5866040f5acf64a37e044d101d21e8a5eae6b39ee1ed2779be6",
  operation: "receive",
  state: "candidate",
  ack: "EMITTED",
  ack_version: 2,
} as const;

const selected = ADMITTED_MS_PROJECTION;
const schema = z.object({
  schema_version: z.literal(selected.schema_version),
  proof_level: z.literal(selected.proof_level),
  package: z.literal(selected.package),
  admission_sha256: z.literal(selected.admission_sha256),
  monitor: z.literal(selected.monitor),
  workspace_id: z.literal(selected.workspace_id),
  candidate_id: z.literal(selected.candidate_id),
  source_locator: z.literal(selected.source_locator),
  source_event_id: z.literal(selected.source_event_id),
  locator: z.object({
    graph_id: z.literal(selected.locator.graph_id),
    kind: z.literal(selected.locator.kind),
  }).strict().readonly(),
  parser_version: z.literal(selected.parser_version),
  content_digest: z.literal(selected.content_digest),
  request_digest: z.literal(selected.request_digest),
  admitted_receipt_id: z.literal(selected.admitted_receipt_id),
  operation: z.literal(selected.operation),
  state: z.literal(selected.state),
  ack: z.literal(selected.ack),
  ack_version: z.literal(selected.ack_version),
}).strict().readonly();

export type CompanyMemoryReceiptEvidence = z.infer<typeof schema>;

/** Pin a recorded admission projection. This does not verify or mint authority. */
export function readAdmittedCompanyMemoryFixture(value: unknown = selected): CompanyMemoryReceiptEvidence {
  return schema.parse(value);
}
