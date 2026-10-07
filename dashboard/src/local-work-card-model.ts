import { z } from "zod";
import { JarvisError } from "../../src/jarvis-error.js";
import { NativeFinanceReader } from "../../src/integration/native-finance-read.js";
import { consumeNativeCrmLink } from "../../src/integration/native-crm-link.js";

const id = z.string().min(1);
const money = z.int();
const cardFields = z.object({
  blockers: z.array(z.object({ code: id, id })),
  payable_coverage: z.object({
    purchase_obligations: z.array(z.object({
      po_event_id: id, project_id: id, order_reference: id,
      ordered: money.nullable(), invoiced: money.nullable(), unbilled: money.nullable(), net_linked_cash: money,
      unresolved_cash_outflows: money, order_cash_residual: money.nullable(),
      source_record_ids: z.array(id).min(1), document_ids: z.array(id).min(1),
      unresolved_cash_event_ids: z.array(id), confirmed: z.literal(false),
      payable_today: z.null(), cash_coverage_complete: z.boolean(),
    })).max(1),
  }),
});
/** Recorded local response only. No transport, authority or inferred company join. */
export async function composeLocalWorkCard(input: Readonly<{
  response_body: string;
  expected_body_sha256: string;
  observed_at: string;
  request: Readonly<{ company_id: string; period_start: string; period_end: string; view: "owner_report" }>;
}>) {
  const request = z.object({
    company_id: id, period_start: z.iso.date(), period_end: z.iso.date(),
    view: z.literal("owner_report"),
  }).strict().parse(input.request);
  const observed_at = z.iso.datetime().parse(input.observed_at);
  const reader = new NativeFinanceReader(request.company_id, {
    // This product composition uses recorded bytes, not a native session or live fetch.
    async get() { return { status: 200, body: input.response_body }; },
  }, () => "recorded-local-fixture", () => new Date(observed_at));
  const receipt = await reader.read(request);
  if (receipt.view !== "owner_report") throw new JarvisError("CORE5_LOCAL_REPORT_VIEW_MISMATCH");
  const { source_revision, report_id, native_request, data: report } = receipt;
  if (source_revision !== input.expected_body_sha256) throw new JarvisError("CORE5_LOCAL_BODY_CHANGED");
  const fields = cardFields.parse(report);
  const rt = consumeNativeCrmLink(report, request.company_id);
  const obligation = fields.payable_coverage.purchase_obligations[0];
  if (obligation === undefined && rt.state !== "SOURCE_CHANGED") throw new JarvisError("CORE5_LOCAL_OBLIGATION_MISSING");
  return Object.freeze({
    case_id: `case:${report_id}`, report_id, source_revision, observed_at,
    proof_level: "LOCAL_ONLY" as const, freshness: "producer_unverified" as const,
    native_request,
    request, report, obligation, blockers: fields.blockers, binding: rt.binding, rt,
    connection: rt.identity_confirmed ? "registered_confirmed" as const : "unconnected" as const,
    confirmation: rt.identity_confirmed ? "confirmed" as const : "unconfirmed" as const,
    // Independent historical edge proofs cannot be summed or declared one native job.
    cross_product_total: null,
    producer_snapshot: report.source_revision,
    receipt_kind: "response_body_integrity_not_signed" as const,
  });
}

export type LocalWorkCard = Awaited<ReturnType<typeof composeLocalWorkCard>>;
