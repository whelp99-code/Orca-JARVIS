import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";
import type { PersonalClient, TodayResponse } from "./personal-api.js";
import type { PersonalData, PersonalSnapshot } from "./personal-store.js";
import type { DecisionState } from "./personal-types.js";
import { unseenPortfolio } from "./portfolio-test-fixture.js";
import { TodayPage } from "./today-page.js";

const AT = "2026-08-28T12:10:00.000Z";
const today = { schema_version: 1, resource: "today", generated_at: AT, state: "ready",
  brief: { state: "ready", brief_id: "brief:1", generated_at: AT, item_count: 3 }, active_decision_count: 1,
  notification_summary: { total: 1, states: [{ state: "ready", count: 1 }] }, current_daily_run: null,
  last_daily_run: null, latest_verified_closeout: null,
  next_actions: [{ recommendation_id: "rec:1", rank: 1, title: "검증된 다음 작업을 안전하게 시작합니다", confidence_class: "high", expires_at: "2026-08-28T13:00:00.000Z", deep_link: "/recommendations/rec%3A1" }],
  conflicts: ["calendar and customer dates differ"], omissions: ["mail unavailable"],
  freshness: { state: "fresh", checked_at: AT, fresh_until: "2026-08-28T13:00:00.000Z" },
  deep_links: { decisions: "/api/v1/decision-inbox", daily_runs: "/api/v1/daily-runs", notifications: "/api/v1/notification-intents", source_health: "/api/v1/source-health" } } as const satisfies TodayResponse;
const data: PersonalData = { today,
  decisions: { schema_version: 1 as const, generated_at: AT, state: "ready" as const, items: [{ recommendation_id: "rec:1", context_id: "ctx:1", rank: 1,
    title: today.next_actions[0].title, state: "pending", confidence_class: "high", occurred_at: AT, expires_at: today.next_actions[0].expires_at,
    citations: [{ context_evidence_id: "evidence:1", digest: `sha256:${"a".repeat(64)}`, kind: "current", ref: "live:customer" }],
    deep_link: "/recommendations/rec%3A1?rank=1" }] },
  notifications: { schema_version: 1 as const, generated_at: AT, state: "ready" as const, items: [] },
  health: { schema_version: 1 as const, generated_at: AT, state: "ready" as const, items: [{ kind: "source" as const, identity: "calendar", state: "fresh", checked_at: AT }] } };
const overview = { schema_version: 1, generated_at: AT, cards: [], recent_tasks: [], pending_approvals: [], risks: [{ id: "risk:1", severity: "high", message: "capacity warning" }],
  agents: [{ agent_id: "agent:1", provider: "codex", terminal_id: "terminal:1", incarnation_id: "inc:1", canonical_path: "/repo", status: "live" }], portfolio: unseenPortfolio } as const satisfies OverviewResponse;

function client(accept = vi.fn()): PersonalClient {
  return { today: async () => today, decisions: async () => data.decisions, notifications: async () => data.notifications,
    health: async () => data.health, recommendation: async () => ({ schema_version: 1, recommendation_id: "rec:1", context_id: "ctx:1", confidence_class: "high",
      lifecycle_state: "eligible", expires_at: today.next_actions[0].expires_at, state: "ready", evidence: [], conflicts: [], omissions: [], context_evidence_link: "/api/v1/contexts/ctx%3A1/evidence?recommendation_id=rec%3A1" }),
    evidence: async () => ({ schema_version: 1, context_id: "ctx:1", recommendation_id: "rec:1", state: "ready", evidence: [], conflicts: [], omissions: [] }),
    accept: async (id, rank) => { await accept(id, rank); return { schema_version: 1, recommendation_id: id, action_rank: rank, request_id: "request:1", action: "workflow.start", state: "pending" }; } };
}

function snapshot(connectionState: "live" | "reconnecting" = "live"): PersonalSnapshot {
  return connectionState === "live" ? { status: "success", connectionState, data }
    : { status: "stale", connectionState, data, error: { kind: "offline", code: "OFFLINE", message: "Offline", request_id: "" } };
}

function decisionSnapshot(state: DecisionState, expiresAt = "2026-08-28T13:00:00.000Z"): PersonalSnapshot {
  const canonical = data.decisions.items[0];
  if (canonical === undefined) throw new TypeError("canonical decision expected");
  const decision = { ...canonical, state, expires_at: expiresAt };
  return { status: "success", connectionState: "live", data: {
    ...data, decisions: { ...data.decisions, items: [decision] },
  } };
}

describe("Task31 Today page", () => {
  it("shows expired brief summaries as stale with no current items", () => {
    const state: PersonalSnapshot = { status: "success", connectionState: "live", data: {
      ...data, today: { ...today, brief: { ...today.brief, state: "stale", item_count: 0 } },
    } };
    render(<TodayPage snapshot={state} overview={overview} approvals={[]} client={client()} onRefresh={() => undefined} />);
    expect(screen.getByText("stale / 0 items")).toBeInTheDocument();
  });
  it("renders all six semantic sections with freshness, notification, and closeout state", () => {
    render(<TodayPage snapshot={snapshot()} overview={overview} approvals={[]} client={client()} onRefresh={() => undefined} />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["NOW", "BLOCKED", "DECISIONS", "NEXT 3", "WORKERS", "RISKS"]);
    expect(screen.getByText("calendar and customer dates differ")).toBeInTheDocument();
    expect(screen.getByText("No verified closeout")).toBeInTheDocument();
    expect(screen.getByText("capacity warning")).toBeInTheDocument();
  });

  it.each<DecisionState>(["accepted", "rejected", "expired", "superseded"])(
    "fails closed for terminal decision state %s",
    (state) => {
      render(<TodayPage snapshot={decisionSnapshot(state)} overview={overview} approvals={[]}
        client={client()} onRefresh={() => undefined} />);
      expect(screen.getByRole("button", { name: "Accept action 1" })).toBeDisabled();
    },
  );

  it("fails closed at expiry and removes controls with the canonical snapshot action", () => {
    const view = render(<TodayPage snapshot={decisionSnapshot("pending", AT)} overview={overview}
      approvals={[]} client={client()} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "Accept action 1" })).toBeDisabled();
    const removed: PersonalSnapshot = { status: "success", connectionState: "live", data: { ...data,
      decisions: { ...data.decisions, items: [] } } };
    view.rerender(<TodayPage snapshot={removed} overview={overview} approvals={[]}
      client={client()} onRefresh={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Accept action 1" })).not.toBeInTheDocument();
  });

  it("stages once immediately and disables stale cached authority", async () => {
    const accept = vi.fn(); const user = userEvent.setup();
    const view = render(<TodayPage snapshot={snapshot()} overview={overview} approvals={[]} client={client(accept)} onRefresh={() => undefined} />);
    const button = screen.getByRole("button", { name: "Accept action 1" });
    await user.dblClick(button);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    view.rerender(<TodayPage snapshot={snapshot("reconnecting")} overview={overview} approvals={[]} client={client()} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "Accept action 1" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Cached data is not authoritative");

    view.unmount();
    render(<TodayPage snapshot={snapshot()} overview={overview} approvals={[]} client={client()}
      authorityConnected={false} onRefresh={() => undefined} />);
    expect(screen.getByRole("button", { name: "Accept action 1" })).toBeDisabled();
  });
});
