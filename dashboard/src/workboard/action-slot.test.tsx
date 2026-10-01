import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkboardActionSlot } from "./action-slot.js";
import { readWorkboardResponse } from "../../../src/dashboard/workboard-routes.js";
import { openWorkboardFixture, WORKBOARD_FIXTURE_NOW } from "../../../tests/fixtures/workboard-fixture.js";
import { actionRequest } from "../../../tests/fixtures/workboard-action-agent.js";
import type { ActionResult } from "../../../src/workboard/action-contracts.js";
import type { WorkboardActionClient } from "../authority-api.js";
import { createAuthorityMutationClient } from "../authority-api.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function card() {
  const db = openWorkboardFixture();
  try { const card = readWorkboardResponse(db, WORKBOARD_FIXTURE_NOW).attention[0]!;
    return { ...card, action_capability: { available: true, reason: "", location: "fixture", effects: actionRequest().effects, pending: null } }; }
  finally { db.close(); }
}
it("submits the reviewed token and operation once while awaiting the exact result signal", async () => {
  const user = userEvent.setup(); const c = card();
  const prepared = { token: "reviewed-token", request: { ...actionRequest(), workId: c.work_id }, requiresReceipt: false };
  let finish!: (value: ActionResult) => void;
  const result = new Promise<ActionResult>(resolve => { finish = resolve; });
  const client: WorkboardActionClient = { prepare: vi.fn(async () => prepared), submit: vi.fn(() => result), reconcile: vi.fn() };
  const { container } = render(<WorkboardActionSlot card={c} client={client} fallback={null} />);
  await user.click(container.querySelector<HTMLButtonElement>('[data-operation="approve"]')!);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  const confirm = container.querySelector<HTMLButtonElement>('[data-action="confirm"]')!;
  fireEvent.click(confirm); fireEvent.click(confirm);
  expect(client.submit).toHaveBeenCalledTimes(1);
  expect(client.submit).toHaveBeenCalledWith(prepared.token, "approve", undefined);
  await act(async () => { finish({ intentId: "intent:1", status: "uncertain", receipt: null, error: null }); await result; });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status")).toBeInTheDocument();
});
it("does not expose source effects until the owner purpose is confirmed", () => {
  const c = card(); const client: WorkboardActionClient = { prepare: vi.fn(), submit: vi.fn(), reconcile: vi.fn() };
  const proposed = { ...c, purpose: { ...c.purpose, status: "proposed" as const } };
  const { container, rerender } = render(<WorkboardActionSlot card={proposed} client={client} fallback="source" />);
  expect(container.querySelector("[data-operation]")).toBeNull();
  rerender(<WorkboardActionSlot card={{ ...c, purpose: { ...c.purpose, status: "unknown" } }} client={client} fallback="source" />);
  expect(container.querySelector("[data-operation]")).toBeNull();
  expect(client.prepare).not.toHaveBeenCalled();
});
it("does not expose source effects when the observation is stale or the protocol is unavailable", () => {
  const c = card(); const client: WorkboardActionClient = { prepare: vi.fn(), submit: vi.fn(), reconcile: vi.fn() };
  const { container, rerender } = render(<WorkboardActionSlot card={{ ...c, freshness: "unconfirmed" }} client={client} fallback="source" />);
  expect(container.querySelector('[data-operation]')).toBeNull();
  rerender(<WorkboardActionSlot card={{ ...c, action_capability: undefined }} client={client} fallback="source" />);
  expect(container.querySelector('[data-operation]')).toBeNull();
  expect(client.prepare).not.toHaveBeenCalled();
});
it("extends the existing mutation client with the same CSRF boundary and exact body", async () => {
  const result: ActionResult = { intentId: "intent:1", status: "uncertain", receipt: null, error: null };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(result), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const csrf = "fixture-token-".repeat(3);
  const client = createAuthorityMutationClient(async () => ({ schema_version: 1, csrf_token: csrf }));
  expect(await client.workboardActions!.submit("token:1", "reject")).toEqual(result);
  const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/api/v1/workboard/actions/submit");
  expect(JSON.parse(String(init.body))).toEqual({ token: "token:1", operation: "reject" });
  expect(init.credentials).toBe("same-origin");
  expect(init.headers).toMatchObject({ "X-JARVIS-CSRF": csrf });
});
