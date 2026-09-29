import { advancesPersonalRevision, parsePersonalSseFrame,
  type PersonalSseRevision, type PersonalSseType } from "./personal-sse.js";
import type { MemoryClient } from "./memory-api.js";
import type { MemorySnapshot, MemoryStatus } from "./memory-types.js";
import type { EventSourceLike } from "./store-types.js";
import type { DashboardSurface } from "./surface.js";

const MEMORY_TOPICS = new Set(["memory.records.v1", "memory.conflicts.v1", "memory.candidates.v1",
  "memory.effects.v1", "memory.privacy.v1", "memory.status.v1"]);
export const STATUS_UNAVAILABLE_MESSAGE = "Memory status unavailable. Try again.";
export const RELOAD_FAILED_MESSAGE = "Memory panels could not be reloaded. Use Refresh memory.";
export const SEARCH_UNAVAILABLE_MESSAGE = "Search unavailable. Try again.";
export const SEARCH_CHANGED_MESSAGE = "Memory changed or expired. Search again.";
/** No `eventSourceFactory` means no live stream: the phone gateway proxies reads only. */
type Options = { readonly client: MemoryClient; readonly eventSourceFactory?: (url: string) => EventSourceLike;
  readonly clock?: () => number; readonly surface?: DashboardSurface };
