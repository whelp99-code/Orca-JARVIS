import type { AuthorityDb } from "./db.js";
import {
  canonicalPath,
  evidence,
  graphIds,
  optional,
  parse,
  rowJson,
  string,
  values,
  type TimelineEventSink,
  type TimelineGraph,
} from "./task-timeline-model.js";
import { groupTimelineRows, TaskTimelineQuery } from "./task-timeline-query.js";

export class TaskTimelineRuntimeEvents {
  private readonly query: TaskTimelineQuery;

  constructor(authority: AuthorityDb) {
    this.query = new TaskTimelineQuery(authority);
  }

  add(taskId: string, graph: TimelineGraph, sink: TimelineEventSink): void {
    this.addWorkflowEvents(taskId, graph, sink);
    this.addGjcEvents(taskId, graph, sink);
    this.addProgressEvents(taskId, graph, sink);
    this.addPreGjcEvents(taskId, graph, sink);
  }

  private addWorkflowEvents(taskId: string, graph: TimelineGraph, sink: TimelineEventSink): void {
    for (const run of this.query.inRows(
      "SELECT * FROM workflow_runs WHERE run_id IN",
      graph.runIds,
      "ORDER BY created_at,run_id",
    )) {
      const runId = string(run.run_id);
      sink({ event_id: `workflow:${runId}:state`, task_id: taskId, source: "workflow",
        kind: "workflow", actor: "jarvis-loopgraph", title: string(run.loop_id),
        status: string(run.state), payload: { run_id: runId, current_node: run.current_node,
          attempts: run.attempts, failure_code: run.failure_code },
        evidence_refs: [], created_at: string(run.created_at) });
      for (const row of this.query.rows(
        "SELECT * FROM workflow_steps WHERE run_id=? ORDER BY created_at,step_id",
        runId,
      )) {
        sink({ event_id: string(row.step_id), task_id: taskId, source: "workflow",
          kind: string(row.node_id) === "verify" ? "verification" : "workflow",
          actor: string(row.node_id), title: `workflow.${string(row.node_id)}`,
          status: string(row.outcome), payload: parse(row.output_json),
          evidence_refs: evidence(row.output_digest, row.evidence_digest),
          created_at: string(row.created_at) });
      }
      for (const row of this.query.rows(
        "SELECT * FROM workflow_transitions WHERE run_id=? ORDER BY created_at,transition_id",
        runId,
      )) {
        sink({ event_id: string(row.transition_id), task_id: taskId, source: "workflow",
          kind: "workflow", actor: "jarvis-loopgraph", title: "workflow.transitioned",
          status: string(row.outcome), payload: { from_node: row.from_node, to_node: row.to_node,
            approval_receipt_id: row.approval_receipt_id },
          evidence_refs: evidence(row.evidence_digest), created_at: string(row.created_at) });
      }
      for (const row of this.query.rows(
        "SELECT * FROM workflow_step_approvals WHERE run_id=? ORDER BY created_at,approval_id",
        runId,
      )) {
        sink({ event_id: string(row.approval_id), task_id: taskId, source: "workflow",
          kind: "approval", actor: "jarvis-loopgraph", title: "workflow.approval.receipt",
          status: "approve", payload: { step_id: row.step_id, transition_id: row.transition_id,
            request_id: row.request_id, receipt_id: row.receipt_id },
          evidence_refs: evidence(row.command_digest), created_at: string(row.created_at) });
      }
    }
  }

