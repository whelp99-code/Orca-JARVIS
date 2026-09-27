import { afterEach, expect, it, vi } from "vitest";
import type { MemoryClient } from "./memory-api.js";
import { createMemoryStore, SEARCH_UNAVAILABLE_MESSAGE, STATUS_UNAVAILABLE_MESSAGE } from "./memory-store.js";
import type { MemorySearch, MemoryStatus } from "./memory-types.js";

afterEach(() => { vi.useRealTimers(); });
const t0 = Date.parse("2026-09-08T00:00:00Z");
let now = t0;
const status = (at: number, privacyEpoch = 0): MemoryStatus => ({ schema_version: 1, resource: "memory-status",
  state: "ready", privacy_epoch: privacyEpoch, checked_at: new Date(at).toISOString(),
  fresh_until: new Date(at + 60_000).toISOString(), contract_schema: 4, mutations_enabled: true });
const result = (at: number, state = "ready", privacyEpoch = 0): MemorySearch => ({ schema_version: 1,
  resource: "memory-search", state, generated_at: new Date(at).toISOString(), checked_at: new Date(at).toISOString(),
  fresh_until: new Date(at + 60_000).toISOString(), privacy_epoch: privacyEpoch, query_revision: "q",
  resource_revision: "r", provider_generation: null, truncated: false, omissions: state === "ready" ? [] : [state],
  items: state !== "ready" ? [] : [{ record_token: "token-one", record_revision: "revision-one",
    title: "Fixture title", excerpt: "Fixture body", citation: "Memory citation", sensitivity: "personal",
    retention: { source: "policy", days: 30, expires_at: new Date(at + 100_000).toISOString() },
    freshness: "fresh", provenance: { source_class: "memory", owner_class: "provider_owned",
      origin_label: "Fixture", origin_revision: "origin-one" }, conflict_state: "none", history_state: "current",
    superseded_by: null, history: [], actions: ["inspect", "correct", "forget", "export"] }] });

function fixture() {
  vi.useFakeTimers(); now = t0; vi.setSystemTime(now);
  const calls = { status: 0, conflicts: 0, search: 0 };
  const client = {
    status: async () => { calls.status += 1; return status(now); },
    search: async () => { calls.search += 1; return result(now); },
    conflicts: async () => { calls.conflicts += 1; return undefined; },
    candidates: async () => undefined, effects: async () => undefined, rememberProgress: async () => undefined,
  } as unknown as MemoryClient;
  const store = createMemoryStore({ client, clock: () => now, eventSourceFactory: () => ({
    onopen: null, onerror: null, addEventListener: () => {}, close: () => {}, removeEventListener: () => {} }) });
  const advance = (ms: number): void => { now += ms; vi.setSystemTime(now); vi.advanceTimersByTime(ms); };
  /** Start and drain the initial load through microtasks only; no timers, no wall clock. */
  const started = async (): Promise<void> => {
    store.start();
    for (let tick = 0; tick < 32 && store.getSnapshot().state !== "ready"; tick += 1) await Promise.resolve();
    expect(store.getSnapshot().state).toBe("ready");
  };
  return { store, client, calls, advance, started };
}

it("searches after the status freshness window by obtaining a fresh status without a full reload", async () => {
  // Given a loaded surface that has sat idle past its 60 s status freshness
  const { store, calls, advance, started } = fixture();
  await started();
  expect(calls).toEqual({ status: 1, conflicts: 1, search: 0 });
  advance(65_000);
  expect(store.getSnapshot().status?.state).toBe("stale");
  // When the owner searches
  await store.search("fixture");
  // Then a bounded status read was taken, the search succeeded, and nothing else reloaded
  const snapshot = store.getSnapshot();
  expect(snapshot.status?.state).toBe("ready");
  expect(snapshot.status?.fresh_until).toBe(new Date(now + 60_000).toISOString());
  expect(snapshot.search?.items).toHaveLength(1);
  expect(snapshot.message).toBeUndefined();
  expect(calls).toEqual({ status: 2, conflicts: 1, search: 1 });
  store.stop();
});

it("keeps rejecting a search whose privacy epoch differs from the fresh status", async () => {
  // Given an idle surface whose fresh status advanced the privacy epoch
  const { store, client, advance, started } = fixture();
  await started();
  advance(65_000);
  client.status = async () => status(now, 1);
  client.search = async () => result(now, "ready", 0);
  // When the owner searches and the provider answers for the old epoch
  await store.search("fixture");
  // Then the result is refused and announced, with the status now at the new epoch
  expect(store.getSnapshot().search).toBeUndefined();
  expect(store.getSnapshot().message).toContain("Memory changed or expired");
  expect(store.getSnapshot().status?.privacy_epoch).toBe(1);
  store.stop();
});

it("announces a failed status refresh instead of refusing silently", async () => {
  // Given an idle surface whose status route now fails
  const { store, client, calls, advance, started } = fixture();
  await started();
  advance(65_000);
  client.status = async () => { throw new Error("MEMORY_REQUEST_FAILED"); };
  // When the owner searches
  await store.search("fixture");
  // Then no search request left, the surface stayed up, and the failure was announced
  expect(calls.search).toBe(0);
  expect(store.getSnapshot().state).toBe("ready");
  expect(store.getSnapshot().message).toBe(STATUS_UNAVAILABLE_MESSAGE);
  store.stop();
});

it("retains an offline provider result so the surface can render it", async () => {
  // Given a fresh surface whose provider is offline
  const { store, client, started } = fixture();
  await started();
  client.search = async () => result(now, "offline");
  // When the owner searches
  await store.search("fixture");
  // Then the offline state is retained rather than dropped as an empty result
  expect(store.getSnapshot().search?.state).toBe("offline");
  expect(store.getSnapshot().search?.items).toEqual([]);
  store.stop();
});

it("announces a transport failure of the search without tearing down the surface", async () => {
  // Given a fresh surface whose search route fails
  const { store, client, started } = fixture();
  await started();
  client.search = async () => { throw new Error("MEMORY_REQUEST_FAILED"); };
  // When the owner searches
  await store.search("fixture");
  // Then the page stays ready and the status region carries the failure
  expect(store.getSnapshot().state).toBe("ready");
  expect(store.getSnapshot().message).toBe(SEARCH_UNAVAILABLE_MESSAGE);
  store.stop();
});

it("refreshes the current search across a same-epoch reload without a new selection generation", async () => {
  // Given a surface with results
  const { store, calls, started } = fixture();
  await started();
  await store.search("fixture");
  expect(store.getSnapshot().search?.items).toHaveLength(1);
  const generation = store.getSnapshot().search_revision;
  // When the surface reloads with an unchanged privacy epoch
  await store.load();
  // Then the results were re-read for fresh history and the owner selection generation held
  expect(store.getSnapshot().search?.items).toHaveLength(1);
  expect(calls).toEqual({ status: 2, conflicts: 2, search: 2 });
  expect(store.getSnapshot().search_revision).toBe(generation);
  store.stop();
});

it("drops search results when a reload lands on a new privacy epoch", async () => {
  // Given a surface with results
  const { store, client, started } = fixture();
  await started();
  await store.search("fixture");
  expect(store.getSnapshot().search?.items).toHaveLength(1);
  client.status = async () => status(now, 1);
  // When the surface reloads under a new privacy epoch
  await store.load();
  // Then the private results are gone
  expect(store.getSnapshot().search).toBeUndefined();
  expect(store.getSnapshot().status?.privacy_epoch).toBe(1);
  store.stop();
});
