import { z } from "zod";
import { JarvisError } from "../jarvis-error.js";

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const state = z.enum(["UNBOUND", "UNAPPROVED", "CONFIRMED", "SOURCE_CHANGED"]);
const bindingSchema = z.looseObject({
  crm_workspace_id: id, price_company_id: id,
  registered_by: id, registered_at: z.iso.datetime({ offset: true }),
  confirmed_by_human: z.boolean(),
}).readonly();
const linkSchema = z.looseObject({
  id, event_id: id, workspace_id: id, engagement_id: id, plan_id: id,
  plan_version: z.int().positive(), native_reference_id: id,
  source_digest: digest, source_document_id: id, context_hash: digest,
  state: z.enum(["UNAPPROVED", "CONFIRMED", "SOURCE_CHANGED"]),
  confirmed_by: id.nullable(),
}).readonly();
const schema = z.object({
  company_id: id, crm_company_binding: bindingSchema.nullable(),
  payable_coverage: z.object({
    crm_links: z.array(linkSchema),
    purchase_obligations: z.array(z.object({
      po_event_id: id.nullable(), crm_link_state: state,
    })).max(1),
  }),
});

export type NativeCompanyBinding = z.infer<typeof bindingSchema>;

/** Native identity evidence only. It cannot approve money or issue authority. */
export function consumeNativeCrmLink(value: unknown, company_id: string) {
  const result = schema.safeParse(value);
  if (!result.success) throw new JarvisError("CORE5_NATIVE_RT_FIELDS_INVALID");
  const report = result.data;
  if (report.company_id !== company_id
    || (report.crm_company_binding !== null && report.crm_company_binding.price_company_id !== company_id)) {
    throw new JarvisError("CORE5_NATIVE_RT_COMPANY_MISMATCH");
  }
  const row = report.payable_coverage.purchase_obligations[0];
  const links = report.payable_coverage.crm_links;
  if (new Set(links.map(link => link.event_id)).size > 1
    || links.some(link => row !== undefined && link.event_id !== row.po_event_id)) {
    throw new JarvisError("CORE5_NATIVE_RT_JOB_AMBIGUOUS");
  }
  if (links.some(link => link.native_reference_id !== `normalized-${link.source_digest}`
    || (link.state === "UNAPPROVED" && link.confirmed_by !== null))) {
    throw new JarvisError("CORE5_NATIVE_RT_SOURCE_MISMATCH");
  }
  const nativeState = links.some(link => link.state === "SOURCE_CHANGED") ? "SOURCE_CHANGED"
    : links.length === 1 && links[0]?.state === "CONFIRMED" ? "CONFIRMED"
      : links.length > 0 ? "UNAPPROVED" : "UNBOUND";
  if ((row !== undefined && row.crm_link_state !== nativeState)
    || (row === undefined && nativeState !== "SOURCE_CHANGED")) {
    throw new JarvisError("CORE5_NATIVE_RT_STATE_MISMATCH");
  }
  const binding = report.crm_company_binding;
  if (nativeState === "CONFIRMED" && (binding === null || !binding.confirmed_by_human
    || links[0]?.workspace_id !== binding.crm_workspace_id || !links[0].confirmed_by)) {
    throw new JarvisError("CORE5_NATIVE_RT_CONFIRMATION_INVALID");
  }
  return Object.freeze({
    state: nativeState, links, binding,
    identity_confirmed: nativeState === "CONFIRMED",
    source_current: nativeState !== "SOURCE_CHANGED",
    financial_confirmation: false as const,
  });
}

export type NativeCrmLinkEvidence = ReturnType<typeof consumeNativeCrmLink>;
