import { classifyDashboardError, type ApiError } from "./api.js";
import { createCoalescedRefresh } from "./coalesced-refresh.js";
import type {
  DecisionItem,
  HealthItem,
  NotificationItem,
  PersonalClient,
  PersonalPage,
  TodayResponse,
} from "./personal-api.js";
import { advancesPersonalRevision, parsePersonalSseFrame, type PersonalSseRevision, type PersonalSseType } from "./personal-sse.js";
import type { ConnectionState, EventSourceLike } from "./store-types.js";

export type PersonalData = Readonly<{
  today: TodayResponse;
  decisions: PersonalPage<DecisionItem>;
  notifications: PersonalPage<NotificationItem>;
  health: PersonalPage<HealthItem>;
}>;
export type PersonalSnapshot =
  | { readonly status: "idle" | "loading"; readonly connectionState: ConnectionState }
  | { readonly status: "success"; readonly connectionState: ConnectionState; readonly data: PersonalData }
  | { readonly status: "stale"; readonly connectionState: "reconnecting" | "offline"; readonly data: PersonalData; readonly error: ApiError }
  | { readonly status: "error"; readonly connectionState: ConnectionState; readonly error: ApiError };
export type PersonalStore = ReturnType<typeof createPersonalStore>;

/** No `eventSourceFactory` means no live stream: the phone gateway proxies reads only. */
type Options = Readonly<{
  client: PersonalClient;
  eventSourceFactory?: (url: string) => EventSourceLike;
}>;

const PERSONAL_TOPICS = new Set([
  "personal.today.v1",
  "personal.recommendations.v1",
  "personal.context-evidence.v1",
  "personal.daily-runs.v1",
  "personal.decision-inbox.v1",
  "personal.notification-intents.v1",
  "personal.source-health.v1",
  "overview",
  "agents",
  "approvals", "memory.records.v1", "memory.conflicts.v1", "memory.candidates.v1",
  "memory.effects.v1", "memory.privacy.v1", "memory.status.v1",
]);

export function createPersonalStore(options: Options) {
  let snapshot: PersonalSnapshot = { status: "idle", connectionState: "offline" };
  let generation = 0;
  let loadSequence = 0;
  let running = false;
  let sourceOpen = false;
  let connectionFailure: ApiError | undefined;
  let serverRevision: PersonalSseRevision | undefined;
  let source: EventSourceLike | undefined;
  const listeners = new Set<() => void>();
  let reads = createReads(generation);

  function createReads(token: number) {
    return createCoalescedRefresh(signal => load(token, signal));
  }

  function getSnapshot(): PersonalSnapshot { return snapshot; }
  function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
  function assign(next: PersonalSnapshot): void { snapshot = next; for (const listener of listeners) listener(); }

  function start(): void {
    if (running) return;
    running = true;
    const token = generation;
    sourceOpen = false;
    connectionFailure = undefined;
    if (snapshot.status === "success" || snapshot.status === "stale") {
      assign({ status: "stale", connectionState: "reconnecting", data: snapshot.data,
        error: classifyDashboardError(new TypeError("offline")) });
    }
    source = options.eventSourceFactory?.("/api/v1/events");
    serverRevision = undefined;
    if (source === undefined) { void refresh(); return; }
    source.addEventListener("snapshot", (event) => { frame(token, "snapshot", event); });
    source.addEventListener("reconcile", (event) => { frame(token, "reconcile", event); });
    source.onopen = () => {
      if (token !== generation) return;
      sourceOpen = true;
      if (snapshot.status === "success" && connectionFailure === undefined) assign({ ...snapshot, connectionState: "live" });
    };
    source.onerror = () => {
      if (token !== generation) return;
      sourceOpen = false;
      loadSequence += 1;
      const error = classifyDashboardError(new TypeError("offline"));
      connectionFailure = error;
      if (snapshot.status === "success" || snapshot.status === "stale") {
        assign({ status: "stale", connectionState: "reconnecting", data: snapshot.data, error });
      } else {
        assign({ status: "error", connectionState: "reconnecting", error });
      }
    };
    void refresh();
  }

  function stop(): void {
    generation += 1;
    loadSequence += 1;
    reads.close();
    reads = createReads(generation);
    running = false;
    source?.close();
    source = undefined;
    sourceOpen = false;
    connectionFailure = undefined;
    serverRevision = undefined;
  }

  function refresh(): Promise<void> {
    loadSequence += 1;
    return reads.request();
  }

  function frame(token: number, eventType: PersonalSseType, event: Event): void {
    if (token !== generation) return;
    const parsed = parsePersonalSseFrame(eventType, event);
    if (parsed === undefined) {
      loadSequence += 1;
      const error = { kind: "server", code: "VALIDATION_ERROR", message: "Validation error", request_id: "" } as const;
      connectionFailure = error;
      if (snapshot.status === "success" || snapshot.status === "stale") {
        assign({ status: "stale", connectionState: "reconnecting", data: snapshot.data, error });
      } else {
        assign({ status: "error", connectionState: "reconnecting", error });
      }
      return;
    }
    if (!advancesPersonalRevision(serverRevision, parsed)) return;
    serverRevision = parsed.revision;
    if (parsed.topics.some((topic) => PERSONAL_TOPICS.has(topic))) {
      connectionFailure = undefined;
      if (parsed.topics.includes("memory.privacy.v1")) {
        // Remove cached text immediately; the running snapshot is invalidated before its continuation.
        assign({ status: "loading", connectionState: sourceOpen ? "live" : "reconnecting" });
      }
      void refresh();
    }
  }

  async function load(token: number, signal: AbortSignal): Promise<void> {
    if (token !== generation) return;
    const sequence = loadSequence;
    const prior = snapshot;
    if (prior.status !== "success" && prior.status !== "stale") {
      assign({ status: "loading", connectionState: prior.connectionState });
    }
    try {
      const [today, decisions, notifications, health] = await Promise.allSettled([
        options.client.today(signal),
        options.client.decisions(signal),
        options.client.notifications(signal),
        options.client.health(signal),
      ]);
      if (token !== generation || sequence !== loadSequence) return;
      const data = { today: readResult(today), decisions: readResult(decisions),
        notifications: readResult(notifications), health: readResult(health) };
      if (connectionFailure !== undefined) {
        assign({ status: "stale", connectionState: "reconnecting", data, error: connectionFailure });
        return;
      }
      assign({
        status: "success",
        connectionState: source === undefined ? "offline" : sourceOpen ? "live" : "reconnecting",
        data,
      });
    } catch (error: unknown) {
      if (token !== generation || sequence !== loadSequence) return;
      if (!(error instanceof Error)) throw error;
      const classified = classifyDashboardError(error);
      if (prior.status === "success" || prior.status === "stale") {
        assign({ status: "stale", connectionState: classified.kind === "offline" ? "offline" : "reconnecting", data: prior.data, error: classified });
      } else {
        assign({ status: "error", connectionState: classified.kind === "offline" ? "offline" : "reconnecting", error: classified });
      }
    }
  }

  return { getSnapshot, subscribe, start, stop, refresh };
}

function readResult<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
