import { z } from "zod";

export const priceFinanceConfigSchema = z.discriminatedUnion("configured", [
  z.object({ schema_version: z.literal(1), configured: z.literal(false) }).strict(),
  z.object({ schema_version: z.literal(1), configured: z.literal(true), company_id: z.string().min(1) }).strict(),
]);
export const priceFinanceReceiptSchema = z.object({
  schema_version: z.literal(2), capability: z.literal("finance.read"),
  request: z.object({
    company_id: z.string().min(1), period_start: z.iso.date(), period_end: z.iso.date(),
    view: z.enum(["owner_report", "discrepancy", "settlement"]),
  }).strict(),
  view: z.enum(["owner_report", "discrepancy", "settlement"]),
  source_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  observed_at: z.iso.datetime(),
  receipt_kind: z.literal("response_body_integrity_not_signed"),
  freshness: z.literal("producer_unverified"), response_body: z.string(),
});
export type PriceFinanceConfig = z.infer<typeof priceFinanceConfigSchema>;
export type PriceFinanceReceipt = z.infer<typeof priceFinanceReceiptSchema>;
export type PriceFinanceRequest = PriceFinanceReceipt["request"];
