import type { AuthorityDb } from "./db.js";
import {
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
import { TaskTimelineQuery } from "./task-timeline-query.js";

export class TaskTimelineAuthorityEvents {
  private readonly query: TaskTimelineQuery;

  constructor(authority: AuthorityDb) {
    this.query = new TaskTimelineQuery(authority);
  }

  add(taskId: string, graph: TimelineGraph, sink: TimelineEventSink): void {
    this.addWorkEvents(taskId, graph, sink);
    this.addControlEvents(taskId, graph, sink);
    this.addNegativeEvidenceEvents(taskId, graph, sink);
  }

  private addWorkEvents(taskId: string, graph: TimelineGraph, sink: TimelineEventSink): void {
    for (const work of this.query.inRows(
      "SELECT * FROM work_items WHERE id IN",
      graph.workIds,
      "ORDER BY created_at,id",
    )) {
      const workId = string(work.id);
      sink({
        event_id: `work:${workId}:observed`,
        task_id: taskId,
        source: "work",
        kind: "status",
        actor: "jarvis",
        title: string(work.action),
        status: string(work.state),
        payload: { work_id: workId, authorization: work.authorization, deadline: work.deadline,
          repo_id: work.repo_id, worktree_id: work.worktree_id },
        evidence_refs: evidence(work.action_digest, work.scope_digest, work.budget_digest),
        created_at: string(work.created_at),
      });
      for (const row of this.query.rows(
        "SELECT * FROM event_ledger WHERE work_id=? ORDER BY seq",
        workId,
      )) {
        sink({ event_id: `work-ledger:${string(row.seq)}`, task_id: taskId, source: "work",
          kind: string(row.event_type).includes("verification") ? "verification" : "status",
          actor: "jarvis", title: string(row.event_type), status: string(row.event_type),
          payload: parse(row.payload_json), evidence_refs: [], created_at: string(row.created_at) });
      }
      for (const row of this.query.rows(
        "SELECT * FROM audit_facts WHERE subject_id=? ORDER BY seq",
        workId,
      )) {
        sink({ event_id: `audit:${string(row.seq)}`, task_id: taskId, source: "work",
          kind: "system", actor: "jarvis-audit", title: string(row.fact_type), status: null,
          payload: parse(row.payload_json), evidence_refs: [], created_at: string(row.created_at) });
      }
      for (const row of this.query.rows(
        "SELECT * FROM verification_evidence WHERE work_id=? ORDER BY created_at,evidence_id",
        workId,
      )) {
        sink({ event_id: string(row.evidence_id), task_id: taskId, source: "verification",
          kind: "verification", actor: string(row.signer_key_id), title: "verification.evidence",
          status: "recorded", payload: parse(row.payload_json),
          evidence_refs: evidence(row.evidence_id), created_at: string(row.created_at) });
      }
    }
    for (const row of this.query.inRows(
      "SELECT * FROM continuation_acceptances WHERE id IN",
      graph.continuationIds,
      "ORDER BY created_at,id",
    )) {
      sink({ event_id: `continuation:${string(row.id)}`, task_id: taskId, source: "work",
        kind: "status", actor: "authority", title: "continuation.accepted",
        status: string(row.status || "accepted"), payload: row,
        evidence_refs: evidence(row.authorization_id), created_at: string(row.created_at) });
    }
    for (const row of this.query.inRows(
      "SELECT * FROM outbox WHERE continuation_id IN",
      graph.continuationIds,
      "ORDER BY created_at,intent_id",
    )) {
      sink({ event_id: string(row.intent_id), task_id: taskId, source: "gjc", kind: "agent",
        actor: "shadow-outbox", title: `outbox.${string(row.kind)}`,
        status: optional(row.outcome) ?? (row.acked_at
          ? "acked" : row.delivered_at ? "delivered" : "pending"),
        payload: parse(row.payload_json), evidence_refs: [], created_at: string(row.created_at) });
    }
  }

  private addControlEvents(taskId: string, graph: TimelineGraph, sink: TimelineEventSink): void {
    for (const request of this.query.inRows(
      "SELECT * FROM control_command_requests WHERE request_id IN",
      graph.controlIds,
      "ORDER BY requested_at,request_id",
    )) {
      const requestId = string(request.request_id);
      for (const row of this.query.rows(
        "SELECT * FROM control_events WHERE subject=? OR correlation_id=? ORDER BY seq",
        requestId,
        requestId,
      )) {
        const eventType = string(row.event_type);
        sink({ event_id: string(row.event_id), task_id: taskId, source: "control",
          kind: eventType.includes("approved") || eventType.includes("rejected")
            ? "approval" : "command",
          actor: string(row.source), title: eventType,
          status: optional(rowJson(row.payload_json).state) ?? eventType.split(".").at(-1) ?? null,
          payload: parse(row.payload_json), evidence_refs: evidence(row.payload_digest),
          created_at: string(row.created_at) });
      }
      for (const row of this.query.rows(
        "SELECT * FROM control_command_receipts WHERE request_id=? ORDER BY created_at,receipt_id",
        requestId,
      )) {
        sink({ event_id: string(row.receipt_id), task_id: taskId, source: "control",
          kind: "approval", actor: string(row.signer_principal_id),
          title: `approval.${string(row.decision)}`, status: string(row.decision),
          payload: { authenticated_session_id: row.authenticated_session_id,
            key_id: row.key_id, expires_at: row.expires_at },
          evidence_refs: evidence(row.command_digest), created_at: string(row.created_at) });
      }
      for (const row of this.query.rows(
        "SELECT * FROM control_command_effects WHERE request_id=? ORDER BY created_at,effect_id",
        requestId,
      )) {
        sink({ event_id: string(row.effect_id), task_id: taskId, source: "control",
          kind: "command", actor: "approved-executor", title: string(row.effect_type),
          status: string(request.state), payload: parse(row.payload_json),
          evidence_refs: evidence(row.payload_digest), created_at: string(row.created_at) });
      }
      for (const row of this.query.rows(
        `SELECT * FROM control_command_revocations
         WHERE request_id=? ORDER BY created_at,revocation_id`,
        requestId,
      )) {
        sink({ event_id: string(row.revocation_id), task_id: taskId, source: "control",
          kind: "command", actor: string(row.revoked_by), title: "control.command.revoked",
          status: "cancelled", payload: parse(row.payload_json),
          evidence_refs: evidence(row.payload_digest), created_at: string(row.created_at) });
      }
      for (const row of this.query.rows(
        "SELECT * FROM control_effect_attempts WHERE request_id=? ORDER BY created_at,attempt_id",
        requestId,
      )) {
        sink({ event_id: string(row.attempt_id), task_id: taskId, source: "control",
          kind: "command", actor: "approved-executor", title: `effect.${string(row.effect_type)}`,
          status: string(row.state),
          payload: { receipt_digest: row.receipt_digest, error_code: row.error_code },
          evidence_refs: evidence(row.idempotency_key, row.receipt_digest),
          created_at: string(row.created_at) });
      }
    }
    for (const id of graphIds(graph)) {
      for (const row of this.query.rows(
        "SELECT * FROM control_events WHERE correlation_id=? OR subject=? ORDER BY seq",
        id,
        id,
      )) {
        const eventType = string(row.event_type);
        sink({ event_id: string(row.event_id), task_id: taskId, source: "control",
          kind: eventType.startsWith("workflow.") ? "workflow" : "command",
          actor: string(row.source), title: eventType, status: eventType.split(".").at(-1) ?? null,
          payload: parse(row.payload_json), evidence_refs: evidence(row.payload_digest),
          created_at: string(row.created_at) });
      }
    }
  }

  private addNegativeEvidenceEvents(
    taskId: string,
    graph: TimelineGraph,
    sink: TimelineEventSink,
  ): void {
    const requestIds = values(graph.controlIds);
    const predicates = ["task_id=?"];
    const params: unknown[] = [taskId];
    if (requestIds.length > 0) {
      predicates.push("request_id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(requestIds));
    }
    const sql = `SELECT evidence_id,task_id,attempt_id,reason_code,evidence_digest,created_at
      FROM negative_evidence WHERE ${predicates.join(" OR ")} ORDER BY created_at,evidence_id`;
    for (const row of this.query.rows(sql, ...params)) {
      sink({ event_id: string(row.evidence_id), task_id: taskId, source: "control",
        kind: "evidence", actor: "approved-executor", title: "evidence.negative.recorded",
        status: string(row.reason_code), payload: { reason_code: row.reason_code,
          evidence_digest: row.evidence_digest, attempt_id: row.attempt_id },
        evidence_refs: evidence(row.evidence_id, row.evidence_digest),
        created_at: string(row.created_at) });
    }
  }
}
