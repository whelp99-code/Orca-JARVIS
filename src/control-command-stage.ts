import { canonicalize } from "./canonical.js";
import { validateControlAction } from "./control-actions.js";
import { controlCommandDigest, isControlRecord as isRecord, isNonemptyControlValue as nonempty,
  type ControlCommandRequestInput, type StoredControlCommand, type ControlCommandState,
  type ControlEventInput } from "./control-plane-contract.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { validateMemoryCandidateScopeProposal } from "./memory-candidate-scope.js";
import { assertTaskWorkLineage } from "./task-work-lineage-binding.js";
import { parseTaskExecutionPlan } from "./task-execution-plan.js";
import { readControlCommand } from "./control-command-read.js";
function finiteDate(date: Date, code: string): number { const time = date.getTime(); if (!Number.isFinite(time)) throw new JarvisError(code); return time; }
function finiteIso(value: string): number { const time = Date.parse(value); return Number.isFinite(time) ? time : Number.NaN; }

export function stageControlCommand(authority: AuthorityDb, input: ControlCommandRequestInput, now: Date,
  emit: (event: ControlEventInput) => void): StoredControlCommand { const nowMs = finiteDate(now, "CONTROL_COMMAND_INVALID");
    const requested = finiteIso(input.requested_at); const expires = finiteIso(input.expires_at); if ( input.schema_version !== 1 ||
      !nonempty(input.request_id) || !nonempty(input.action) || !Number.isInteger(input.action_level) || input.action_level < 0 || input.action_level > 5 ||
      !isRecord(input.target) || !isRecord(input.args) || typeof input.reversible !== "boolean" || !nonempty(input.requested_by) || !nonempty(input.nonce) ||
      !Number.isFinite(requested) || !Number.isFinite(expires) || requested > nowMs || expires <= nowMs || expires <= requested ||
      expires - requested > 24 * 60 * 60_000 ) throw new JarvisError("CONTROL_COMMAND_INVALID"); validateControlAction(input);
    const irreversible = ["memory.outbox.dispatch", "memory.outbox.abandon-not-delivered", "memory.delete",
      "memory.export", "memory.generation.rollback", "external.delegate"];
    if (irreversible.includes(input.action) && input.reversible) throw new JarvisError("CONTROL_COMMAND_INVALID");
    if (input.action === "external.delegate" && (input.action_level !== 3 || input.requested_by !== "agent:grok-bot")) {
      throw new JarvisError("CONTROL_COMMAND_INVALID");
    }
    const digest = controlCommandDigest(input); const targetJson = canonicalize(input.target);
    const argsJson = canonicalize(input.args); const at = now.toISOString();
    if (input.action === "memory.scope.review") {
      const proposal = validateMemoryCandidateScopeProposal(authority, input.args.proposal, now);
      if (input.requested_by !== "principal:owner" || input.action_level !== 3 || input.reversible
        || expires > Date.parse(proposal.expires_at)) throw new JarvisError("MEMORY_CANDIDATE_SCOPE_INVALID");
    }
    return authority.db.transaction((): StoredControlCommand => {
    const prior = authority.db.prepare("SELECT command_digest,state FROM control_command_requests WHERE request_id=?").get(input.request_id) as
      | { command_digest: string; state: ControlCommandState } | undefined; if (prior) {
      if (prior.command_digest !== digest) throw new JarvisError("CONTROL_COMMAND_REPLAY_CONFLICT");
      if (input.action === "task.execute" && !readControlCommand(authority, input.request_id)) {
        throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
      }
      return { ...input, command_digest: digest, state: prior.state }; }
      if (input.action === "task.execute" && Object.hasOwn(input.args, "work_lineage")) {
        assertTaskWorkLineage(authority, input.args.work_lineage, input.request_id,
          parseTaskExecutionPlan(input.args.plan), input.requested_at);
      }
      if (input.action === "memory.scope.review") validateMemoryCandidateScopeProposal(authority, input.args.proposal, now);
      authority.db .prepare(
          `INSERT INTO control_command_requests(
            request_id,action,action_level,target_json,args_json,command_digest,reversible,
            requested_by,requested_at,expires_at,nonce,state,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ) .run( input.request_id, input.action, input.action_level, targetJson, argsJson, digest, input.reversible ? 1 : 0, input.requested_by,
          input.requested_at, input.expires_at, input.nonce, "pending", at, ); emit({ event_id: `evt:${input.request_id}:requested`,
        event_type: "control.command.requested", source: "jarvis-control-plane", subject: input.request_id, correlation_id: input.request_id,
        payload: { action: input.action, action_level: input.action_level, command_digest: digest }, created_at: at, });
    return { ...input, command_digest: digest, state: "pending" }; }).immediate(); }
