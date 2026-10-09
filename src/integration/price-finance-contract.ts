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

export const priceCompanyBindingSourceSchema = z.object({
  candidate: z.looseObject({
    id: z.string().min(1), revision: z.int().positive(),
    crm_workspace_id: z.uuid(), price_company_id: z.string().min(1),
    registered_by: z.string().min(1), registered_at: z.iso.datetime({ offset: true }),
    confirmed_by_human: z.boolean(), confirmed_by: z.string().nullable(),
    confirmation_ref: z.string().nullable(), source_reference: z.string().min(1),
  }).nullable(),
  confirmed_connection: z.boolean(),
}).refine(value => value.confirmed_connection === (value.candidate?.confirmed_by_human === true));

export const priceCompanyBindingReceiptSchema = z.object({
  schema_version: z.literal(1), company_id: z.string().min(1),
  source_revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  observed_at: z.iso.datetime(), freshness: z.literal("producer_unverified"),
  receipt_kind: z.literal("response_body_integrity_not_signed"),
  response_body: z.string(), data: priceCompanyBindingSourceSchema,
});
export type PriceCompanyBindingReceipt = z.infer<typeof priceCompanyBindingReceiptSchema>;
