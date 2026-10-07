import { z } from "zod";
import { JarvisError } from "../jarvis-error.js";

const text = z.string().min(1);
const money = z.number().int().safe();
const nativeReport = z.object({
  company_id: text, native_contract: z.literal("price.owner-report/2"),
  source_revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  period: z.object({ start: z.iso.date(), end: z.iso.date() }).strict().readonly(),
  basis: z.literal("posted_validation_ledger"),
  read_identity: z.object({
    mode: z.literal("native_membership_non_worker"),
    role: z.enum(["owner", "preparer", "reviewer", "viewer"]), worker: z.literal(false),
  }).strict().readonly(),
  cash: z.object({
    received: money, paid: money, net_movement: money,
    opening_balance: money.nullable(), closing_balance: money.nullable(),
    opening_balance_verified: z.boolean(),
  }).passthrough().readonly(),
  journal_ids: z.array(text),
  payable_coverage: z.object({
    bank_cutoff_verified: z.literal(false),
    purchase_obligations: z.array(z.object({
      order_cash_residual: money.nullable(),
      unresolved_cash_outflows: money.nonnegative(),
      unresolved_cash_event_ids: z.array(text), net_linked_cash: money,
      payable_today: z.null(), confirmed: z.literal(false),
      cash_coverage_complete: z.boolean(),
    }).passthrough().superRefine((row, context) => {
      if ((row.unresolved_cash_outflows > 0 || row.unresolved_cash_event_ids.length > 0)
        && (row.order_cash_residual !== null || row.cash_coverage_complete)) {
        context.addIssue({ code: "custom", message: "Unclassified cash cannot establish an exact residual" });
      }
    }).readonly()),
  }).passthrough().readonly(),
  official_tax_ready: z.literal(false), company_data_complete: z.literal(false),
}).passthrough().readonly();

export type NativeOwnerReportBinding = Readonly<{
  company_id: string;
  start: string;
  end: string;
  source_revision: string;
}>;

/** Consumes the native response without mapping opaque J1 IDs or issuing authority.
 * The explicit binding comes from the producer read, not candidate code hashes.
 * This parser performs no HTTP, refresh, reconciliation, arithmetic or journal write.
 */
export function consumeNativeOwnerReport(value: unknown, expected: NativeOwnerReportBinding) {
  const parsed = nativeReport.safeParse(value);
  if (!parsed.success) throw new JarvisError("CORE5_NATIVE_REPORT_INVALID");
  const report = parsed.data;
  if (report.company_id !== expected.company_id || report.period.start !== expected.start
    || report.period.end !== expected.end || report.period.start > report.period.end
    || report.source_revision !== expected.source_revision) {
    throw new JarvisError("CORE5_NATIVE_REPORT_BINDING_MISMATCH");
  }
  return report;
}
