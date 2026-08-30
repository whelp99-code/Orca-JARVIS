import { controlWorkflowRunInput } from "./control-workflow-input.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { LoopGraph, type WorkflowRunInput } from "./loopgraph.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { closedRecord, closedText } from "./task25-closed-input.js";

export type WorkflowStageOutcome =
  | {
    readonly kind: "staged";
    readonly run_id: string;
    readonly workflow_digest: string;
  }
  | {
    readonly kind: "uncertain";
    readonly reason: "stage_boundary_uncertain" | "adapter_threw" | "invalid_outcome";
    readonly evidence_digest: string;
  };
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function invalid(): never { throw new JarvisError("RECOMMENDATION_WORKFLOW_STAGE_RESULT_INVALID"); }
export function workflowInputDigest(input: WorkflowRunInput): string {
  return persistenceHash(input);
}
export function parseWorkflowStageOutcome(value: unknown): WorkflowStageOutcome {
  const input = closedRecord(value);
  switch (input["kind"]) {
    case "staged": {
      const exact = closedRecord(value, ["kind", "run_id", "workflow_digest"]);
      const digest = closedText(exact["workflow_digest"], 71);
      if (!DIGEST.test(digest)) return invalid();
      return { kind: "staged", run_id: closedText(exact["run_id"], 256), workflow_digest: digest };
    }
    case "uncertain": {
      const exact = closedRecord(value, ["kind", "reason", "evidence_digest"]);
      const reason = exact["reason"];
      if (reason !== "stage_boundary_uncertain" && reason !== "adapter_threw" && reason !== "invalid_outcome") {
        return invalid();
      }
      const digest = closedText(exact["evidence_digest"], 71);
      if (!DIGEST.test(digest)) return invalid();
      return { kind: "uncertain", reason, evidence_digest: digest };
    }
    default:
      return invalid();
  }
}
export interface WorkflowStageAdapter {
  stage(input: WorkflowRunInput, now: Date): Promise<WorkflowStageOutcome>;
}
export class RecordingWorkflowStageAdapter implements WorkflowStageAdapter {
  constructor(private readonly authority: AuthorityDb) {}
  async stage(input: WorkflowRunInput, now: Date): Promise<WorkflowStageOutcome> {
    const row = this.authority.db.prepare(`SELECT r.args_json,r.command_digest,r.lease_fence,x.lease_fence AS redemption_fence
      FROM control_command_requests r JOIN control_command_redemptions x ON x.request_id=r.request_id
      JOIN control_command_receipts a ON a.receipt_id=x.receipt_id
      WHERE r.action='workflow.start' AND r.state='claimed' AND r.lease_expires_at>?
        AND r.expires_at>? AND a.expires_at>? AND x.lease_fence=r.lease_fence
        AND NOT EXISTS (SELECT 1 FROM control_command_revocations v WHERE v.request_id=r.request_id)
      ORDER BY r.requested_at,r.request_id`).all(now.toISOString(), now.toISOString(), now.toISOString()) as Array<Record<string, unknown>>;
    const matches = row.filter(item => {
      const args = JSON.parse(String(item.args_json));
      return typeof args === "object" && args !== null && !Array.isArray(args)
        && workflowInputDigest(controlWorkflowRunInput(args)) === workflowInputDigest(input);
    });
    if (matches.length !== 1) throw new JarvisError("RECOMMENDATION_WORKFLOW_RECORDING_AUTHORITY_REQUIRED");
    const graph = new LoopGraph(this.authority);
    graph.ensureDefaults(now);
    const run = graph.start(input, now);
    return {
      kind: "staged", run_id: run.run_id,
      workflow_digest: workflowInputDigest(input),
    };
  }
}
export function uncertainStageOutcome(
  requestId: string,
  fence: number,
  reason: Extract<WorkflowStageOutcome, { readonly kind: "uncertain" }>["reason"],
): Extract<WorkflowStageOutcome, { readonly kind: "uncertain" }> {
  return {
    kind: "uncertain", reason,
    evidence_digest: persistenceHash({ request_id: requestId, fence, reason }),
  };
}
