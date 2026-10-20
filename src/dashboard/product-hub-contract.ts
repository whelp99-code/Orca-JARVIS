import { z } from "zod";

const PRODUCT_HUB_STATES = [
  "ready", "no_data", "unconfigured", "unavailable", "denied", "stale", "configured",
] as const;

const count = z.int().nonnegative().nullable();

function item<const Id extends string>(id: Id) {
  return z.object({
    id: z.literal(id),
    state: z.enum(PRODUCT_HUB_STATES),
    observed_at: z.iso.datetime().nullable(),
    count,
    secondary_count: count,
    oldest_age_ms: count,
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
