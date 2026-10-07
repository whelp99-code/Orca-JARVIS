import { z } from "zod";

// Root's fresh selected fields, not the producer's earlier fixture identities.
export const ADMITTED_RS_PROJECTION = {
  proof_level: "recorded-isolated-rs",
  authority_level: "RS_LOCAL_ONLY",
  admission_sha256: "01f0da3e260dc4ce809327600d97212cd1496d5c7d47c4a69349a5dd76fbd092",
  root_monitor: "mon_XR7M5A2GM0RCC7T8",
  parser_version: "crm:normalized-archive:1",
  source_bytes_sha256: "f2933e98dfefc8c312d5fb55f489334714a28c4d3544fd0f432e21aa4066f213",
  request_digest: "sha256:d805e3f73d79463bda629f46211ed35a39dd73cd22f1e090938c16ad5695851f",
  receipt_id: "cmreceipt:v1:9696cd26c04a9c0cef41231cbbf0e9136fd018ad1057a898137ae777c2ed11a9",
  operation: "receive",
  state: "candidate",
  ack: "EMITTED",
  ack_version: 2,
  archive_authority: "ARCHIVE_PROJECTION_ONLY",
  archive_approved: false,
  locator_approved: "false",
} as const;

const selected = ADMITTED_RS_PROJECTION;
const schema = z.object({
  proof_level: z.literal(selected.proof_level),
  authority_level: z.literal(selected.authority_level),
  admission_sha256: z.literal(selected.admission_sha256),
  root_monitor: z.literal(selected.root_monitor),
  parser_version: z.literal(selected.parser_version),
  source_bytes_sha256: z.literal(selected.source_bytes_sha256),
  request_digest: z.literal(selected.request_digest),
  receipt_id: z.literal(selected.receipt_id),
  operation: z.literal(selected.operation),
  state: z.literal(selected.state),
  ack: z.literal(selected.ack),
  ack_version: z.literal(selected.ack_version),
  archive_authority: z.literal(selected.archive_authority),
  archive_approved: z.literal(selected.archive_approved),
  locator_approved: z.literal(selected.locator_approved),
}).strict().readonly();

export type CrmMemoryReceiptEvidence = z.infer<typeof schema>;

export function readAdmittedCrmMemoryFixture(value: unknown = selected): CrmMemoryReceiptEvidence {
  return schema.parse(value);
}
