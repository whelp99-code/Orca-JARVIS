import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryPage } from "./memory-page.js";
import { createMemoryStore } from "./memory-store.js";
import { MemoryRequestError, type MemoryClient } from "./memory-api.js";
import type { MemorySearch } from "./memory-types.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const now = Date.parse("2026-09-08T00:00:00Z");
const result: MemorySearch = { schema_version: 1, resource: "memory-search", state: "ready",
  generated_at: new Date(now).toISOString(), checked_at: new Date(now).toISOString(),
  fresh_until: new Date(now + 10_000).toISOString(), privacy_epoch: 0,
  query_revision: "query-one", resource_revision: "resource-one", provider_generation: "generation-one",
  truncated: false, omissions: [], items: [{ record_token: "token-one", record_revision: "revision-one",
    title: "Private fixture title", excerpt: "Private fixture body", citation: "Memory citation", sensitivity: "personal",
    retention: { source: "policy", days: 30, expires_at: new Date(now + 100_000).toISOString() },
    freshness: "fresh", provenance: { source_class: "memory", owner_class: "provider_owned",
      origin_label: "Fixture", origin_revision: "origin-one" }, conflict_state: "none", history_state: "current",
    superseded_by: null, history: [], actions: ["inspect", "correct", "forget", "export"] }] };

async function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const client = { status: async () => ({ schema_version: 1, resource: "memory-status", state: "ready",
    privacy_epoch: 0, checked_at: new Date(now).toISOString(), fresh_until: new Date(now + 60_000).toISOString(),
    contract_schema: 4, mutations_enabled: true }), search: async () => result,
    conflicts: async () => undefined, candidates: async () => undefined, effects: async () => undefined,
    rememberProgress: async () => undefined } as unknown as MemoryClient;
  const events = new Map<string, (event: Event) => void>();
  const store = createMemoryStore({ client, eventSourceFactory: () => ({
    onopen: null, onerror: null,
    addEventListener: (name, listener) => { events.set(name, listener); }, close: () => {}, removeEventListener: () => {},
  }) });
  await act(async () => { render(<MemoryPage store={store} client={client} />); });
  fireEvent.change(screen.getByLabelText("기억 검색"), { target: { value: "Private query fixture" } });
  await act(async () => { await store.search("fixture"); });
  fireEvent.click(screen.getByRole("button", { name: /Private fixture title/ }));
  fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "Private correction draft" } });
  fireEvent.click(screen.getByRole("checkbox"));
  return { store, client, events };
}

it("removes selected detail and draft when private results are cleared", async () => {
  const { store } = await fixture();
  act(() => store.clearPrivate());
  expect(document.body.textContent).not.toContain("Private fixture");
  expect(screen.queryByDisplayValue("Private correction draft")).not.toBeInTheDocument();
  expect(screen.getByLabelText("기억 검색")).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Stage forgetting" })).not.toBeInTheDocument();
  act(() => store.stop());
});

