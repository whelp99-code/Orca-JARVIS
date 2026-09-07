import { advancesPersonalRevision, parsePersonalSseFrame,
  type PersonalSseRevision, type PersonalSseType } from "./personal-sse.js";
import type { MemoryClient } from "./memory-api.js";
import type { MemorySnapshot, MemoryStatus } from "./memory-types.js";
import type { EventSourceLike } from "./store-types.js";

const MEMORY_TOPICS = new Set(["memory.records.v1", "memory.conflicts.v1", "memory.candidates.v1",
  "memory.effects.v1", "memory.privacy.v1", "memory.status.v1"]);
type Options = { readonly client: MemoryClient; readonly eventSourceFactory: (url: string) => EventSourceLike;
  readonly clock?: () => number };
export type MemoryStore = ReturnType<typeof createMemoryStore>;
export function createMemoryStore(options: Options) {
  let snapshot: MemorySnapshot = { state: "loading" };
  let epoch = 0; let lifecycle = 0; let running = false;
  let active: AbortController | undefined; let activeLoad: AbortController | undefined;
  let activeReview: AbortController | undefined;
  let source: EventSourceLike | undefined; let serverRevision: PersonalSseRevision | undefined;
  let freshTimer: ReturnType<typeof setTimeout> | undefined;
  let reviewTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>(); const clock = options.clock ?? Date.now;
  const assign = (value: MemorySnapshot): void => { snapshot = value; for (const listener of listeners) listener(); };
  function scheduleFreshness(status: MemoryStatus): void {
    if (freshTimer !== undefined) clearTimeout(freshTimer);
    const token = lifecycle; const delay = Math.max(0, Date.parse(status.fresh_until) - clock());
    freshTimer = setTimeout(() => {
      if (token !== lifecycle || snapshot.status === undefined) return;
      assign({ ...snapshot, state: "ready", status: { ...snapshot.status,
        state: "stale", mutations_enabled: false } });
    }, delay);
  }
  async function load(): Promise<void> {
    activeReview?.abort(); activeReview = undefined;
    if (reviewTimer !== undefined) clearTimeout(reviewTimer);
    assign({ ...snapshot, review: undefined, reviewMessage: undefined });
    activeLoad?.abort(); const controller = new AbortController(); activeLoad = controller;
    const generation = ++epoch;
    try {
      const [status, conflicts, candidates, effects, progress] = await Promise.all([
        options.client.status(), options.client.conflicts(controller.signal),
        options.client.candidates(), options.client.effects(), options.client.rememberProgress()]);
      if (generation !== epoch || controller.signal.aborted) return;
      assign({ state: "ready", status, conflicts, candidates, effects, progress }); scheduleFreshness(status);
    } catch (error) {
      if (generation !== epoch || controller.signal.aborted) return;
      assign({ state: "error", message: error instanceof Error ? error.message : "Memory unavailable" });
    } finally { if (activeLoad === controller) activeLoad = undefined; }
  }
  async function search(query: string): Promise<void> {
    active?.abort(); const controller = new AbortController(); active = controller; const generation = ++epoch;
    try {
      const search = await options.client.search(query, controller.signal);
      if (generation !== epoch || controller.signal.aborted) return;
      assign({ ...snapshot, state: "ready", search });
    } catch (error) {
      if (controller.signal.aborted || generation !== epoch) return;
      assign({ ...snapshot, state: "error", message: error instanceof Error ? error.message : "Search unavailable" });
    }
  }
  function clearPrivate(): void {
    activeReview?.abort(); activeReview = undefined;
    if (reviewTimer !== undefined) clearTimeout(reviewTimer); reviewTimer = undefined;
    epoch += 1; active?.abort(); active = undefined; activeLoad?.abort(); activeLoad = undefined;
    assign(snapshot.status === undefined ? { state: "loading" } : { state: "ready", status: snapshot.status });
  }
  async function review(candidateId: string): Promise<void> {
    activeReview?.abort(); const controller = new AbortController(); activeReview = controller;
    assign({ ...snapshot, review: undefined, reviewMessage: "Loading candidate review" });
    try {
      const detail = await options.client.candidate(candidateId, controller.signal);
      if (controller.signal.aborted || activeReview !== controller) return;
      assign({ ...snapshot, review: detail, reviewMessage: undefined });
      if (reviewTimer !== undefined) clearTimeout(reviewTimer);
      reviewTimer = setTimeout(() => {
        if (snapshot.review === detail) assign({ ...snapshot, review: undefined, reviewMessage: "Candidate review expired." });
      }, Math.max(0, Date.parse(detail.expires_at) - clock()));
    } catch {
      if (!controller.signal.aborted && activeReview === controller) {
        assign({ ...snapshot, review: undefined, reviewMessage: "Candidate review unavailable. Refresh and try again." });
      }
    } finally { if (activeReview === controller) activeReview = undefined; }
  }
  async function frame(token: number, type: PersonalSseType, event: Event): Promise<void> {
    if (token !== lifecycle) return;
    const parsed = parsePersonalSseFrame(type, event);
    if (parsed === undefined || !advancesPersonalRevision(serverRevision, parsed)) return;
    serverRevision = parsed.revision;
    if (parsed.topics.includes("memory.privacy.v1")) clearPrivate();
    if (parsed.topics.some(topic => MEMORY_TOPICS.has(topic))) await load();
  }
  function start(): void {
    if (running) return; running = true; const token = ++lifecycle; serverRevision = undefined;
    source = options.eventSourceFactory("/api/v1/events");
    source.addEventListener("snapshot", event => { void frame(token, "snapshot", event); });
    source.addEventListener("reconcile", event => { void frame(token, "reconcile", event); });
    void load();
  }
  function stop(): void {
    running = false; lifecycle += 1; source?.close(); source = undefined; serverRevision = undefined;
    clearPrivate(); if (freshTimer !== undefined) clearTimeout(freshTimer); freshTimer = undefined;
  }
  return { getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener);
    return () => { listeners.delete(listener); }; }, start, stop, load, search, review, clearPrivate };
}
