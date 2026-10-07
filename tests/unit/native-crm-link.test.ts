import { describe, expect, it } from "vitest";
import { consumeNativeCrmLink } from "../../src/integration/native-crm-link.js";

const company = "unit-company";
const hash = "a".repeat(64);
const binding = {
  crm_workspace_id: "unit-workspace", price_company_id: company,
  registered_by: "unit-human", registered_at: "2026-10-07T01:00:00Z", confirmed_by_human: true,
};
function report(state: "UNBOUND" | "UNAPPROVED" | "CONFIRMED" | "SOURCE_CHANGED") {
  return {
    company_id: company,
    crm_company_binding: state === "CONFIRMED" || state === "SOURCE_CHANGED" ? binding : null,
    payable_coverage: {
      purchase_obligations: state === "SOURCE_CHANGED" ? [] : [{ po_event_id: "unit-event", crm_link_state: state }],
      crm_links: state === "UNBOUND" ? [] : [{
        id: "unit-link", event_id: "unit-event", workspace_id: "unit-workspace",
        engagement_id: "unit-engagement", plan_id: "unit-plan", plan_version: 1,
        native_reference_id: `normalized-${hash}`, source_digest: hash,
        source_document_id: "unit-document", context_hash: hash, state,
        confirmed_by: state === "CONFIRMED" || state === "SOURCE_CHANGED" ? "unit-human" : null,
      }],
    },
  };
}
describe("native RT identity evidence", () => {
  it.each(["UNBOUND", "UNAPPROVED", "CONFIRMED", "SOURCE_CHANGED"] as const)(
    "preserves native %s without approving finances", state => {
      const evidence = consumeNativeCrmLink(report(state), company);
      expect(evidence.state).toBe(state);
      expect(evidence.identity_confirmed).toBe(state === "CONFIRMED");
      expect(evidence.source_current).toBe(state !== "SOURCE_CHANGED");
      expect(evidence.financial_confirmation).toBe(false);
    },
  );
  it("does not infer candidate confirmation from a registered company binding", () => {
    const body = report("UNAPPROVED");
    const evidence = consumeNativeCrmLink({ ...body, crm_company_binding: binding }, company);
    expect(evidence.state).toBe("UNAPPROVED");
    expect(evidence.identity_confirmed).toBe(false);
  });
  it.each([
    null,
    { ...binding, confirmed_by_human: false },
    { ...binding, crm_workspace_id: "foreign-workspace" },
  ])("refuses CONFIRMED without the explicit matching human registration", changed => {
    expect(() => consumeNativeCrmLink({ ...report("CONFIRMED"), crm_company_binding: changed }, company))
      .toThrow("CORE5_NATIVE_RT_CONFIRMATION_INVALID");
  });
  it("refuses a different binding company", () => {
    expect(() => consumeNativeCrmLink({ ...report("CONFIRMED"), crm_company_binding: { ...binding, price_company_id: "foreign" } }, company))
      .toThrow("CORE5_NATIVE_RT_COMPANY_MISMATCH");
  });
  it("refuses native confirmation without a confirmer", () => {
    const body = report("CONFIRMED");
    const [link] = body.payable_coverage.crm_links;
    expect(() => consumeNativeCrmLink({ ...body, payable_coverage: {
      ...body.payable_coverage, crm_links: [{ ...link, confirmed_by: null }],
    } }, company)).toThrow("CORE5_NATIVE_RT_CONFIRMATION_INVALID");
  });
  it("refuses source identity mismatch", () => {
    const body = report("UNAPPROVED");
    const [link] = body.payable_coverage.crm_links;
    expect(() => consumeNativeCrmLink({ ...body, payable_coverage: {
      ...body.payable_coverage, crm_links: [{ ...link, native_reference_id: "normalized-foreign" }],
    } }, company)).toThrow("CORE5_NATIVE_RT_SOURCE_MISMATCH");
  });
  it("refuses mismatched row and link state", () => {
    const body = report("CONFIRMED");
    expect(() => consumeNativeCrmLink({ ...body, payable_coverage: {
      ...body.payable_coverage, purchase_obligations: [{ po_event_id: "unit-event", crm_link_state: "UNBOUND" }],
    } }, company)).toThrow("CORE5_NATIVE_RT_STATE_MISMATCH");
  });
  it("refuses distinct jobs rather than merging their identities", () => {
    const body = report("UNAPPROVED");
    const [link] = body.payable_coverage.crm_links;
    expect(() => consumeNativeCrmLink({ ...body, payable_coverage: {
      ...body.payable_coverage, crm_links: [link, { ...link, id: "second", event_id: "other" }],
    } }, company)).toThrow("CORE5_NATIVE_RT_JOB_AMBIGUOUS");
  });
  it("retains a stale native binding without treating it as a current link", () => {
    const evidence = consumeNativeCrmLink(report("SOURCE_CHANGED"), company);
    expect(evidence.binding?.confirmed_by_human).toBe(true);
    expect(evidence.links[0]?.confirmed_by).toBe("unit-human");
    expect(evidence.identity_confirmed).toBe(false);
  });
});
