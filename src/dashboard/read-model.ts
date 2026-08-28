import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { ControlPlane, type ActionLevel, type StoredControlCommand } from "../control-plane.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { LiveSupervisor, type LiveBinding } from "../live-supervisor.js";
import { buildCurrentState } from "../state-projection.js";
import { TaskTimeline, type TaskTimelineEvent, type TaskTimelineSummary } from "../task-timeline.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { invalidClockOverview } from "./invalid-clock-overview.js";
import { overviewCards } from "./overview-cards.js";
import type { PortfolioOverview } from "./portfolio-contracts.js";
import { PortfolioProjection } from "./portfolio-projection.js";
import { redactDashboardValue } from "./redaction.js";
import { buildSecondBrainReadiness, type SecondBrainReadinessProbe, type SecondBrainReadinessReportV1 } from "../second-brain-readiness.js";
import { runtimeSecondBrainReadinessProbe } from "../second-brain-readiness-runtime.js";

const RECENT_TASK_LIMIT = 20;
const TASK_EVENT_LIMIT = 500;
const SETTLED_STATES = new Set(["completed", "failed", "cancelled", "rejected"]);

export type OverviewCard = {
  readonly id: string; readonly label: string;
  readonly value: number; readonly detail: string;
};

export type OverviewTask = {
  readonly task_id: string;
  readonly title: string;
  readonly kind: TaskTimelineSummary["kind"];
  readonly state: string;
  readonly updated_at: string;
  readonly pending_approval: boolean;
  readonly source_ids: readonly string[];
};

export type OverviewApproval = {
  readonly request_id: string;
  readonly action: string;
  readonly action_level: ActionLevel;
  readonly requested_at: string;
  readonly requested_by: string;
  readonly summary: string;
  readonly state: string;
};

export type OverviewRisk = {
  readonly id: string; readonly severity: string; readonly message: string;
};

export type OverviewAgent = {
  readonly agent_id: string;
  readonly provider: string;
  readonly terminal_id: string;
  readonly incarnation_id: string;
  readonly canonical_path: string;
  readonly status: string;
};

export type OverviewResponse = {
  readonly schema_version: 1; readonly generated_at: string | null;
  readonly cards: readonly OverviewCard[]; readonly recent_tasks: readonly OverviewTask[];
  readonly pending_approvals: readonly OverviewApproval[]; readonly risks: readonly OverviewRisk[];
  readonly agents: readonly OverviewAgent[]; readonly portfolio: PortfolioOverview;
  readonly second_brain?: SecondBrainReadinessReportV1;
};

export type TaskListResponse = { readonly schema_version: 1; readonly items: readonly OverviewTask[] };
export type TaskDetailEvent = Omit<TaskTimelineEvent, "evidence_refs"> & { readonly evidence_refs: readonly string[] };
export type TaskDetailResponse = {
  readonly schema_version: 1;
  readonly context: { readonly task: OverviewTask; readonly events: readonly TaskDetailEvent[] };
};
export type AgentListResponse = { readonly schema_version: 1; readonly items: readonly OverviewAgent[] };
export type AgentDetailResponse = { readonly schema_version: 1; readonly agent: OverviewAgent };
export type ControlRequestListResponse = {
  readonly schema_version: 1;
  readonly items: readonly OverviewApproval[];
};
export type DashboardLookup<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "not_found" };

export class DashboardReadModel {
  constructor(
    private readonly db: AuthorityDb,
    private readonly secondBrainProbe: SecondBrainReadinessProbe = runtimeSecondBrainReadinessProbe(),
  ) {}

  async overview(now = new Date()): Promise<OverviewResponse> {
    if (!Number.isFinite(now.getTime())) {
      return invalidClockOverview(await buildSecondBrainReadiness(this.secondBrainProbe, now));
    }
    const before = changeCount(this.db);
    const projection = await buildCurrentState(this.db, now);
    const tasks = new TaskTimeline(this.db).list(RECENT_TASK_LIMIT);
    const commands = new ControlPlane(this.db).list();
    const bindings = new LiveSupervisor(this.db).list();
    const portfolio = new PortfolioProjection(this.db).overview(now);
    const secondBrain = await buildSecondBrainReadiness(this.secondBrainProbe, now);
    if (changeCount(this.db) !== before) throw new JarvisError("DASHBOARD_READ_MUTATED");
    const recent_tasks = tasks.map(toOverviewTask);
    const pending_approvals = commands.filter(isPending).map(toOverviewApproval);
    const risks = projection.risks.flatMap(toOverviewRisk);
    const agents = bindings.map(toOverviewAgent);
    const overview = redactDashboardValue({
      schema_version: DASHBOARD_SCHEMA_VERSION,
      generated_at: projection.generated_at,
      cards: overviewCards({
        activeWork: recent_tasks.filter((task) => !SETTLED_STATES.has(task.state)).length,
        agents: agents.length,
        pending: pending_approvals.length,
        risks: risks.length,
      }),
      recent_tasks,
      pending_approvals,
      risks,
      agents,
    });
    return { ...overview, portfolio: redactDashboardValue(portfolio), second_brain: redactDashboardValue(secondBrain) };
  }