export type MemoryStore = ReturnType<typeof createMemoryStore>;
export function createMemoryStore(options: Options) {
  let snapshot: MemorySnapshot = { state: "loading" };
  let epoch = 0; let lifecycle = 0; let running = false;
  let clearRevision = 0; let searchRevision = 0;
  /** Last owner query, held in memory only so a same-epoch reload can refresh results and history. */
  let lastQuery: string | undefined;
  let active: AbortController | undefined; let activeLoad: AbortController | undefined;
  let activeReview: AbortController | undefined;
  let source: EventSourceLike | undefined; let serverRevision: PersonalSseRevision | undefined;
  let freshTimer: ReturnType<typeof setTimeout> | undefined;
  let reviewTimer: ReturnType<typeof setTimeout> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>(); const clock = options.clock ?? Date.now;
  const phone = options.surface === "phone";
  const assign = (value: MemorySnapshot): void => {
    snapshot = { ...value, view_revision: epoch, clear_revision: clearRevision, search_revision: searchRevision };
    for (const listener of listeners) listener();
  };
  const fresh = (status: MemoryStatus | undefined): boolean =>
    status !== undefined && status.state !== "stale" && Date.parse(status.fresh_until) > clock();
  function scheduleFreshness(status: MemoryStatus): void {
    if (freshTimer !== undefined) clearTimeout(freshTimer);
    const token = lifecycle; const delay = Math.max(0, Date.parse(status.fresh_until) - clock());
    freshTimer = setTimeout(() => {
      if (token !== lifecycle || snapshot.status === undefined) return;
      clearPrivate();
      assign({ ...snapshot, state: "ready", status: { ...snapshot.status,
        state: "stale", mutations_enabled: false } });
    }, delay);
  }
  /**
   * The fresh read token every search is checked against. An expired status means every panel was
   * cleared with it, so freshness is restored by re-reading the whole surface, never status alone.
   */
  async function ensureFreshStatus(): Promise<MemoryStatus | undefined> {
    const previous = snapshot.status;
    if (fresh(previous)) return previous;
    const token = lifecycle;
    await load();
    if (token !== lifecycle) return undefined;
    const status = snapshot.status;
    if (snapshot.state === "ready" && snapshot.message === undefined && fresh(status)) return status;
    if (snapshot.state === "ready") assign({ ...snapshot, message: STATUS_UNAVAILABLE_MESSAGE });
    return undefined;
  }
  async function load(): Promise<void> {
    activeReview?.abort(); activeReview = undefined;
    if (reviewTimer !== undefined) clearTimeout(reviewTimer);
    assign({ ...snapshot, review: undefined, reviewMessage: undefined, reloading: true });
    activeLoad?.abort(); const controller = new AbortController(); activeLoad = controller;
    const generation = ++epoch;
    try {
      // The gateway exposes status, conflicts and search only; candidate and effect panels stay unread.
      const [status, conflicts, candidates, effects, progress] = await Promise.all([
        options.client.status(), options.client.conflicts(controller.signal),
        phone ? undefined : options.client.candidates(), phone ? undefined : options.client.effects(),
        phone ? undefined : options.client.rememberProgress()]);
      if (generation !== epoch || controller.signal.aborted) return;
      const sameEpoch = snapshot.status?.privacy_epoch === status.privacy_epoch;
      if (!sameEpoch && snapshot.search !== undefined) clearRevision += 1;
      const query = sameEpoch ? lastQuery : undefined; lastQuery = query;
      assign({ state: "ready", status, conflicts, candidates, effects, progress,
        search: query === undefined ? undefined : snapshot.search }); scheduleFreshness(status);
      if (query !== undefined) await run(query, false);
    } catch (error) {
      if (generation !== epoch || controller.signal.aborted) return;
      if (snapshot.status === undefined) {
        assign({ state: "error", message: error instanceof Error ? error.message : "Memory unavailable" }); return;
      }
      // A surface that was already up stays up; its panels are explicitly not loaded, never "none".
      assign({ ...snapshot, conflicts: undefined, candidates: undefined, effects: undefined, progress: undefined,
        reloading: false, message: RELOAD_FAILED_MESSAGE });
    } finally { if (activeLoad === controller) activeLoad = undefined; }
  }
  /** An owner-initiated search: a new selection generation for the page. */
  async function search(query: string): Promise<void> {
    searchRevision += 1;
    await run(query);
  }
  /** `reload` is false inside a reload: the surface takes the status it just read rather than re-entering. */
  async function run(query: string, reload = true): Promise<void> {
    const status = reload ? await ensureFreshStatus() : fresh(snapshot.status) ? snapshot.status : undefined;
    if (status === undefined) return;
    lastQuery = query;
    active?.abort(); const controller = new AbortController(); active = controller; const generation = ++epoch;
    if (searchTimer !== undefined) clearTimeout(searchTimer); searchTimer = undefined;
    assign({ ...snapshot, search: undefined, message: undefined });
    try {
      const search = await options.client.search(query, controller.signal);
      if (generation !== epoch || controller.signal.aborted) return;
      const remaining = Date.parse(search.fresh_until) - clock();
      if (!fresh(snapshot.status) || search.privacy_epoch !== snapshot.status?.privacy_epoch
        || !Number.isFinite(remaining) || remaining <= 0) {
        clearPrivate();
        assign({ ...snapshot, message: SEARCH_CHANGED_MESSAGE });
        return;
      }
      assign({ ...snapshot, state: "ready", search });
      searchTimer = setTimeout(() => {
        if (snapshot.search === search) clearPrivate();
      }, Math.min(remaining, 60_000));
    } catch {
      if (controller.signal.aborted || generation !== epoch) return;
      clearPrivate();
      assign({ ...snapshot, message: SEARCH_UNAVAILABLE_MESSAGE });
    }
  }
  function clearPrivate(): void {
    clearRevision += 1; searchRevision += 1; lastQuery = undefined;
    if (searchTimer !== undefined) clearTimeout(searchTimer); searchTimer = undefined;
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
    source = options.eventSourceFactory?.("/api/v1/events");
    source?.addEventListener("snapshot", event => { void frame(token, "snapshot", event); });
    source?.addEventListener("reconcile", event => { void frame(token, "reconcile", event); });
    void load();
  }
  function stop(): void {
    running = false; lifecycle += 1; source?.close(); source = undefined; serverRevision = undefined;
    clearPrivate(); if (freshTimer !== undefined) clearTimeout(freshTimer); freshTimer = undefined;
  }
  return { getSnapshot: () => snapshot, subscribe(listener: () => void) { listeners.add(listener);
    return () => { listeners.delete(listener); }; }, start, stop, load, search, review, clearPrivate };
}
