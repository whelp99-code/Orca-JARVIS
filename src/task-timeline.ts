import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { TaskTimelineAuthorityEvents } from "./task-timeline-authority-events.js";
import { TaskTimelineGraphReader } from "./task-timeline-graph.js";
import {
  clamp,
  string,
  values,
  type MutableEvent,
  type TaskTimelineContext,
  type TaskTimelineEvent,
  type TaskTimelineSummary,
} from "./task-timeline-model.js";
import { TaskTimelineQuery } from "./task-timeline-query.js";
import { TaskTimelineRuntimeEvents } from "./task-timeline-runtime-events.js";
import { TaskTimelineSummaryReader } from "./task-timeline-summary.js";

export type {
  TaskTimelineContext,
  TaskTimelineEvent,
  TaskTimelineKind,
  TaskTimelineSource,
  TaskTimelineSummary,
} from "./task-timeline-model.js";

export class TaskTimeline {
  private readonly query: TaskTimelineQuery;
  private readonly graphReader: TaskTimelineGraphReader;
  private readonly summaryReader: TaskTimelineSummaryReader;
  private readonly authorityEvents: TaskTimelineAuthorityEvents;
  private readonly runtimeEvents: TaskTimelineRuntimeEvents;

  constructor(authority: AuthorityDb) {
    this.query = new TaskTimelineQuery(authority);
    this.graphReader = new TaskTimelineGraphReader(authority);
    this.summaryReader = new TaskTimelineSummaryReader(authority);
    this.authorityEvents = new TaskTimelineAuthorityEvents(authority);
    this.runtimeEvents = new TaskTimelineRuntimeEvents(authority);
  }

  private readOnly<T>(read: () => T): T {
    const before = this.query.totalChanges();
    const result = read();
    const after = this.query.totalChanges();
    if (after !== before) throw new JarvisError("TASK_TIMELINE_MUTATED");
    return result;
  }

  list(limit = 100): TaskTimelineSummary[] {
    return this.readOnly(() => this.summaryReader.list(clamp(limit, 1, 500)));
  }

  timeline(taskId: string, limit = 200): TaskTimelineEvent[] {
    if (this.summaryReader.isSuppressed(taskId)) {
      throw new JarvisError("TASK_TIMELINE_NOT_FOUND");
    }
    return this.readOnly(() => this.timelineUnsafe(taskId, limit));
  }

