import "@testing-library/jest-dom/vitest";
import { createHash, webcrypto } from "node:crypto";
import { z } from "zod";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeLocalWorkCard } from "./local-work-card-model.js";
import { LOCAL_NATIVE_FINANCE_FIXTURE as fixture } from "./local-native-finance-fixture.js";
import { LOCAL_NATIVE_RT_FIXTURES as rtFixtures } from "./local-native-rt-fixtures.js";
import { createLocalCompositionAdapter } from "./finance-read-adapter.js";
import { ControlCenterRoot } from "./root.js";
import { createHarness } from "./store-test-harness.js";

const AT = new Date("2026-10-06T15:00:00.000Z");
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("local work-card contract", () => {
  it("derives the internal ref and body revision while keeping only native request keys", async () => {
    const card = await composeLocalWorkCard(fixture);
    expect(card.report_id).toBe(`sha256:${createHash("sha256").update([
      fixture.request.company_id, fixture.request.period_start, fixture.request.period_end, fixture.request.view,
    ].join("|")).digest("hex")}`);
    expect(card.source_revision).toBe(`sha256:${createHash("sha256").update(fixture.response_body).digest("hex")}`);
    expect(card.native_request).toEqual({
      method: "GET",
      path: `/api/companies/${fixture.request.company_id}/owner/reports`,
      query: { start: "2026-09-01", end: "2026-09-30" },
    });
    expect(card.producer_snapshot).not.toBe(card.source_revision);
    expect(card.freshness).toBe("producer_unverified");
  });
  it("keeps unknown cash, blockers and false readiness without inventing a residual or aggregate", async () => {
    const card = await composeLocalWorkCard(fixture);
    expect(card.obligation).toMatchObject({
      unresolved_cash_outflows: 125, order_cash_residual: null, payable_today: null,
      cash_coverage_complete: false, confirmed: false, net_linked_cash: 450,
    });
    expect(card.report.official_tax_ready).toBe(false);
    expect(card.report.company_data_complete).toBe(false);
    expect(card.report.cash.opening_balance).toBeNull();
    expect(card.report.cash.closing_balance).toBeNull();
    expect(card.blockers).toHaveLength(7);
    expect(card.cross_product_total).toBeNull();
  });
  it.each(["UNBOUND", "UNAPPROVED", "SOURCE_CHANGED"] as const)("keeps native %s unconnected", async state => {
    const card = await composeLocalWorkCard(rtFixtures[state]);
    expect(card.connection).toBe("unconnected");
    expect(card.confirmation).toBe("unconfirmed");
    expect(card.rt.state).toBe(state);
  });
  it("consumes actual native CONFIRMED plus its explicit registration without asserting finance readiness", async () => {
    const card = await composeLocalWorkCard(rtFixtures.CONFIRMED);
    expect(card.connection).toBe("registered_confirmed");
    expect(card.report.official_tax_ready).toBe(false);
    expect(card.obligation?.confirmed).toBe(false);
    expect(card.binding?.price_company_id).toBe(rtFixtures.CONFIRMED.request.company_id);
    expect(card.rt.links[0]?.workspace_id).toBe(card.binding?.crm_workspace_id);
  });
  it("refuses a foreign company registration", async () => {
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(rtFixtures.CONFIRMED.response_body));
    const binding = z.record(z.string(), z.unknown()).parse(body.crm_company_binding);
    const response_body = JSON.stringify({ ...body, crm_company_binding: { ...binding, price_company_id: "foreign" } });
    await expect(composeLocalWorkCard({ ...rtFixtures.CONFIRMED, response_body,
      expected_body_sha256: `sha256:${createHash("sha256").update(response_body).digest("hex")}` }))
      .rejects.toMatchObject({ code: "CORE5_NATIVE_RT_COMPANY_MISMATCH" });
  });
  it("refuses changed response bytes rather than trusting caller revision text", async () => {
    await expect(composeLocalWorkCard({ ...fixture, response_body: `${fixture.response_body} ` }))
      .rejects.toMatchObject({ code: "CORE5_LOCAL_BODY_CHANGED" });
  });
  it.each([
    { company_id: "foreign" },
    { period_start: "2026-09-02" },
    { period_end: "2026-10-01" },
  ])("refuses native scope or date mismatches", async change => {
    await expect(composeLocalWorkCard({ ...fixture, request: { ...fixture.request, ...change } }))
      .rejects.toMatchObject({ code: "CORE5_NATIVE_REPORT_BINDING_MISMATCH" });
  });
  it("refuses a claimed exact residual even if the changed body hash matches", async () => {
    const response_body = fixture.response_body.replace('"order_cash_residual":null', '"order_cash_residual":525');
    const expected_body_sha256 = `sha256:${createHash("sha256").update(response_body).digest("hex")}`;
    await expect(composeLocalWorkCard({ ...fixture, response_body, expected_body_sha256 }))
      .rejects.toMatchObject({ code: "CORE5_NATIVE_REPORT_INVALID" });
  });
  it("rejects fabricated native input keys", async () => {
    const request = { ...fixture.request, report_id: "not-native", source_revision: "caller" };
    await expect(composeLocalWorkCard({ ...fixture, request })).rejects.toBeInstanceOf(Error);
  });
  it("does not infer CONFIRMED from caller-supplied registration", async () => {
    const body = z.record(z.string(), z.unknown()).parse(JSON.parse(rtFixtures.CONFIRMED.response_body));
    const input = { ...rtFixtures.UNAPPROVED, binding: body.crm_company_binding };
    const card = await composeLocalWorkCard(input);
    expect(card.rt.state).toBe("UNAPPROVED");
    expect(card.confirmation).toBe("unconfirmed");
  });
  it.each(["UNBOUND", "UNAPPROVED", "CONFIRMED", "SOURCE_CHANGED"] as const)(
    "renders actual native %s with identity-only confirmation", async state => {
      const adapter = await createLocalCompositionAdapter(() => AT, state);
      const harness = createHarness();
      await act(async () => {
        render(<ControlCenterRoot store={harness.store} client={harness.client}
          initialPath="/finance-read" financeReadAdapter={adapter} />);
      });
      const card = document.querySelector(".local-work-card");
      expect(card).toHaveAttribute("data-rt-state", state);
      expect(card).toHaveAttribute("data-confirmation", state === "CONFIRMED" ? "confirmed" : "unconfirmed");
      expect(card?.querySelector("[data-official-tax-ready]")).toHaveAttribute("data-official-tax-ready", "false");
      expect(card?.querySelector("[data-payable-today]")).toHaveAttribute("data-payable-today", "null");
      expect(card?.querySelectorAll("[data-card-edge]")).toHaveLength(5);
      if (state === "SOURCE_CHANGED") {
        expect(adapter.work_card?.obligation).toBeUndefined();
        expect(card?.querySelector("[data-unresolved-cash]")).toHaveAttribute("data-unresolved-cash", "null");
        expect(adapter.work_card?.rt.binding?.confirmed_by_human).toBe(true);
        expect(adapter.work_card?.rt.identity_confirmed).toBe(false);
      }
    },
  );
  it("renders one real-route card with equal stage identities and all five distinct evidence edges", async () => {
    const adapter = await createLocalCompositionAdapter(() => AT);
    const harness = createHarness();
    await act(async () => {
      render(<ControlCenterRoot store={harness.store} client={harness.client}
        initialPath="/finance-read" financeReadAdapter={adapter} />);
    });
    const cards = document.querySelectorAll(".local-work-card");
    expect(cards).toHaveLength(1);
    const card = cards.item(0);
    expect(card).toHaveAttribute("data-connection", "unconnected");
    expect(card).toHaveAttribute("data-confirmation", "unconfirmed");
    expect(card).toHaveAttribute("data-freshness", "producer_unverified");
    const stages = Array.from(card.querySelectorAll("[data-card-stage]"));
    expect(stages.map(stage => stage.getAttribute("data-card-stage"))).toEqual(["source", "project", "amount", "approval", "receipt"]);
    for (const stage of stages) {
      expect(stage).toHaveAttribute("data-case-id", adapter.work_card?.case_id);
      expect(stage).toHaveAttribute("data-source-revision", fixture.expected_body_sha256);
    }
    expect(Array.from(card.querySelectorAll("[data-card-edge]"), edge => edge.getAttribute("data-card-edge")))
      .toEqual(["MS", "RS", "MR", "MT", "RT"]);
    expect(card.querySelector("[data-unresolved-cash]")).toHaveAttribute("data-unresolved-cash", "125");
    expect(card.querySelector("[data-residual]")).toHaveAttribute("data-residual", "null");
    expect(card.querySelector("[data-official-tax-ready]")).toHaveAttribute("data-official-tax-ready", "false");
    expect(card.querySelector("button,input,a")).toBeNull();
    expect(card.querySelectorAll("[data-proof-level='recorded-isolated-ms']")).toHaveLength(1);
  });
  it("keeps the composed fixture off the default route and phone surface", async () => {
    const adapter = await createLocalCompositionAdapter(() => AT);
    const harness = createHarness();
    await act(async () => {
      render(<ControlCenterRoot store={harness.store} client={harness.client}
        surface="phone" initialPath="/finance-read" financeReadAdapter={adapter} />);
    });
    expect(document.querySelector(".local-work-card")).toBeNull();
    cleanup();
    await act(async () => {
      render(<ControlCenterRoot store={harness.store} client={harness.client} initialPath="/finance-read" />);
    });
    expect(document.querySelector(".local-work-card")).toBeNull();
  });
});
