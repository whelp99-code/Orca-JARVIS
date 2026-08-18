import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";
import App from "./app.js";
import "./styles.css";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly overview: OverviewResponse }
  | { readonly kind: "error" };

const OVERVIEW_ENDPOINT = "/api/v1/overview";

class DashboardInitializationError extends Error {
  readonly name = "DashboardInitializationError";

  constructor(readonly reason: "missing-root" | "unexpected-load-state") {
    super(reason);
  }
}

function OverviewRoot() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function loadOverview(): Promise<void> {
      try {
        const response = await fetch(OVERVIEW_ENDPOINT, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          setState({ kind: "error" });
          return;
        }

        const value: unknown = await response.json();
        if (!isOverviewResponse(value)) {
          setState({ kind: "error" });
          return;
        }
        if (!controller.signal.aborted) setState({ kind: "ready", overview: value });
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) setState({ kind: "error" });
      }
    }

    void loadOverview();
    return () => controller.abort();
  }, []);

  switch (state.kind) {
    case "loading":
      return (
        <main className="load-state" aria-busy="true" aria-live="polite">
          <h1>JARVIS Control Center</h1>
          <p>Loading overview</p>
        </main>
      );
    case "ready":
      return <App overview={state.overview} connectionState="live" />;
    case "error":
      return (
        <main className="load-state">
          <section role="alert" aria-labelledby="load-error-title">
            <h1 id="load-error-title">JARVIS Control Center</h1>
            <p className="load-error">Unable to load overview</p>
            <p>Refresh the page to retry.</p>
          </section>
        </main>
      );
    default:
      return assertNever(state);
  }
}

function isOverviewResponse(value: unknown): value is OverviewResponse {
  return (
    isRecord(value) &&
    value.schema_version === 1 &&
    typeof value.generated_at === "string" &&
    isArrayOf(value.cards, isOverviewCard) &&
    isArrayOf(value.recent_tasks, isOverviewTask) &&
    isArrayOf(value.pending_approvals, isOverviewApproval) &&
    isArrayOf(value.risks, isOverviewRisk) &&
    isArrayOf(value.agents, isOverviewAgent)
  );
}

function isOverviewCard(value: unknown): value is OverviewResponse["cards"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    typeof value.value === "number" &&
    typeof value.detail === "string"
  );
}

function isOverviewTask(value: unknown): value is OverviewResponse["recent_tasks"][number] {
  return (
    isRecord(value) &&
    typeof value.task_id === "string" &&
    typeof value.title === "string" &&
    isTaskKind(value.kind) &&
    typeof value.state === "string" &&
    typeof value.updated_at === "string" &&
    typeof value.pending_approval === "boolean" &&
    isStringArray(value.source_ids)
  );
}

function isOverviewApproval(value: unknown): value is OverviewResponse["pending_approvals"][number] {
  return (
    isRecord(value) &&
    typeof value.request_id === "string" &&
    typeof value.action === "string" &&
    isActionLevel(value.action_level) &&
    typeof value.requested_at === "string" &&
    typeof value.requested_by === "string" &&
    typeof value.summary === "string" &&
    typeof value.state === "string"
  );
}

function isOverviewRisk(value: unknown): value is OverviewResponse["risks"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.severity === "string" &&
    typeof value.message === "string"
  );
}

function isOverviewAgent(value: unknown): value is OverviewResponse["agents"][number] {
  return (
    isRecord(value) &&
    typeof value.agent_id === "string" &&
    typeof value.provider === "string" &&
    typeof value.terminal_id === "string" &&
    typeof value.incarnation_id === "string" &&
    typeof value.canonical_path === "string" &&
    typeof value.status === "string"
  );
}

function isTaskKind(value: unknown): value is OverviewResponse["recent_tasks"][number]["kind"] {
  return value === "work" || value === "command" || value === "workflow" || value === "agent";
}

function isActionLevel(value: unknown): value is OverviewResponse["pending_approvals"][number]["action_level"] {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isArrayOf<T>(value: unknown, predicate: (item: unknown) => item is T): value is readonly T[] {
  return Array.isArray(value) && value.every((item: unknown) => predicate(item));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function assertNever(value: never): never {
  void value;
  throw new DashboardInitializationError("unexpected-load-state");
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new DashboardInitializationError("missing-root");
createRoot(rootElement).render(<OverviewRoot />);