  private addGjcEvents(taskId: string, graph: TimelineGraph, sink: TimelineEventSink): void {
    const intents = this.query.inRows(
      "SELECT * FROM gjc_intents WHERE intent_id IN", graph.intentIds, "ORDER BY created_at,intent_id");
    const ids = intents.map(intent => string(intent.intent_id));
    const events = groupTimelineRows(this.query.inRows(
      "SELECT * FROM gjc_intent_events WHERE intent_id IN", ids, "ORDER BY sequence"), ["intent_id"]);
    const dispatches = groupTimelineRows(this.query.inRows(
      "SELECT * FROM gjc_dispatch_receipts WHERE intent_id IN", ids, "ORDER BY accepted_at,intent_id"), ["intent_id"]);
    const answers = groupTimelineRows(this.query.inRows(
      "SELECT * FROM gjc_answer_receipts WHERE intent_id IN", ids, "ORDER BY completed_at,intent_id"), ["intent_id"]);
    const questions = groupTimelineRows(this.query.inRows(
      "SELECT * FROM gjc_questions WHERE intent_id IN", ids, "ORDER BY created_at,question_id"), ["intent_id"]);
    for (const intent of intents) {
      const intentId = string(intent.intent_id);
      sink({ event_id: `gjc:${intentId}:state`, task_id: taskId, source: "gjc", kind: "agent",
        actor: "gjc-coordinator", title: `gjc.${string(intent.kind)}`,
        status: string(intent.state), payload: { intent_id: intentId,
          continuation_id: intent.continuation_id, attempts: intent.attempts,
          failure_code: intent.failure_code, receipt: parse(intent.receipt_json) },
        evidence_refs: evidence(intent.payload_digest), created_at: string(intent.created_at) });
      for (const row of events.get(intentId) ?? []) {
        sink({ event_id: `gjc-event:${string(row.sequence)}`, task_id: taskId, source: "gjc",
          kind: "agent", actor: "gjc-runtime", title: string(row.event_type),
          status: string(row.event_type), payload: parse(row.payload_json), evidence_refs: [],
          created_at: string(row.created_at) });
      }
      for (const row of dispatches.get(intentId) ?? []) {
        sink({ event_id: `gjc-dispatch-receipt:${intentId}`, task_id: taskId, source: "gjc",
          kind: "agent", actor: "gjc-coordinator", title: "gjc.dispatch.receipt",
          status: "accepted", payload: parse(row.receipt_json), evidence_refs: [],
          created_at: string(row.accepted_at) });
      }
      for (const row of answers.get(intentId) ?? []) {
        sink({ event_id: `gjc-answer-receipt:${intentId}`, task_id: taskId, source: "gjc",
          kind: "agent", actor: "gjc-coordinator", title: "gjc.answer.receipt",
          status: "completed", payload: parse(row.receipt_json), evidence_refs: [],
          created_at: string(row.completed_at) });
      }
      for (const row of questions.get(intentId) ?? []) {
        sink({ event_id: string(row.question_id), task_id: taskId, source: "gjc",
          kind: "approval", actor: "gjc-coordinator", title: "agent.question",
          status: string(row.state), payload: parse(row.snapshot_json),
          evidence_refs: evidence(row.snapshot_digest), created_at: string(row.created_at) });
      }
    }
    for (const question of this.query.inRows(
      "SELECT * FROM gjc_question_answers WHERE question_id IN",
      graph.questionIds,
      "ORDER BY created_at,question_id",
    )) {
      sink({ event_id: `answer:${string(question.question_id)}`, task_id: taskId, source: "gjc",
        kind: "approval", actor: "operator", title: "agent.answer", status: "answered",
        payload: { answer: parse(question.answer_json), receipt: parse(question.receipt_json) },
        evidence_refs: evidence(question.answer_digest), created_at: string(question.created_at) });
    }
  }

  private addProgressEvents(taskId: string, graph: TimelineGraph, sink: TimelineEventSink): void {
    const seen = new Set<string>();
    for (const binding of graph.bindings.values()) {
      const canonicalBindingPath = string(binding.canonical_path);
      const sql = `SELECT o.*,p.state AS projection_state,p.cursor AS projection_cursor,
        p.observed_at AS projection_observed_at,p.updated_at AS projection_updated_at
        FROM progress_observations o LEFT JOIN progress_projection p
          ON p.worktree_selector=o.worktree_selector AND p.provider=o.provider
          AND p.terminal_handle=o.terminal_handle
          AND p.observation_identity=o.observation_identity
        WHERE o.provider=? AND o.terminal_handle=?
        ORDER BY o.created_at,o.observation_identity`;
      for (const row of this.query.rows(sql, binding.provider, binding.terminal_id)) {
        if (canonicalPath(row.worktree_selector) !== canonicalBindingPath) continue;
        const eventId = string(row.observation_identity);
        if (seen.has(eventId)) continue;
        seen.add(eventId);
        const assessment = rowJson(row.assessment_json);
        const projection = optional(row.projection_state) ? {
          state: row.projection_state,
          cursor: row.projection_cursor,
          observed_at: row.projection_observed_at,
          updated_at: row.projection_updated_at,
        } : null;
        sink({ event_id: eventId, task_id: taskId, source: "progress", kind: "agent",
          actor: string(row.provider), title: "agent.progress",
          status: optional(assessment.state) ?? optional(row.projection_state),
          payload: { ...assessment, projection },
          evidence_refs: evidence(row.observation_identity), created_at: string(row.created_at) });
      }
    }
  }

