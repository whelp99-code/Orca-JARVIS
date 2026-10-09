// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardClient } from "./api.js";
import { ControlCenterRoot } from "./root.js";
import { createDashboardStore } from "./store.js";
import { createMailCandidatesFixture } from "./mail-candidates-fixture.js";
import { unseenPortfolio } from "./portfolio-test-fixture.js";

afterEach(cleanup);
function mount(fixture: boolean) {
  const client = { ...createDashboardClient(),
    overview: async () => ({ schema_version: 1 as const, generated_at: "2026-10-09T00:00:00.000Z",
      cards: [], recent_tasks: [], pending_approvals: [], risks: [], agents: [], portfolio: unseenPortfolio }),
    tasks: async () => ({ schema_version: 1 as const, items: [] }),
    agents: async () => ({ schema_version: 1 as const, items: [] }),
    controlRequests: async () => ({ schema_version: 1 as const, items: [] }),
    priceFinanceConfig: async () => ({ schema_version: 1 as const, configured: false as const }),
  };
  const store = createDashboardStore({ client, eventSourceFactory: () => ({
    onopen: null, onerror: null, addEventListener() {}, close() {},
  }) });
  return render(<ControlCenterRoot store={store} client={client} initialPath="/finance-read"
    mailCandidatesAdapter={fixture ? createMailCandidatesFixture() : undefined} />);
}
describe("Mail candidates in the product work-card route", () => {
  it("mounts the fixture card through ControlCenterRoot without a Price connection", async () => {
    mount(true);
    expect(await screen.findAllByRole("listitem")).toHaveLength(5);
    expect(document.querySelector('[data-candidate-source="crm"]')?.getAttribute("data-candidate-count")).toBe("7");
  });
  it("keeps the operating route unconnected when no candidate reader is issued", () => {
    mount(false);
    expect(document.querySelector('[data-candidate-source="crm"]')?.hasAttribute("data-candidate-count")).toBe(false);
    expect(document.querySelector('[data-candidate-source="sb"]')?.getAttribute("data-source-state")).toBe("unconnected");
  });
});
