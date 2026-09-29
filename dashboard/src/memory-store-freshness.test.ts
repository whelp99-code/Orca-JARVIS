import { afterEach, expect, it, vi } from "vitest";
import type { MemoryClient } from "./memory-api.js";
import { createMemoryStore, RELOAD_FAILED_MESSAGE, SEARCH_UNAVAILABLE_MESSAGE, STATUS_UNAVAILABLE_MESSAGE } from "./memory-store.js";
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
  const panel = (resource: string) => ({ schema_version: 1, resource, generated_at: new Date(now).toISOString(),
    state: "ready", privacy_epoch: 0, items: [], truncated: false, page: { limit: 20, returned: 0, has_more: false, next_cursor: null } });
  const client = {
    status: async () => { calls.status += 1; return status(now); },
    search: async () => { calls.search += 1; return result(now); },
    conflicts: async () => { calls.conflicts += 1; return panel("memory-conflicts"); },
    candidates: async () => panel("memory-candidates"), effects: async () => panel("memory-effects"),
    rememberProgress: async () => ({ schema_version: 1, resource: "memory-remember-progress",
      generated_at: new Date(now).toISOString(), has_more: false, items: [] }),
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

it("searches after the status freshness window by re-reading the whole surface, never a page reload", async () => {
  // Given a loaded surface that has sat idle past its 60 s status freshness
  const { store, calls, advance, started } = fixture();
  await started();
  expect(calls).toEqual({ status: 1, conflicts: 1, search: 0 });
  advance(65_000);
  const expired = store.getSnapshot();
  expect(expired.status?.state).toBe("stale");
  expect(expired.conflicts).toBeUndefined();
  expect(expired.reloading).not.toBe(true);
  // When the owner searches
  await store.search("fixture");
  // Then the status, every panel, and the results are current again
  const snapshot = store.getSnapshot();
  expect(snapshot.status?.state).toBe("ready");
  expect(snapshot.status?.fresh_until).toBe(new Date(now + 60_000).toISOString());
  expect(snapshot.search?.items).toHaveLength(1);
  expect(snapshot.conflicts?.resource).toBe("memory-conflicts");
  expect(snapshot.candidates?.resource).toBe("memory-candidates");
  expect(snapshot.effects?.resource).toBe("memory-effects");
  expect(snapshot.message).toBeUndefined();
  expect(calls).toEqual({ status: 2, conflicts: 2, search: 1 });
  store.stop();
});

it("keeps the surface and marks panels not loaded when a reload fails after the first load", async () => {
  // Given a loaded surface whose next reload fails
  const { store, client, started } = fixture();
  await started();
  client.conflicts = async () => { throw new Error("MEMORY_REQUEST_FAILED"); };
  // When the surface reloads
  await store.load();
  // Then the page stays up with its status, the panels are explicitly not loaded, and the failure is announced
  const snapshot = store.getSnapshot();
  expect(snapshot.state).toBe("ready");
  expect(snapshot.status).toBeDefined();
  expect(snapshot.conflicts).toBeUndefined();
  expect(snapshot.candidates).toBeUndefined();
  expect(snapshot.reloading).not.toBe(true);
  expect(snapshot.message).toBe(RELOAD_FAILED_MESSAGE);
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
  expect(store.getSnapshot().status?.state).toBe("stale");
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

it("reads the surface a bounded number of times when the provider itself reports a stale status", async () => {
  // Given a surface with results whose status route now answers with an already-expired status
  const { store, client, calls, started } = fixture();
  await started();
  await store.search("fixture");
  client.status = async () => {
    calls.status += 1;
    if (calls.status > 8) throw new Error("MEMORY_REQUEST_FAILED");
    return { ...status(now), state: "stale", mutations_enabled: false };
  };
  calls.status = 0;
  // When the surface reloads, as an SSE frame or Refresh memory does
  await store.load();
  // Then the reload read the status once and did not re-enter itself to chase freshness
  expect(calls.status).toBe(1);
  expect(store.getSnapshot().state).toBe("ready");
  expect(store.getSnapshot().status?.state).toBe("stale");
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
