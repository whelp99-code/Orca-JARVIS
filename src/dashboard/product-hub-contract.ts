import { z } from "zod";

const PRODUCT_HUB_STATES = [
  "ready", "no_data", "unconfigured", "unavailable", "denied", "stale", "configured",
] as const;
export const HUB_FAILURE_CODES = [
  "MAIL_READ_REFUSED",
  "MAIL_READ_RESPONSE_INVALID",
  "MAIL_READ_CREDENTIAL_INVALID",
  "MAIL_STATUS_NOT_READY",
  "MAIL_FRESHNESS_REJECTED",
  "MESSENGER_READ_REFUSED",
  "MESSENGER_READ_RESPONSE_INVALID",
] as const;
export type HubFailureCode = (typeof HUB_FAILURE_CODES)[number];

const count = z.int().nonnegative().nullable();

function item<const Id extends string>(id: Id) {
  return z.object({
    id: z.literal(id),
    state: z.enum(PRODUCT_HUB_STATES),
    observed_at: z.iso.datetime().nullable(),
    count,
    secondary_count: count,
    oldest_age_ms: count,
    failure_code: z.enum(HUB_FAILURE_CODES).nullable(),
  }).strict();
}

export const productHubSchema = z.object({
  schema_version: z.literal(1),
  generated_at: z.iso.datetime(),
  items: z.tuple([
    item("crm"),
    item("mail"),
    item("price"),
    item("second_brain"),
    item("messenger"),
    item("approvals"),
  ]),
}).strict();

export type ProductHubResponse = z.infer<typeof productHubSchema>;
