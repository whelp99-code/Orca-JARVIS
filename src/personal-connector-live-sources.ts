import type { OrcaReadonlyAdapter } from "./orca.js";
import type { TaskTimeline } from "./task-timeline.js";
import { verifyPortfolioAuthenticatedReport } from "./dashboard/portfolio-auth.js";
import type { PortfolioEnvironment } from "./dashboard/portfolio-contracts.js";
import type { PersonalConnectorValue, PersonalSourceSnapshot } from "./personal-connector-types.js";
import {
  freezePersonalSnapshot,
  personalConnectorDigest,
  safeConnectorId,
  safeConnectorInstant,
  safeCount,
} from "./personal-connector-values.js";

type OrcaSourceOptions = {
  readonly adapter: OrcaReadonlyAdapter;
  readonly environment: string;
  readonly worktree: string;
};

export class OrcaPersonalConnectorSource {
  readonly connectorId = "orca" as const;
  constructor(private readonly options: OrcaSourceOptions) {}

  async read(now: Date): Promise<PersonalSourceSnapshot> {
    const terminals = await this.options.adapter.list(this.options.worktree);
    if (terminals.length === 0) return this.empty(now, "no_data");
    if (!terminals.some(item => item.connected)) return this.empty(now, "disconnected");
    const connected = terminals.filter(item => item.connected);
    const terminalIds = connected.map(item => safeConnectorId(item.handle)).sort();
    const worktreeIds = connected.map(item => safeConnectorId(item.worktreeId ?? "")).sort();
    const incarnations = connected.map(item => safeConnectorId(item.incarnationId)).sort();
    const lastOutput = connected.flatMap(item => item.lastOutputAt === null ? [] : [item.lastOutputAt]);
    const cursor = personalConnectorDigest({ terminalIds, incarnations, connected: true });
    return freezePersonalSnapshot({
      connector_id: this.connectorId,
      source_version: "orca-readonly-v1",
      incarnation: personalConnectorDigest(incarnations),
      sequence: now.getTime(),
      cursor,
      observed_at: now.toISOString(),
      fresh_until: null,
      status: "current",
      evidence_refs: [cursor],
      values: {
        environment: safeConnectorId(this.options.environment),
        worktree_id: worktreeIds,
        terminal_id: terminalIds,
        incarnation_id: incarnations,
        cursor,
        connected: true,
        last_output_at: lastOutput.length === 0 ? null : Math.max(...lastOutput),
      },
    });
  }

  private empty(now: Date, status: "no_data" | "disconnected"): PersonalSourceSnapshot {
    return freezePersonalSnapshot({
      connector_id: this.connectorId,
      source_version: "orca-readonly-v1",
      incarnation: null,
      sequence: now.getTime(),
      cursor: personalConnectorDigest({ status, checked_at: now.toISOString() }),
      observed_at: now.toISOString(),
      fresh_until: status === "no_data" ? now.toISOString() : null,
      status,
      evidence_refs: [],
      values: {},
    });
  }
}

type TimelineSourceOptions = { readonly timeline: TaskTimeline; readonly limit: number };