it("retires a staging announcement with its search generation so expiry is announced", async () => {
  // Given a staged forget whose outcome is announced in the atomic status region
  const { store, client } = await fixture();
  client.forget = async () => ({ schema_version: 1, state: "pending_approval", request_id: "request-one",
    action: "forget", message: "staged" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stage forgetting" })); });
  expect(document.querySelector("p.memory-status")).toHaveTextContent("Pending owner approval");
  // When the status freshness window lapses and clears that generation
  await act(async () => { vi.advanceTimersByTime(60_000); });
  // Then the region announces the expiry instead of the announcement it has outlived
  expect(document.body.textContent).toContain("Memory status expired");
  expect(document.body.textContent).not.toContain("Pending owner approval");
  act(() => store.stop());
});

it("drops the stale rows a rejected command just proved out of date", async () => {
  // Given a staged forget the provider rejects because the record moved under us
  const { store, client } = await fixture();
  client.forget = async () => { throw new MemoryRequestError("MEMORY_SELECTION_STALE", 409); };
  let reloads = 0;
  const status = await client.status();
  client.status = async () => { reloads += 1; return status; };
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stage forgetting" })); });
  // Then the record it was acting on is no longer listed with its excerpt, and the surface is re-read
  expect(document.body.textContent).not.toContain("Private fixture body");
  expect(store.getSnapshot().search).toBeUndefined();
  expect(reloads).toBe(1);
  // And the owner is still told why, rather than the rejection being swallowed by the clear
  expect(document.querySelector("p.memory-status"))
    .toHaveTextContent("This record changed since it was loaded");
  act(() => store.stop());
});

it("expires search results and selection at their own freshness deadline", async () => {
  const { store } = await fixture();
  act(() => vi.advanceTimersByTime(10_000));
  expect(store.getSnapshot().search).toBeUndefined();
  expect(document.body.textContent).not.toContain("Private fixture");
  expect(screen.queryByDisplayValue("Private correction draft")).not.toBeInTheDocument();
  act(() => store.stop());
});

it("rejects a search result from a different privacy epoch", async () => {
  const { store, client } = await fixture();
  client.search = async () => ({ ...result, privacy_epoch: 1 });
  await act(async () => { await store.search("fixture again"); });
  expect(store.getSnapshot().search).toBeUndefined();
  expect(document.body.textContent).not.toContain("Private fixture");
  expect(store.getSnapshot().message).toContain("Memory changed or expired");
  client.search = async () => result;
  await act(async () => { await store.search("current"); });
  expect(store.getSnapshot().message).toBeUndefined();
  expect(store.getSnapshot().search).toBe(result);
  act(() => store.stop());
});

it("does not repopulate a late search after status freshness expires", async () => {
  const { store, client } = await fixture();
  let resolve!: (value: MemorySearch) => void;
  client.search = () => new Promise(done => { resolve = done; });
  let pending!: Promise<void>;
  await act(async () => { pending = store.search("late"); });
  act(() => vi.advanceTimersByTime(60_000));
  await act(async () => {
    resolve({ ...result, fresh_until: new Date(now + 120_000).toISOString() }); await pending;
  });
  expect(store.getSnapshot().status?.state).toBe("stale");
  expect(store.getSnapshot().search).toBeUndefined();
  expect(document.body.textContent).not.toContain("Private fixture");
  act(() => store.stop());
});

it("ignores an old action when a batched new search reuses the same object and token", async () => {
  const { store, client } = await fixture();
  let resolve!: (value: unknown) => void;
  client.forget = () => new Promise(done => { resolve = done; });
  fireEvent.click(screen.getByRole("button", { name: "Stage forgetting" }));
  await act(async () => { await store.search("same result"); });
  fireEvent.click(screen.getByRole("button", { name: /Private fixture title/ }));
  await act(async () => { resolve({ state: "pending_approval" }); });
  expect(store.getSnapshot().search).toBe(result);
  expect(screen.queryByText("Pending owner approval")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Replacement")).toHaveValue("");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  act(() => store.stop());
});


it("clears a private SSE view before its replacement load completes", async () => {
  const { store, client, events } = await fixture();
  const status = await client.status();
  let resolve!: (value: typeof status) => void;
  client.status = () => new Promise(done => { resolve = done; });
  act(() => events.get("snapshot")!(new MessageEvent("snapshot", { data: JSON.stringify({
    schema_version: 1, type: "snapshot", revision: "12345678-1234-4234-8234-123456789abc:1",
    topics: ["memory.privacy.v1"], occurred_at: new Date(now).toISOString(),
  }) })));
  expect(store.getSnapshot().search).toBeUndefined();
  expect(screen.queryByDisplayValue("Private correction draft")).not.toBeInTheDocument();
  expect(screen.getByLabelText("기억 검색")).toHaveValue("");
  await act(async () => { resolve({ ...status, privacy_epoch: 1 }); });
  expect(store.getSnapshot().status?.privacy_epoch).toBe(1);
  expect(document.body.textContent).not.toContain("Private fixture");
  act(() => store.stop());
});
