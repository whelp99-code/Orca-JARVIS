import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlRequestListResponse } from "../../src/dashboard/read-model.js";
import { createDashboardClient } from "./api.js";
import { createHarness, frame, populatedOverview } from "./store-test-harness.js";
import { ApprovalsPage } from "./pages/approvals-page.js";
import App from "./app.js";

const page = (id: string, next: string | null = null): ControlRequestListResponse => ({ schema_version: 1,
  items: [{ request_id: id, action: "workflow.start", action_level: 2, requested_at: "2026-09-08T00:00:00Z",
    requested_by: "operator", summary: id, state: "pending" }],
  page: { limit: 50, total: 51, returned: 1, has_more: next !== null, next_cursor: next } });
let harness: ReturnType<typeof createHarness> | undefined;
afterEach(() => { harness?.store.stop(); cleanup(); vi.unstubAllGlobals(); });

it("requests bounded pages, carries the cursor, and rejects inconsistent page metadata", async () => {
  const fetcher = vi.fn<(path: string) => Promise<Response>>(async () => new Response(JSON.stringify(page("first", "cursor"))));
  vi.stubGlobal("fetch", fetcher);
  const client = createDashboardClient();
  await client.controlRequests(); await client.controlRequests(undefined, "cursor");
  expect(fetcher.mock.calls.map(args => args[0])).toEqual([
    "/api/v1/control/requests?limit=50", "/api/v1/control/requests?limit=50&cursor=cursor",
  ]);
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...page("first"), page: { ...page("first").page, returned: 2 } })));
  await expect(client.controlRequests()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

it("keeps only the selected page and fences a delayed next page after returning to first", async () => {
  const h = harness = createHarness();
  h.client.data.approvals = page("first", "cursor");
  h.store.start(); const source = await h.opened;
  let release!: (value: ControlRequestListResponse) => void;
  const cursors: Array<string | undefined> = [];
  h.client.controlRequests = async (_signal?: AbortSignal, cursor?: string) => {
    cursors.push(cursor);
    return cursor === undefined ? page("fresh-first", "cursor") : await new Promise(resolve => { release = resolve; });
  };
  const next = h.store.nextApprovals();
  const first = h.store.firstApprovals();
  release(page("late-second")); await Promise.all([next, first]);
  expect(cursors).toEqual(["cursor", undefined]);
  expect(h.store.getSnapshot().approvals).toMatchObject({ data: page("fresh-first", "cursor") });
  h.client.controlRequests = async (_signal?: AbortSignal, cursor?: string) => {
    cursors.push(cursor); return page("second");
  };
  await h.store.nextApprovals();
  source.emit("reconcile", frame("reconcile", ["approvals"], "inst:page"));
  await h.store.refreshApprovals();
  expect(cursors.slice(2).every(cursor => cursor === "cursor")).toBe(true);
  expect(h.store.getSnapshot().approvals).toMatchObject({ data: { items: [{ request_id: "second" }] } });
});

it("offers page navigation including an empty last page and first-page recovery on failure", () => {
  const first = vi.fn(); const next = vi.fn();
  const client = { decideRequest: vi.fn(), executeRequest: vi.fn(), retryRequest: vi.fn() };
  const empty = { ...page("unused"), items: [], page: { limit: 50, total: 50, returned: 0, has_more: false, next_cursor: null } } as const;
  const view = render(<ApprovalsPage state={{ status: "empty", data: empty }} client={client} onFirst={first} onNext={next} />);
  expect(screen.getByText("0 shown / 50 actionable requests")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "First page" })); expect(first).toHaveBeenCalledTimes(1);
  view.rerender(<ApprovalsPage state={{ status: "error", kind: "server", error: {
    kind: "server", code: "CONTROL_PAGE_STALE", message: "List changed", request_id: "test" } }} client={client} onFirst={first} />);
  fireEvent.click(screen.getByRole("button", { name: "First page" })); expect(first).toHaveBeenCalledTimes(2);
});

it("renders the whole pending count independently of the bounded overview preview", () => {
  render(<App overview={{ ...populatedOverview, cards: [{ id: "pending-approvals", label: "Pending", value: 51, detail: "51 pending" }],
    pending_approvals: page("first").items }} />);
  const card = screen.getByRole("article", { name: "승인 대기" });
  expect(within(card).getByText("51")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "승인 목록 전체 보기" })).toHaveAttribute("href", "/approvals");
});
