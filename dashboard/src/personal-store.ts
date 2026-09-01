import { classifyDashboardError, type ApiError } from "./api.js";
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

type Options = Readonly<{
  client: PersonalClient;
  eventSourceFactory: (url: string) => EventSourceLike;
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
  let serverRevision: PersonalSseRevision | undefined;
  let source: EventSourceLike | undefined;
  const listeners = new Set<() => void>();

  function getSnapshot(): PersonalSnapshot { return snapshot; }
  function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
  function assign(next: PersonalSnapshot): void { snapshot = next; for (const listener of listeners) listener(); }

  function start(): void {
    if (running) return;
    running = true;
    const token = generation;
    source = options.eventSourceFactory("/api/v1/events");
    serverRevision = undefined;
    source.addEventListener("snapshot", (event) => { void frame(token, "snapshot", event); });
    source.addEventListener("reconcile", (event) => { void frame(token, "reconcile", event); });
    source.onopen = () => {
      if (token !== generation) return;
      sourceOpen = true;
      if (snapshot.status === "success") assign({ ...snapshot, connectionState: "live" });
    };
    source.onerror = () => {
      if (token !== generation) return;
      sourceOpen = false;
      const error = classifyDashboardError(new TypeError("offline"));
      if (snapshot.status === "success" || snapshot.status === "stale") {
        assign({ status: "stale", connectionState: "reconnecting", data: snapshot.data, error });
      } else {
        assign({ status: "error", connectionState: "reconnecting", error });
      }
    };
    void load(token);
  }

  function stop(): void {
    generation += 1;
    running = false;
    source?.close();
    source = undefined;
    sourceOpen = false;
    serverRevision = undefined;
  }

  async function refresh(): Promise<void> { await load(generation); }

  async function frame(token: number, eventType: PersonalSseType, event: Event): Promise<void> {
    if (token !== generation) return;
    const parsed = parsePersonalSseFrame(eventType, event);
    if (parsed === undefined) {
      const error = { kind: "server", code: "VALIDATION_ERROR", message: "Validation error", request_id: "" } as const;
      if (snapshot.status === "success" || snapshot.status === "stale") {
        assign({ status: "stale", connectionState: "reconnecting", data: snapshot.data, error });
      } else {
        assign({ status: "error", connectionState: "reconnecting", error });
      }
      return;
    }
    if (!advancesPersonalRevision(serverRevision, parsed)) return;
    serverRevision = parsed.revision;
    if (parsed.topics.some((topic) => PERSONAL_TOPICS.has(topic))) await load(token);
  }

  async function load(token: number): Promise<void> {
    if (token !== generation) return;
    loadSequence += 1;
    const sequence = loadSequence;
    const prior = snapshot;
    if (prior.status !== "success" && prior.status !== "stale") {
      assign({ status: "loading", connectionState: prior.connectionState });
    }
    try {
      const [today, decisions, notifications, health] = await Promise.all([
        options.client.today(),
        options.client.decisions(),
        options.client.notifications(),
        options.client.health(),
      ]);
      if (token !== generation || sequence !== loadSequence) return;
      assign({
        status: "success",
        connectionState: source === undefined ? "offline" : sourceOpen ? "live" : "reconnecting",
        data: { today, decisions, notifications, health },
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
