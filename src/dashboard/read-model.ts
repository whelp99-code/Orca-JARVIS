import type { NativeEveningSourceConfig } from "../evening-native-source.js";
import type { TrustedCloseoutKey } from "../evening-closeout-types.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { passiveCapabilityProbe, runDoctor } from "../doctor.js";
import { TaskTimeline, type TaskTimelineSummary } from "../recommendation-timeline.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { invalidClockOverview } from "./invalid-clock-overview.js";
import { overviewCards } from "./overview-cards.js";
import { PortfolioProjection } from "./portfolio-projection.js";
import type {
  AgentDetailResponse,
  AgentListResponse,
  ControlRequestListResponse,
  DashboardLookup,
  OverviewResponse,
  OverviewRisk,
  OverviewTask,
  TaskDetailResponse,
  TaskListResponse,
} from "./legacy-read-contracts.js";
import { createPersonalCursorSession, PersonalDashboardReadModel } from "./personal-read-model.js";
import type { PersonalCursorCodecOptions } from "./personal-cursor.js";
import { redactDashboardValue } from "./redaction.js";
import { controlRequestPage, pendingControlSummary, type ControlPageInput } from "./control-request-read.js";
import { buildSecondBrainReadiness, type SecondBrainReadinessProbe } from "../second-brain-readiness.js";
import { runtimeSecondBrainReadinessProbe } from "../second-brain-readiness-runtime.js";
import type { CapabilityProbe } from "../capabilities.js";
import { listedAgents } from "./agent-read-model.js";
import { createRuntimeIdentityReader, type RuntimeIdentityReader } from "../runtime-identity.js";
import { readDaemonRuntimeIdentity } from "../daemon-runtime-identity.js";

export type {
  AgentDetailResponse,
  AgentListResponse,
  ControlRequestListResponse,
  DashboardLookup,
  OverviewAgent,
  OverviewApproval,
  OverviewCard,
  OverviewResponse,
  OverviewRisk,
  OverviewTask,
  TaskDetailEvent,
  TaskDetailResponse,
  TaskListResponse,
} from "./legacy-read-contracts.js";

const RECENT_TASK_LIMIT = 20;
const TASK_EVENT_LIMIT = 500;

export class DashboardReadModel {
  readonly personal: PersonalDashboardReadModel;

  constructor(
    private readonly db: AuthorityDb,
    private readonly secondBrainProbe: SecondBrainReadinessProbe = runtimeSecondBrainReadinessProbe(),
    capabilityProbe?: CapabilityProbe,
    cursorSession: PersonalCursorCodecOptions = createPersonalCursorSession(),
    private readonly runtimeIdentity: RuntimeIdentityReader = createRuntimeIdentityReader(() => db.db),
    closeoutKey?: TrustedCloseoutKey,
    nativeConfig?: NativeEveningSourceConfig,
  ) {
    this.personal = new PersonalDashboardReadModel(db, capabilityProbe, cursorSession, closeoutKey, nativeConfig);
  }

  async overview(now = new Date()): Promise<OverviewResponse> {
    if (!Number.isFinite(now.getTime())) {
      return { ...invalidClockOverview(await buildSecondBrainReadiness(this.secondBrainProbe, now)),
        runtime: this.runtimeIdentity(now), daemon_identity: readDaemonRuntimeIdentity(this.db.db, now) };
    }
    // An unrelated approval may commit while health probes await I/O. Guard only
    // the synchronous DB projection, and share one provider observation with doctor.
    const doctor = await runDoctor(this.db, now, passiveCapabilityProbe(), this.secondBrainProbe);
    const secondBrain = doctor.second_brain;
    return this.db.db.transaction(() => {
      const before = changeCount(this.db);
      const tasks = new TaskTimeline(this.db).overview(RECENT_TASK_LIMIT);
      const approvals = pendingControlSummary(this.db, now);
      const agents = listedAgents(this.db, now);
      const portfolio = new PortfolioProjection(this.db).overview(now);
      const runtime = this.runtimeIdentity(now);
      const daemon_identity = readDaemonRuntimeIdentity(this.db.db, now);
      if (changeCount(this.db) !== before) throw new JarvisError("DASHBOARD_READ_MUTATED");
      const risks: OverviewRisk[] = doctor.checks.filter(check => !check.ok).map(check => ({
        id: check.code ?? "CHECK_FAILED", severity: "high", message: check.name,
      }));
      const overview = redactDashboardValue({
        schema_version: DASHBOARD_SCHEMA_VERSION,
        generated_at: now.toISOString(),
        cards: overviewCards({
          activeWork: tasks.activeCount,
          agents: agents.filter(agent => agent.status === "live").length,
          pending: approvals.total,
          risks: risks.length,
        }),
        recent_tasks: tasks.recent.map(toOverviewTask),
        pending_approvals: approvals.items,
        risks,
        agents,
      });
      return { ...overview, portfolio: redactDashboardValue(portfolio), second_brain: redactDashboardValue(secondBrain),
        runtime, daemon_identity };
    }).deferred();
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

  listAgents(now = new Date()): AgentListResponse {
    return readSnapshot(this.db, () => redactDashboardValue({
      schema_version: DASHBOARD_SCHEMA_VERSION,
      items: listedAgents(this.db, now),
    }));
  }

  agentDetail(agentId: string, now = new Date()): DashboardLookup<AgentDetailResponse> {
    return readSnapshot(this.db, () => {
      const agent = listedAgents(this.db, now).find((item) => item.agent_id === agentId);
      if (agent === undefined) return { kind: "not_found" };
      return { kind: "found", value: redactDashboardValue({ schema_version: DASHBOARD_SCHEMA_VERSION, agent }) };
    });
  }

  listControlRequests(now = new Date(), page?: ControlPageInput): ControlRequestListResponse {
    return readSnapshot(this.db, () => redactDashboardValue(controlRequestPage(this.db, now, page)));
  }
}

function readSnapshot<T>(db: AuthorityDb, fn: () => T): T {
  const before = changeCount(db);
  const result = fn();
  if (changeCount(db) !== before) throw new JarvisError("DASHBOARD_READ_MUTATED");
  return result;
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
