import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedFinanceReadAdapter } from "./finance-read-adapter.js";
import { FinanceReadPage } from "./finance-read-page.js";
import { ControlCenterRoot } from "./root.js";
import { createHarness } from "./store-test-harness.js";
import { ADMITTED_MS_PROJECTION } from "./company-memory-admitted-fixture.js";
import { ADMITTED_MR_PROJECTION } from "./mail-crm-admitted-fixture.js";
import { ADMITTED_RS_PROJECTION } from "./crm-memory-admitted-fixture.js";

const AT = new Date("2026-10-06T00:00:00.000Z");
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("isolated finance read page", () => {
  it("prepares a bounded case request through the real fixture adapter and retires edited results", () => {
    const adapter = { ...createIsolatedFinanceReadAdapter(() => AT) };
    const prepare = vi.spyOn(adapter, "prepare");
    render(<FinanceReadPage adapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: "격리 요청 검사" }));
    expect(screen.getByTestId("finance-read-prepared")).toHaveTextContent(adapter.company_id);
    expect(document.querySelector("[data-outcome]")).toHaveAttribute("data-outcome", "prepared");
    expect(prepare).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("회사 ID"), { target: { value: "company:foreign" } });
    expect(screen.queryByTestId("finance-read-prepared")).not.toBeInTheDocument();
    expect(document.querySelector("[data-outcome]")).toHaveAttribute("data-outcome", "idle");
    fireEvent.click(screen.getByRole("button", { name: "격리 요청 검사" }));
    expect(document.querySelector("[data-outcome]")).toHaveAttribute("data-outcome", "refused");
    expect(screen.queryByTestId("finance-read-prepared")).not.toBeInTheDocument();
  });
  it("prepares a report and refuses a v1 selection without a provider request", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const adapter = createIsolatedFinanceReadAdapter(() => AT);
    render(<FinanceReadPage adapter={adapter} />);
    fireEvent.change(screen.getByLabelText("참조 종류"), { target: { value: "report_id" } });
    fireEvent.change(screen.getByLabelText("Case / Report ID"), { target: { value: "report:fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "격리 요청 검사" }));
    expect(screen.getByTestId("finance-read-prepared")).toHaveTextContent("report:fixture");
    fireEvent.change(screen.getByLabelText("계약 version"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "격리 요청 검사" }));
    expect(document.querySelector("[data-outcome]")).toHaveAttribute("data-outcome", "refused");
    expect(screen.queryByTestId("finance-read-prepared")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains the existing product route with no fixture enabled by default", async () => {
    const harness = createHarness();
    await act(async () => {
      render(<ControlCenterRoot store={harness.store} client={harness.client} initialPath="/finance-read" />);
    });
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "격리 요청 검사" })).not.toBeInTheDocument();
    expect(document.querySelector(".finance-read-page[data-proof-level]")).toBeNull();
    expect(document.querySelector(".finance-read-page[data-proof-level] [data-memory-state]")).toBeNull();
    expect(document.querySelector(".finance-read-page[data-proof-level] [data-mapping-authority]")).toBeNull();
    expect(document.querySelector(".finance-read-page[data-proof-level] [data-archive-approved]")).toBeNull();
  });
  it("consumes the explicit fixture through the real route, not a separate mock page", async () => {
    const harness = createHarness();
    const adapter = createIsolatedFinanceReadAdapter(() => AT);
    await act(async () => {
      render(<ControlCenterRoot store={harness.store} client={harness.client}
        initialPath="/finance-read" financeReadAdapter={adapter} />);
    });
    fireEvent.click(screen.getByRole("button", { name: "격리 요청 검사" }));
    expect(document.querySelector(".finance-read-page[data-proof-level]")).toHaveAttribute("data-proof-level", "isolated-fixture");
    expect(screen.getByTestId("finance-read-prepared")).toBeInTheDocument();
  });
  it("renders the recorded MS candidate separately without issuing a read or mutation", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const adapter = createIsolatedFinanceReadAdapter(() => AT);
    render(<FinanceReadPage adapter={adapter} />);
    const panel = document.querySelector("[data-memory-state]");
    expect(panel).toHaveAttribute("data-memory-state", "candidate");
    expect(panel).toHaveAttribute("data-proof-level", "recorded-isolated-ms");
    expect(panel).toHaveTextContent(ADMITTED_MS_PROJECTION.workspace_id);
    expect(panel).toHaveTextContent(ADMITTED_MS_PROJECTION.candidate_id);
    expect(panel).toHaveTextContent(ADMITTED_MS_PROJECTION.request_digest);
    expect(panel).toHaveTextContent(ADMITTED_MS_PROJECTION.admitted_receipt_id);
    expect(panel?.querySelector("button,a,input")).toBeNull();
    expect(adapter.company_id).not.toBe(ADMITTED_MS_PROJECTION.workspace_id);
    fireEvent.click(screen.getByRole("button", { name: "격리 요청 검사" }));
    expect(panel).toHaveAttribute("data-memory-state", "candidate");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("renders MR producer identities without lending its human fixture authority", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<FinanceReadPage adapter={createIsolatedFinanceReadAdapter(() => AT)} />);
    const panel = document.querySelector("[data-mapping-authority]");
    expect(panel).toHaveAttribute("data-proof-level", "recorded-isolated-mr");
    expect(panel).toHaveAttribute("data-mapping-authority", "explicit-human-fixture");
    expect(panel).toHaveTextContent(ADMITTED_MR_PROJECTION.source_digest);
    expect(panel).toHaveTextContent(ADMITTED_MR_PROJECTION.receive_audit_hash);
    expect(panel).toHaveTextContent(ADMITTED_MR_PROJECTION.mapping_state_hash);
    expect(panel?.querySelector("button,a,input")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("renders Root RS fields as unapproved archive evidence without a new publication", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<FinanceReadPage adapter={createIsolatedFinanceReadAdapter(() => AT)} />);
    const panel = document.querySelector("[data-archive-approved]");
    expect(panel).toHaveAttribute("data-proof-level", "recorded-isolated-rs");
    expect(panel).toHaveAttribute("data-archive-approved", "false");
    expect(panel).toHaveTextContent(ADMITTED_RS_PROJECTION.source_bytes_sha256);
    expect(panel).toHaveTextContent(ADMITTED_RS_PROJECTION.request_digest);
    expect(panel).toHaveTextContent(ADMITTED_RS_PROJECTION.receipt_id);
    expect(panel?.querySelector("button,a,input")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not expose the route, navigation or fixture on the phone gateway", () => {
    const harness = createHarness();
    const adapter = createIsolatedFinanceReadAdapter(() => AT);
    render(<ControlCenterRoot store={harness.store} client={harness.client}
      initialPath="/finance-read" surface="phone" financeReadAdapter={adapter} />);
    expect(screen.queryByRole("link", { name: "조회 준비" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "격리 요청 검사" })).not.toBeInTheDocument();
    expect(document.querySelector("[data-proof-level]")).toBeNull();
    expect(harness.lifecycle.sourceCreated).toBe(false);
  });
});