  private addPreGjcEvents(taskId: string, graph: TimelineGraph, sink: TimelineEventSink): void {
    const projects = values(graph.projectIds);
    if (projects.length === 0) return;
    const relatedTelemetry = (value: unknown): boolean => {
      const telemetry = rowJson(value);
      const ids = graphIds(graph);
      return [telemetry.task_id, telemetry.work_id, telemetry.correlation_id, telemetry.run_id]
        .some(item => optional(item) !== null && ids.has(string(item)));
    };
    for (const row of this.query.inRows(
      "SELECT * FROM pre_gjc_improvement_proposals WHERE project_id IN",
      projects,
      "ORDER BY created_at,proposal_id",
    )) {
      if (!relatedTelemetry(row.telemetry_json)) continue;
      sink({ event_id: string(row.proposal_id), task_id: taskId, source: "control",
        kind: "system", actor: "pre-gjc-shadow", title: "correlation.proposed",
        status: "untrusted", payload: { project_id: row.project_id, trust: "untrusted",
          state: row.state, telemetry: parse(row.telemetry_json) },
        evidence_refs: [], created_at: string(row.created_at) });
    }
    for (const row of this.query.inRows(
      "SELECT * FROM pre_gjc_authority_requests WHERE project_id IN",
      projects,
      "ORDER BY created_at,request_id",
    )) {
      sink({ event_id: string(row.request_id), task_id: taskId, source: "control",
        kind: "approval", actor: "pre-gjc-shadow",
        title: `pre_gjc.authority.${string(row.authority_kind)}`,
        status: string(row.state), payload: row, evidence_refs: evidence(row.request_digest),
        created_at: string(row.created_at) });
    }
    for (const row of this.query.inRows(
      "SELECT * FROM pre_gjc_resume_intents WHERE project_id IN",
      projects,
      "ORDER BY created_at,intent_id",
    )) {
      sink({ event_id: string(row.intent_id), task_id: taskId, source: "control",
        kind: "command", actor: "pre-gjc-shadow", title: "pre_gjc.resume.intent",
        status: string(row.state), payload: row, evidence_refs: [],
        created_at: string(row.created_at) });
    }
    for (const row of this.query.inRows(
      "SELECT * FROM pre_gjc_policy_resume_intents WHERE project_id IN",
      projects,
      "ORDER BY created_at,intent_id",
    )) {
      sink({ event_id: string(row.intent_id), task_id: taskId, source: "control",
        kind: "command", actor: "pre-gjc-shadow", title: "pre_gjc.policy_resume.intent",
        status: string(row.state), payload: row,
        evidence_refs: evidence(row.config_digest, row.prompt_digest),
        created_at: string(row.created_at) });
    }
    for (const row of this.query.inRows(
      "SELECT * FROM pre_gjc_completion_evidence WHERE project_id IN",
      projects,
      "ORDER BY signed_at,evidence_id",
    )) {
      sink({ event_id: string(row.evidence_id), task_id: taskId, source: "verification",
        kind: "evidence", actor: "pre-gjc-shadow",
        title: `pre_gjc.evidence.${string(row.kind)}`, status: "recorded",
        payload: parse(row.payload_json), evidence_refs: evidence(row.evidence_id),
        created_at: string(row.signed_at) });
    }
    for (const row of this.query.inRows(
      "SELECT * FROM pre_gjc_boundary_audits WHERE project_id IN",
      projects,
      "ORDER BY created_at,audit_id",
    )) {
      sink({ event_id: string(row.audit_id), task_id: taskId, source: "progress",
        kind: "status", actor: "pre-gjc-shadow", title: "pre_gjc.boundary",
        status: string(row.aggregate_status), payload: row, evidence_refs: [],
        created_at: string(row.created_at) });
    }
  }
}
