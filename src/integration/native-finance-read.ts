import { z } from "zod";
import { JarvisError } from "../jarvis-error.js";
import { consumeNativeOwnerReport } from "./native-owner-report.js";

const text = z.string().min(1);
const money = z.int();
const requestSchema = z.object({
  company_id: text.max(256),
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  view: z.enum(["owner_report", "discrepancy", "settlement"]),
}).strict().refine(value => value.period_start <= value.period_end).readonly();
const record = z.record(z.string(), z.unknown());
const discrepancySchema = z.looseObject({
  items: z.array(record), read_only: z.literal(true), live_source_checked: z.literal(false),
}).readonly();
const settlementSchema = z.looseObject({
  allocations: z.array(z.looseObject({ amount: money })),
  balances: z.array(z.looseObject({ gross: money, allocated: money, remaining: money })),
  purchase_obligations: z.array(z.looseObject({
    ordered: money.nullable(), invoiced: money.nullable(), unbilled: money.nullable(),
    economic_amount: money.nullable(), invoice_allocated: money, invoice_remaining: money.nullable(),
    advance_outflows: money, advance_applied: money,
    order_payment_outflows: money, order_payment_applied: money,
    fee_outflows: money, refund_inflows: money, net_linked_cash: money,
    unresolved_cash_outflows: money.nonnegative(),
    unresolved_cash_event_ids: z.array(text),
    order_cash_residual: money.nullable(),
    cash_coverage_complete: z.boolean(),
    confirmed: z.literal(false), payable_today: z.null(),
  }).superRefine((row, context) => {
    if ((row.unresolved_cash_outflows > 0 || row.unresolved_cash_event_ids.length > 0)
      && (row.order_cash_residual !== null || row.cash_coverage_complete)) {
      context.addIssue({ code: "custom", message: "Unclassified cash cannot establish an exact residual" });
    }
  }).readonly()),
  accounting_posted: z.literal(false), confirmed: z.literal(false),
  bank_cutoff_verified: z.literal(false), as_of: z.iso.date().nullable(),
  stale_event_ids: z.array(text),
}).readonly();

export type NativeFinanceReadRequest = z.infer<typeof requestSchema>;
export type NativeFinanceGet = Readonly<{
  method: "GET";
  path: string;
  query: Readonly<Record<string, string>>;
}>;
export type NativeFinanceReadTransport = Readonly<{
  get(request: NativeFinanceGet): Promise<Readonly<{ status: number; body: string }>>;
}>;

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Trusted composition supplies its native session transport and company scope.
 * This reader never authenticates, grants, writes, retries or reconciles.
 * The local delivery fence is not a native authority token.
 */
export class NativeFinanceReader {
  constructor(
    private readonly company_id: string,
    private readonly transport: NativeFinanceReadTransport,
    private readonly currentFence: () => string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async read(value: unknown) {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw new JarvisError("CORE5_NATIVE_READ_INPUT_INVALID");
    const request = parsed.data;
    if (request.company_id !== this.company_id) throw new JarvisError("CORE5_NATIVE_READ_SCOPE_DENIED");
    const fence = this.currentFence();
    const base = `/api/companies/${encodeURIComponent(request.company_id)}`;
    const paths = { owner_report: "/owner/reports", discrepancy: "/discrepancies", settlement: "/event-settlements" } as const;
    const native_request: NativeFinanceGet = {
      method: "GET", path: base + paths[request.view],
      // Native collection routes are company-wide and accept no date filter.
      query: request.view === "owner_report" ? { start: request.period_start, end: request.period_end } : {},
    };
    const response = await this.transport.get(native_request);
    if (this.currentFence() !== fence) throw new JarvisError("CORE5_NATIVE_READ_FENCE_CHANGED");
    if (response.status !== 200) throw new JarvisError("CORE5_NATIVE_READ_REFUSED");
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new JarvisError("CORE5_NATIVE_READ_RESPONSE_INVALID");
    }
    const source_revision = await digest(response.body);
    const report_id = await digest([
      request.company_id, request.period_start, request.period_end, request.view,
    ].join("|"));
    if (this.currentFence() !== fence) throw new JarvisError("CORE5_NATIVE_READ_FENCE_CHANGED");
    const common = {
      schema_version: 2 as const, capability: "finance.read" as const,
      request, native_request, report_id, source_revision,
      observed_at: this.clock().toISOString(), delivery_fence: fence,
      freshness: "producer_unverified" as const,
      receipt_kind: "response_body_integrity_not_signed" as const,
      response_body: response.body,
    };
    switch (request.view) {
      case "owner_report": {
        const snapshot = z.object({ source_revision: text }).safeParse(body);
        if (!snapshot.success) throw new JarvisError("CORE5_NATIVE_READ_RESPONSE_INVALID");
        const report = consumeNativeOwnerReport(body, {
          company_id: request.company_id, start: request.period_start, end: request.period_end,
          source_revision: snapshot.data.source_revision,
        });
        return Object.freeze({ ...common, view: "owner_report" as const, coverage: "requested-period" as const, data: report });
      }
      case "discrepancy": {
        const report = discrepancySchema.safeParse(body);
        if (!report.success) throw new JarvisError("CORE5_NATIVE_READ_RESPONSE_INVALID");
        return Object.freeze({ ...common, view: "discrepancy" as const, coverage: "company-wide" as const, data: report.data });
      }
      case "settlement": {
        const report = settlementSchema.safeParse(body);
        if (!report.success) throw new JarvisError("CORE5_NATIVE_READ_RESPONSE_INVALID");
        return Object.freeze({ ...common, view: "settlement" as const, coverage: "company-wide" as const, data: report.data });
      }
    }
  }
}

export type NativeFinanceReadReceipt = Awaited<ReturnType<NativeFinanceReader["read"]>>;
