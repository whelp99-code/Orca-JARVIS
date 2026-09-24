import { ControlPlane } from "../../control-plane.js";
import { controlValueDigest } from "../../control-plane-contract.js";
import type { AuthorityDb } from "../../db.js";
import { parseAuthorityDecision } from "../../dashboard/authority-validation.js";
import { actionBinding } from "../actions.js";
import type { ActionBinding, ActionReceipt, ActionRequest, ActionSend, WorkboardActionAdapter } from "../action-contracts.js";

/** No owner-key minting and no executor import. Approval uses the existing signed Control Plane boundary. */
export class ControlPlaneActions implements WorkboardActionAdapter {
  readonly requiresReceipt = true;
  readonly location = "/approvals";
  readonly effects: ActionRequest["effects"] = [
    { operation: "approve", label: "요청 범위 승인", resumesExecution: false },
    { operation: "reject", label: "요청 거절", resumesExecution: false },
  ];
  constructor(private readonly authority: AuthorityDb, readonly sourceId: string,
    private readonly requestId: string, private readonly binding: () => ActionBinding, private readonly clock: () => Date) {}
  async readRequest(workId: string): Promise<ActionRequest | null> {
    const command = new ControlPlane(this.authority).get(this.requestId);
    if (!command || command.state !== "pending") return null;
    const binding = this.binding();
    if (binding.workId !== workId || command.target.task_id !== binding.taskId) throw new Error("WORKBOARD_BINDING_CHANGED");
    const payload = Object.fromEntries(Object.entries(command).filter(([key]) => key !== "state"));
    return { ...binding, sourceId: this.sourceId, requestId: command.request_id,
      revision: command.command_digest, capabilityVersion: "jarvis-control-plane-v1",
      expiresAt: command.expires_at, payloadDigest: controlValueDigest(payload), payload,
      target: JSON.stringify(command.target), scope: command.action, effects: this.effects };
  }
  async send(input: ActionSend): Promise<void> {
    const { receipt } = parseAuthorityDecision({ schema_version: 1, receipt: input.authorityReceipt });
    if (receipt.request_id !== input.request.requestId || receipt.command_digest !== input.request.revision
      || receipt.decision !== input.operation) throw new Error("WORKBOARD_AUTHORITY_RECEIPT_MISMATCH");
    // ControlPlane atomically enforces signature, digest, expiry and the pending -> decision transition.
    new ControlPlane(this.authority).decide(receipt, this.clock());
  }
  async readReceipt(intentId: string, request: ActionRequest): Promise<ActionReceipt | null> {
    const row = this.authority.db.prepare(`SELECT receipt_id,decision,command_digest FROM control_command_receipts WHERE request_id=?`)
      .get(request.requestId) as { receipt_id: string; decision: "approve" | "reject"; command_digest: string } | undefined;
    const command = new ControlPlane(this.authority).get(request.requestId);
    if (!row || !command || row.command_digest !== request.revision) return null;
    const sourceState = command.state === "completed" ? "claimed_done" : command.state === "claimed" ? "running"
      : command.state === "approved" || command.state === "rejected" || command.state === "failed" ? command.state : "stopped";
    return { receiptId: row.receipt_id, intentId, requestId: request.requestId, requestDigest: controlValueDigest(request),
      operation: row.decision, binding: actionBinding(request), sourceState };
  }
}