export class TaskTimelinePersonalConnectorSource {
  readonly connectorId = "task_timeline" as const;
  constructor(private readonly options: TimelineSourceOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 32) throw new TypeError("PERSONAL_SOURCE_CONFIG_INVALID");
  }

  async read(now: Date): Promise<PersonalSourceSnapshot> {
    const tasks = this.options.timeline.list(this.options.limit);
    if (tasks.length === 0) return this.empty(now);
    const taskIds = tasks.map(item => safeConnectorId(item.task_id));
    const events = tasks.flatMap(task => this.options.timeline.timeline(task.task_id, this.options.limit));
    for (let index = 1; index < events.length; index += 1) {
      const prior = events[index - 1]; const current = events[index];
      if (prior !== undefined && current !== undefined && prior.task_id === current.task_id && current.sequence <= prior.sequence) {
        throw new TypeError("PERSONAL_SOURCE_ORDER_INVALID");
      }
    }
    const eventIds = events.map(item => safeConnectorId(item.event_id));
    const decisionIds = events.filter(item => item.kind === "approval").map(item => safeConnectorId(item.event_id));
    const evidence = events.flatMap(item => item.evidence_refs).map(safeConnectorId);
    const observed = tasks.map(item => safeConnectorInstant(item.updated_at)).sort().at(-1);
    if (observed === undefined) throw new TypeError("PERSONAL_SOURCE_INVALID");
    const cursor = personalConnectorDigest({ taskIds, eventIds, evidence });
    return freezePersonalSnapshot({
      connector_id: this.connectorId,
      source_version: "task-timeline-v1",
      incarnation: null,
      sequence: Date.parse(observed),
      cursor,
      observed_at: now.toISOString(),
      fresh_until: null,
      status: "current",
      evidence_refs: evidence,
      values: {
        task_id: taskIds,
        event_id: eventIds,
        evidence_id: evidence,
        decision_id: decisionIds,
        state: tasks.map(item => safeConnectorId(item.state)),
        sequence: events.length,
        observed_at: observed,
        pending_approval: tasks.some(item => item.pending_approval),
      },
    });
  }

  private empty(now: Date): PersonalSourceSnapshot {
    return freezePersonalSnapshot({
      connector_id: this.connectorId, source_version: "task-timeline-v1", incarnation: null, sequence: now.getTime(),
      cursor: personalConnectorDigest({ empty: true, checked_at: now.toISOString() }), observed_at: now.toISOString(),
      fresh_until: now.toISOString(), status: "no_data", evidence_refs: [], values: {},
    });
  }
}

type PortfolioSourceOptions = {
  readonly envelope: Buffer;
  readonly key: Buffer;
  readonly source: PortfolioEnvironment;
  readonly received_at: Date;
};

export class PortfolioPersonalConnectorSource {
  readonly connectorId = "portfolio" as const;
  private readonly envelope: Buffer;
  private readonly key: Buffer;
  private readonly receivedAt: Date;

  constructor(private readonly options: PortfolioSourceOptions) {
    this.envelope = options.envelope;
    this.key = options.key;
    this.receivedAt = options.received_at;
  }

  async read(now: Date): Promise<PersonalSourceSnapshot> {
    const verified = verifyPortfolioAuthenticatedReport(this.envelope, this.key, this.options.source);
    if (verified.kind === "error") return this.unavailable();
    const report = verified.report;
    const reportedAt = safeConnectorInstant(report.reported_at);
    const receivedAt = safeConnectorInstant(this.receivedAt.toISOString());
    if (Date.parse(reportedAt) > Date.parse(receivedAt) || Date.parse(receivedAt) > now.getTime()) {
      throw new TypeError("PERSONAL_SOURCE_TIME_INVALID");
    }
    const reportDigest = personalConnectorDigest(report);
    const values: Record<string, PersonalConnectorValue> = {
      source: report.source,
      reported_at: reportedAt,
      collector_status: "ok",
      report_digest: reportDigest,
      worktree_count: safeCount(report.host.worktree_count),
      terminal_count: safeCount(report.host.terminal_count),
      clean_count: safeCount(report.host.clean_count),
      dirty_count: safeCount(report.host.dirty_count),
      dirty_path_count: safeCount(report.host.dirty_path_count),
      active_task_count: safeCount(report.host.active_task_count),
    };
    if (report.source === "local") {
      values["issue_count"] = safeCount(report.github.issue_count);
      values["pull_request_count"] = safeCount(report.github.pull_request_count);
    }
    return freezePersonalSnapshot({
      connector_id: this.connectorId, source_version: "portfolio-auth-v1", incarnation: report.source,
      sequence: Date.parse(reportedAt), cursor: reportDigest, observed_at: reportedAt,
      fresh_until: null, status: "current", evidence_refs: [reportDigest], values,
    });
  }

  private unavailable(): PersonalSourceSnapshot {
    return freezePersonalSnapshot({
      connector_id: this.connectorId, source_version: "portfolio-auth-v1", incarnation: this.options.source,
      sequence: this.receivedAt.getTime(), cursor: personalConnectorDigest({ error: true, at: this.receivedAt.toISOString() }),
      observed_at: this.receivedAt.toISOString(), fresh_until: null,
      status: "unavailable", evidence_refs: [], values: {},
    });
  }
}