  private timelineUnsafe(
    taskId: string,
    limit = 200,
    graph = this.graphReader.build(taskId),
  ): TaskTimelineEvent[] {
    if (taskId.length === 0) throw new JarvisError("TASK_TIMELINE_INVALID");
    const maximum = clamp(limit, 1, 1000);
    const capacity = Math.ceil(maximum);
    const events: MutableEvent[] = [];
    const compare = (left: MutableEvent, right: MutableEvent): number =>
      left.created_at.localeCompare(right.created_at)
      || left.source.localeCompare(right.source)
      || left.event_id.localeCompare(right.event_id);
    const eventIds = new Set<string>();
    const add = (event: MutableEvent): void => {
      if (eventIds.has(event.event_id)) return;
      // Remember even discarded IDs: a later duplicate must not replace the first event.
      eventIds.add(event.event_id);
      if (events.length === capacity && compare(event, events[0]!) < 0) return;
      let low = 0;
      let high = events.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(events[middle]!, event) <= 0) low = middle + 1;
        else high = middle;
      }
      events.splice(low, 0, event);
      if (events.length > capacity) events.shift();
    };
    this.authorityEvents.add(taskId, graph, add);
    this.runtimeEvents.add(taskId, graph, add);
    const sorted = events;
    if (sorted.length === 0 && !this.summaryReader.summary(taskId, graph)) {
      throw new JarvisError("TASK_TIMELINE_NOT_FOUND");
    }
    // Preserve the original slice conversion, including fractional limits and NaN.
    const originalStart = Math.trunc(Math.max(0, eventIds.size - maximum));
    const discarded = eventIds.size - sorted.length;
    return sorted.slice(Math.max(0, originalStart - discarded))
      .map((event, index) => ({ ...event, sequence: index + 1 }));
  }

  context(
    taskId: string,
    limit = 100,
    maxBytes = 128 * 1024,
    now = new Date(),
  ): TaskTimelineContext {
    if (this.summaryReader.isSuppressed(taskId)) {
      throw new JarvisError("TASK_TIMELINE_NOT_FOUND");
    }
    return this.readOnly(() => {
      const graph = this.graphReader.build(taskId);
      const task = this.summaryReader.summary(taskId, graph);
      if (!task) throw new JarvisError("TASK_TIMELINE_NOT_FOUND");
      const controls = this.query.inRows(
        "SELECT * FROM control_command_requests WHERE request_id IN",
        graph.controlIds,
        "ORDER BY requested_at,request_id",
      );
      const intentIds = values(graph.intentIds);
      const pendingDecisions: unknown[] = controls
        .filter(item => item.state === "pending")
        .map(item => ({ kind: "command", request_id: item.request_id, action: item.action,
          action_level: item.action_level, expires_at: item.expires_at }));
      for (const work of this.query.inRows(
        "SELECT id,action,state,deadline FROM work_items WHERE id IN",
        graph.workIds,
        "ORDER BY created_at,id",
      )) {
        if (work.state === "awaiting_decision") {
          pendingDecisions.push({ kind: "work", work_id: work.id,
            action: work.action, deadline: work.deadline });
        }
      }
      if (intentIds.length > 0) {
        pendingDecisions.push(...this.query.inRows(
          "SELECT question_id,intent_id,state,created_at FROM gjc_questions WHERE state='open' AND intent_id IN",
          intentIds,
          "ORDER BY created_at,question_id",
        ));
      }
      const projects = values(graph.projectIds);
      if (projects.length > 0) {
        pendingDecisions.push(...this.query.inRows(
          `SELECT request_id,project_id,authority_kind,state,expires_at
           FROM pre_gjc_authority_requests WHERE state='pending' AND project_id IN`,
          projects,
          "ORDER BY created_at,request_id",
        ).map(row => ({ kind: "pre_gjc", ...row })));
      }
      const workers = [...graph.bindings.values()].sort((left, right) =>
        string(left.canonical_path).localeCompare(string(right.canonical_path))
        || string(left.provider).localeCompare(string(right.provider))
        || string(left.terminal_id).localeCompare(string(right.terminal_id)));
      const evidenceRows = [
        ...this.query.inRows(
          "SELECT evidence_id,signer_key_id,created_at FROM verification_evidence WHERE work_id IN",
          graph.workIds,
          "ORDER BY created_at,evidence_id",
        ),
        ...this.query.inRows(
          `SELECT evidence_id,kind,signed_at AS created_at
           FROM pre_gjc_completion_evidence WHERE project_id IN`,
          projects,
          "ORDER BY signed_at,evidence_id",
        ),
      ];
      let events = this.timelineUnsafe(taskId, clamp(Math.max(limit, 1000), 1, 1000), graph);
      let truncated = false;
      const build = (): TaskTimelineContext => ({
        schema_version: 1,
        generated_at: now.toISOString(),
        task,
        events,
        pending_decisions: pendingDecisions,
        workers,
        evidence: evidenceRows,
        truncated,
      });
      const maximum = clamp(maxBytes, 1024, 1024 * 1024);
      while (events.length > 1 && Buffer.byteLength(canonicalize(build()), "utf8") > maximum) {
        events = events.slice(1).map((event, index) => ({ ...event, sequence: index + 1 }));
        truncated = true;
      }
      if (Buffer.byteLength(canonicalize(build()), "utf8") > maximum) {
        throw new JarvisError("TASK_TIMELINE_CONTEXT_TOO_LARGE");
      }
      return build();
    });
  }
}