  listTasks(limit: number): TaskListResponse {
    return readSnapshot(this.db, () => redactDashboardValue({
      schema_version: DASHBOARD_SCHEMA_VERSION,
      items: new TaskTimeline(this.db).list(limit).map(toOverviewTask),
    }));
  }

  taskDetail(taskId: string): DashboardLookup<TaskDetailResponse> {
    return readSnapshot(this.db, () => {
      try {
        const context = new TaskTimeline(this.db).context(taskId, TASK_EVENT_LIMIT);
        return {
          kind: "found" as const,
          value: redactDashboardValue({
            schema_version: DASHBOARD_SCHEMA_VERSION,
            context: {
              task: toOverviewTask(context.task),
              events: context.events.slice(-TASK_EVENT_LIMIT),
            },
          }),
        };
      } catch (error) {
        if (error instanceof JarvisError && error.code === "TASK_TIMELINE_NOT_FOUND") return { kind: "not_found" };
        throw error;
      }
    });
  }

  listAgents(): AgentListResponse {
    return readSnapshot(this.db, () => redactDashboardValue({
      schema_version: DASHBOARD_SCHEMA_VERSION,
      items: listedAgents(this.db),
    }));
  }

  agentDetail(agentId: string): DashboardLookup<AgentDetailResponse> {
    return readSnapshot(this.db, () => {
      const agent = listedAgents(this.db).find((item) => item.agent_id === agentId);
      if (agent === undefined) return { kind: "not_found" };
      return { kind: "found", value: redactDashboardValue({ schema_version: DASHBOARD_SCHEMA_VERSION, agent }) };
    });
  }

  listControlRequests(): ControlRequestListResponse {
    return readSnapshot(this.db, () => redactDashboardValue({
      schema_version: DASHBOARD_SCHEMA_VERSION,
      items: new ControlPlane(this.db).list()
        .filter(isActionableControl)
        .sort((left, right) => left.requested_at.localeCompare(right.requested_at) || left.request_id.localeCompare(right.request_id))
        .map(toOverviewApproval),
    }));
  }
}

function readSnapshot<T>(db: AuthorityDb, fn: () => T): T {
  const before = changeCount(db);
  const result = fn();
  if (changeCount(db) !== before) throw new JarvisError("DASHBOARD_READ_MUTATED");
  return result;
}

function listedAgents(db: AuthorityDb): readonly OverviewAgent[] {
  return new LiveSupervisor(db).list()
    .slice()
    .sort((left, right) =>
      left.canonical_path.localeCompare(right.canonical_path)
      || left.provider.localeCompare(right.provider)
      || left.terminal_id.localeCompare(right.terminal_id)
      || left.incarnation_id.localeCompare(right.incarnation_id))
    .map(toOverviewAgent);
}

function changeCount(db: AuthorityDb): number {
  const row = db.db.prepare("SELECT total_changes() AS count").get();
  if (typeof row !== "object" || row === null || !("count" in row) || typeof row.count !== "number") {
    throw new JarvisError("DASHBOARD_READ_MUTATED");
  }
  return row.count;
}

function toOverviewTask(task: TaskTimelineSummary): OverviewTask {
  return {
    task_id: task.task_id,
    title: task.title,
    kind: task.kind,
    state: task.state,
    updated_at: task.updated_at,
    pending_approval: task.pending_approval,
    source_ids: [...task.source_ids],
  };
}

function isPending(command: StoredControlCommand): boolean {
  return command.state === "pending";
}

function isActionableControl(command: StoredControlCommand): boolean {
  return command.state === "pending" || command.state === "approved" || command.state === "failed";
}

function toOverviewApproval(command: StoredControlCommand): OverviewApproval {
  return {
    request_id: command.request_id,
    action: command.action,
    action_level: command.action_level,
    requested_at: command.requested_at,
    requested_by: command.requested_by,
    summary: command.action,
    state: command.state,
  };
}

function toOverviewRisk(value: unknown): readonly OverviewRisk[] {
  if (typeof value !== "object" || value === null) return [];
  const name = "name" in value && typeof value.name === "string" ? value.name : undefined;
  if (name === undefined) return [];
  const code = "code" in value && typeof value.code === "string" ? value.code : name;
  return [{ id: code, severity: "high", message: name }];
}

function toOverviewAgent(binding: LiveBinding): OverviewAgent {
  return {
    agent_id: agentIdentity(binding),
    provider: binding.provider,
    terminal_id: binding.terminal_id,
    incarnation_id: binding.incarnation_id,
    canonical_path: binding.canonical_path,
    status: "live",
  };
}

function agentIdentity(binding: LiveBinding): string {
  return `sha256:${createHash("sha256").update(canonicalize({
    canonical_path: binding.canonical_path,
    provider: binding.provider,
    terminal_id: binding.terminal_id,
    incarnation_id: binding.incarnation_id,
  })).digest("hex")}`;
}
