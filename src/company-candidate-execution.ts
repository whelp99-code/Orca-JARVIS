import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { ControlPlane } from "./control-plane.js";
import { controlValueDigest, verifyCommandApproval } from "./control-plane-contract.js";
import type { CommandApprovalReceipt, StoredControlCommand } from "./control-plane-contract.js";
import { assertCompanyApprovalPin, assertCurrentCompanyPin, readCompanyApprovalBinding } from "./company-approval-binding.js";
import { parseCompanyCommand, type CompanyCommand } from "./company-candidate-contract.js";
import { decodeCompanyCommandV2, parseCompanyCommandV2, type CompanyCommandV2 } from "./company-candidate-v2-contract.js";
import { assertCompanyContext, assertCompanyKeySeparation, companyEnrollmentContext } from "./company-candidate-import.js";
import { companyCompletionV2Schema, type CompanyCompletionV2, type CompanyCompletionVerifierV2 } from "./company-completion-v2.js";
import { CompanyProgress, type CompanyProgressReservation } from "./company-progress.js";
import { loadCompanyFreshness, type CompanyFreshnessProvider } from "./company-freshness.js";
import {
  companyMemoryRequestDigest, transitionRequestDigest, transitionReadResponseSchema, type TransitionReadArguments,
} from "./company-transition-read.js";
import type { CompanyClient, CompanyOperation } from "./company-candidate-transport.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { readCandidateCredential } from "./integration/candidate-reader-credential.js";
import { parseCompanyJson } from "./company-candidate-json.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sbReceiptSchema = z.object({
  receipt_id: z.string().regex(/^cmreceipt:v1:[a-f0-9]{64}$/),
  receipt_digest: digest,
  operation: z.enum(["accept", "reject", "mark_processed"]),
  state: z.enum(["accepted", "rejected", "processed_complete"]),
  handoff_id: z.string().min(1).max(256),
}).strict().refine(value => value.receipt_id === `cmreceipt:v1:${value.receipt_digest.slice(7)}`);
const sbReceiptV2Schema = z.union([sbReceiptSchema, sbReceiptSchema.safeExtend({
  receipt_created_at: z.iso.datetime({ precision: 3 }),
  decision_at: z.iso.datetime({ precision: 3 }),
  accepted_at: z.iso.datetime({ precision: 3 }).nullable(),
})]);
export type CompanySbReceipt = z.infer<typeof sbReceiptV2Schema>;
const completionSchema = z.object({
  schema_version: z.literal(1),
  state: z.literal("completed"),
  request_id: z.string(),
  command_digest: digest,
  candidate_id: z.string(),
  content_digest: digest,
  acceptance_receipt_digest: digest,
  effect_digest: digest,
}).strict();
export type CompanyCompletion = z.infer<typeof completionSchema>;
export interface CompanyCompletionVerifier {
  readonly version?: 1;
  verify(command: CompanyCommand, acceptance: CompanySbReceipt): Promise<unknown>;
}

/** Operator-pinned, idempotent downstream executor/verifier. No caller-supplied command or shell. */
export function createCompanyCompletionVerifier(path: string): CompanyCompletionVerifier {
  const parsed = z.object({
    schema_version: z.literal(1),
    executable: z.string().startsWith("/"),
    args: z.array(z.string().max(4096)).max(16),
  }).strict().safeParse(parseCompanyJson(readCandidateCredential(path)));
  if (!parsed.success) throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
  const config = parsed.data;
  try {
    const uid = process.getuid?.();
    const executable = lstatSync(config.executable);
    if (realpathSync(config.executable) !== config.executable || !executable.isFile()
      || (executable.uid !== uid && executable.uid !== 0)
      || (executable.mode & 0o022) !== 0 || (executable.mode & 0o111) === 0) {
      throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
    }
    for (let parent = dirname(config.executable);; parent = dirname(parent)) {
      const info = lstatSync(parent);
      if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0)
        || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
        throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
      }
      if (parent === "/") break;
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
  }
  return {
    verify(command, acceptance) {
      return new Promise((resolve, reject) => {
        let stdinFailed = false;
        const child = execFile(config.executable, [...config.args], {
          shell: false, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1_048_576, encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        }, (error, stdout) => {
          if (error || stdinFailed) { reject(new JarvisError("COMPANY_COMPLETION_UNVERIFIED")); return; }
          const result = parseCompanyJson(stdout);
          if (result === undefined) reject(new JarvisError("COMPANY_COMPLETION_UNVERIFIED"));
          else resolve(result);
        });
        child.stdin?.on("error", () => {
          stdinFailed = true;
          child.kill("SIGKILL");
        });
        child.stdin?.end(canonicalize({ schema_version: 1, command, acceptance }));
      });
    },
  };
}

type HandoffRow = {
  current: number; context_json: string; status: string;
  completion_json: string | null; lease_token: string | null; lease_expires_at: string | null;
};

/** This worker never receives a representative signer or candidate content. */
export class CompanyCandidateExecutor {
  constructor(
    private readonly db: AuthorityDb,
    private readonly client: CompanyClient,
    private readonly completion?: CompanyCompletionVerifier | CompanyCompletionVerifierV2,
    private readonly clock: () => Date = () => new Date(),
    private readonly freshness: CompanyFreshnessProvider = loadCompanyFreshness({ schema_version: 2, kind: "unconfigured" }),
  ) {}

  async execute(requestId: string) {
    const control = new ControlPlane(this.db);
    const stored = control.get(requestId);
    if (!stored) throw new JarvisError("COMPANY_HANDOFF_NOT_FOUND");
    if (stored.schema_version === 2) return this.executeV2(stored);
    const verifier = this.completion;
    if (verifier?.version === 2) throw new JarvisError("COMPANY_COMPLETION_CONFIG_INVALID");
    assertCompanyKeySeparation(this.db, this.client);
    const command = parseCompanyCommand({
      schema_version: stored.schema_version, request_id: stored.request_id, action: stored.action,
      action_level: stored.action_level, target: stored.target, args: stored.args,
      reversible: stored.reversible, requested_by: stored.requested_by,
      requested_at: stored.requested_at, expires_at: stored.expires_at, nonce: stored.nonce,
    });
    assertCompanyContext(command, this.client.context);
    if (readCompanyApprovalBinding(this.db, command.target)) throw new JarvisError("ENROLLMENT_REQUIRED");
    const row = this.db.db.prepare("SELECT * FROM company_candidate_handoffs WHERE request_id=?")
      .get(requestId) as HandoffRow | undefined;
    if (!row || row.current !== 1
      || canonicalize(companyEnrollmentContext(JSON.parse(row.context_json))) !== canonicalize(companyEnrollmentContext(this.client.context))) {
      throw new JarvisError("COMPANY_HANDOFF_NOT_CURRENT");
    }
    const receiptRow = this.db.db.prepare(
      `SELECT a.payload_json,k.public_key_pem,k.principal_id FROM control_command_receipts a
       JOIN trusted_authority_keys k ON k.key_id=a.key_id
       JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
       WHERE a.request_id=?`,
    ).get(requestId) as { payload_json: string; public_key_pem: string; principal_id: string } | undefined;
    if (!receiptRow) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
    const approval: CommandApprovalReceipt = JSON.parse(receiptRow.payload_json);
    const operation = approval.decision === "approve" ? "accept" : "reject";
    const acknowledged = this.readReceipt(requestId, operation);
    const redeemed = this.db.db.prepare("SELECT 1 FROM control_command_redemptions WHERE request_id=?").get(requestId);
    const proofNow = acknowledged ? new Date(approval.issued_at) : this.clock();
    if (approval.request_id !== requestId || approval.command_digest !== stored.command_digest
      || approval.signer_principal_id !== command.args.owner || receiptRow.principal_id !== command.args.owner
      || !verifyCommandApproval(approval, receiptRow.public_key_pem, proofNow)
      || Date.parse(approval.expires_at) > Date.parse(command.expires_at)
      || (!acknowledged && Date.parse(command.expires_at) <= this.clock().getTime())
      || !["approved", "rejected", "completed"].includes(stored.state)) {
      throw new JarvisError("CONTROL_APPROVAL_INVALID");
    }
    this.assertNotRevoked(command, approval);
    if (row.status === "completed" || row.status === "rejected") return this.result(requestId, row.status);
    const token = randomUUID();
    const instant = this.clock();
    this.db.db.transaction(() => {
      const changed = this.db.db.prepare(
        `UPDATE company_candidate_handoffs SET lease_token=?,lease_expires_at=?,updated_at=?
         WHERE request_id=? AND current=1 AND status NOT IN ('completed','rejected','superseded')
         AND (lease_token IS NULL OR lease_expires_at<=?)`,
      ).run(token, new Date(instant.getTime() + 60_000).toISOString(), instant.toISOString(), requestId, instant.toISOString());
      if (changed.changes !== 1) throw new JarvisError("COMPANY_EXECUTION_BUSY");
      if (!redeemed) this.db.db.prepare(
        "INSERT INTO control_command_redemptions(receipt_id,request_id,lease_fence,redeemed_at) VALUES(?,?,1,?)",
      ).run(approval.receipt_id, requestId, instant.toISOString());
    }).immediate();
    try {
      let receipt = acknowledged;
      if (!receipt) {
        this.update(requestId, token, "invoking");
        this.assertNotRevoked(command, approval);
        receipt = this.parseReceipt(
          await this.client.call(operation, {
            candidate_id: command.target.candidate_id, handoff_id: requestId, approval,
          }, this.clock()), requestId, operation,
        );
        this.persistReceipt(requestId, token, receipt);
      }
      if (operation === "reject") return this.result(requestId, "rejected");
      let completion = row.completion_json === null ? undefined : completionSchema.parse(JSON.parse(row.completion_json));
      if (!completion) {
        if (!verifier) return this.result(requestId, acknowledged ? row.status : "accepted");
        this.update(requestId, token, "verifying");
        this.assertNotRevoked(command, approval);
        const parsed = completionSchema.safeParse(await verifier.verify(command, receipt));
        if (!parsed.success || parsed.data.request_id !== requestId || parsed.data.command_digest !== stored.command_digest
          || parsed.data.candidate_id !== command.target.candidate_id
          || parsed.data.content_digest !== command.target.content_digest
          || parsed.data.acceptance_receipt_digest !== receipt.receipt_digest) {
          throw new JarvisError("COMPANY_COMPLETION_UNVERIFIED");
        }
        completion = parsed.data;
        const saved = this.db.db.prepare(
          "UPDATE company_candidate_handoffs SET completion_json=?,updated_at=? WHERE request_id=? AND lease_token=?",
        ).run(canonicalize(completion), this.clock().toISOString(), requestId, token);
        if (saved.changes !== 1) throw new JarvisError("COMPANY_EXECUTION_BUSY");
      }
      this.update(requestId, token, "completing");
      this.assertNotRevoked(command, approval);
      const processed = this.parseReceipt(await this.client.call("mark_processed", {
        candidate_id: command.target.candidate_id, handoff_id: requestId,
      }, this.clock()), requestId, "mark_processed");
      this.persistReceipt(requestId, token, processed, completion);
      return this.result(requestId, "completed");
    } catch (error) {
      const code = error instanceof JarvisError ? error.code : "COMPANY_EXECUTION_UNCERTAIN";
      this.db.db.prepare(
        "UPDATE company_candidate_handoffs SET status='uncertain',failure_code=?,updated_at=? WHERE request_id=? AND lease_token=?",
      ).run(code, this.clock().toISOString(), requestId, token);
      throw error;
    } finally {
      this.db.db.prepare(
        "UPDATE company_candidate_handoffs SET lease_token=NULL,lease_expires_at=NULL WHERE request_id=? AND lease_token=?",
      ).run(requestId, token);
    }
  }

  private async executeV2(stored: StoredControlCommand) {
    const requestId = stored.request_id;
    const verifier = this.v2Verifier();
    assertCompanyKeySeparation(this.db, this.client);
    const input = {
      schema_version: stored.schema_version, request_id: stored.request_id, action: stored.action,
      action_level: stored.action_level, target: stored.target, args: stored.args,
      reversible: stored.reversible, requested_by: stored.requested_by,
      requested_at: stored.requested_at, expires_at: stored.expires_at, nonce: stored.nonce,
    };
    const command = decodeCompanyCommandV2(input);
    assertCompanyContext(command, this.client.context);
    const row = this.db.db.prepare("SELECT * FROM company_candidate_handoffs WHERE request_id=?")
      .get(requestId) as HandoffRow | undefined;
    if (!row || row.current !== 1
      || canonicalize(companyEnrollmentContext(JSON.parse(row.context_json))) !== canonicalize(companyEnrollmentContext(this.client.context))) {
      throw new JarvisError("COMPANY_HANDOFF_NOT_CURRENT");
    }
    const receiptRow = this.db.db.prepare(
      `SELECT a.payload_json FROM control_command_receipts a WHERE a.request_id=?`,
    ).get(requestId) as { payload_json: string } | undefined;
    if (!receiptRow) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
    const approval: CommandApprovalReceipt = JSON.parse(receiptRow.payload_json);
    const operation = approval.decision === "approve" ? "accept" : "reject";
    const progress = new CompanyProgress(this.db, this.freshness);
    const pending = progress.pending(command, operation);
    const acknowledged = this.readReceipt(requestId, operation, 2);
    assertCompanyApprovalPin(this.db, command, approval);
    const pendingDecision = progress.pending(command, approval.decision === "approve" ? "decide_approve" : "decide_reject");
    if (pendingDecision) {
      progress.finish(pendingDecision, controlValueDigest(approval), approval.decision === "approve" ? "approved" : "rejected", this.clock());
    }
    let completion: CompanyCompletionV2 | undefined;
    if (row.completion_json !== null) {
      const parsed = companyCompletionV2Schema.safeParse(JSON.parse(row.completion_json));
      if (!parsed.success || parsed.data.request_id !== requestId || parsed.data.command_digest !== stored.command_digest
        || parsed.data.candidate_id !== command.target.candidate_id || parsed.data.content_digest !== command.target.content_digest
        || parsed.data.acceptance_receipt_digest !== acknowledged?.receipt_digest) throw new JarvisError("COMPANY_VERIFIER_INVALID");
      completion = parsed.data;
    }
    const pendingComplete = progress.pending(command, "complete");
    if (pendingComplete) {
      if (!completion) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      this.finishV2(progress, pendingComplete, completion.effect_digest, "completed");
    }
    const processed = this.readReceipt(requestId, "mark_processed", 2);
    const pendingProcessed = progress.pending(command, "mark_processed");
    if (pendingProcessed) {
      if (!processed || !completion) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      this.finishV2(progress, pendingProcessed, processed.receipt_digest, "processed_complete");
      return this.result(requestId, "completed", 2);
    }
    if (!pending && !acknowledged) {
      parseCompanyCommandV2(input, this.clock());
      assertCurrentCompanyPin(this.db, command, approval, this.clock());
    }
    if (!pending && !acknowledged && !["approved", "rejected"].includes(stored.state)) {
      throw new JarvisError("CONTROL_APPROVAL_INVALID");
    }
    if ((row.status === "completed" || row.status === "rejected") && !pending) {
      if (this.db.db.prepare("SELECT 1 FROM company_progress_reservations WHERE request_id=? AND evidence_digest IS NULL").get(requestId)) {
        throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      }
      return this.result(requestId, row.status, 2);
    }
    const token = randomUUID();
    const instant = this.clock();
    const redeemed = this.db.db.prepare("SELECT 1 FROM control_command_redemptions WHERE request_id=?").get(requestId);
    this.db.db.transaction(() => {
      const changed = this.db.db.prepare(
        `UPDATE company_candidate_handoffs SET lease_token=?,lease_expires_at=?,updated_at=?
         WHERE request_id=? AND current=1 AND status NOT IN ('completed','rejected','superseded')
         AND (lease_token IS NULL OR lease_expires_at<=?)`,
      ).run(token, new Date(instant.getTime() + 60_000).toISOString(), instant.toISOString(), requestId, instant.toISOString());
      if (changed.changes !== 1) throw new JarvisError("COMPANY_EXECUTION_BUSY");
      if (!redeemed) this.db.db.prepare(
        "INSERT INTO control_command_redemptions(receipt_id,request_id,lease_fence,redeemed_at) VALUES(?,?,1,?)",
      ).run(approval.receipt_id, requestId, instant.toISOString());
    }).immediate();
    try {
      let receipt = acknowledged;
      const mutation = pending ?? (receipt ? undefined : this.reserveV2(progress, command, operation, transitionRequestDigest(operation, {
        candidate_id: command.target.candidate_id, handoff_id: requestId, approval,
      }), this.clock()));
      if (!receipt && mutation) {
        if (pending) receipt = await this.recoverTransition(command, approval, operation, stored.command_digest);
        else {
          this.update(requestId, token, "invoking");
          receipt = this.parseReceipt(await this.client.call(operation, {
            candidate_id: command.target.candidate_id, handoff_id: requestId, approval,
          }, this.clock()), requestId, operation, 2);
        }
        this.persistReceipt(requestId, token, receipt);
        this.finishV2(progress, mutation, receipt.receipt_digest, operation === "accept" ? "accepted" : "rejected", token);
      } else if (mutation && receipt) {
        this.finishV2(progress, mutation, receipt.receipt_digest, operation === "accept" ? "accepted" : "rejected", token);
      }
      if (!receipt) throw new JarvisError("COMPANY_EXECUTION_UNCERTAIN");
      if (operation === "reject") return this.result(requestId, "rejected", 2);
      if (!completion) {
        if (!verifier) return this.result(requestId, receipt.state, 2);
        try {
          parseCompanyCommandV2(input, this.clock());
          assertCurrentCompanyPin(this.db, command, approval, this.clock());
        } catch (error) {
          if (pending && !acknowledged && error instanceof JarvisError) return this.result(requestId, receipt.state, 2);
          throw error;
        }
        const reserved = this.reserveV2(progress, command, "complete", receipt.receipt_digest, this.clock());
        this.update(requestId, token, "verifying");
        const verified = companyCompletionV2Schema.safeParse(await verifier.verify(command, {
          receipt_id: receipt.receipt_id, receipt_digest: receipt.receipt_digest,
          operation: "accept", state: "accepted", handoff_id: requestId,
        }, stored.command_digest));
        if (!verified.success || verified.data.request_id !== requestId
          || verified.data.command_digest !== stored.command_digest
          || verified.data.candidate_id !== command.target.candidate_id
          || verified.data.content_digest !== command.target.content_digest
          || verified.data.acceptance_receipt_digest !== receipt.receipt_digest
          || verified.data.effect_digest === stored.command_digest
          || verified.data.effect_digest === command.target.content_digest
          || verified.data.effect_digest === receipt.receipt_digest) throw new JarvisError("COMPANY_VERIFIER_INVALID");
        completion = verified.data;
        const saved = this.db.db.prepare(
          "UPDATE company_candidate_handoffs SET completion_json=?,updated_at=? WHERE request_id=? AND lease_token=?",
        ).run(canonicalize(completion), this.clock().toISOString(), requestId, token);
        if (saved.changes !== 1) throw new JarvisError("COMPANY_EXECUTION_BUSY");
        this.finishV2(progress, reserved, completion.effect_digest, "completed", token);
      }
      if (!processed) {
        parseCompanyCommandV2(input, this.clock());
        assertCurrentCompanyPin(this.db, command, approval, this.clock());
        const reserved = this.reserveV2(progress, command, "mark_processed", stored.command_digest, this.clock());
        this.update(requestId, token, "completing");
        const marked = this.parseReceipt(await this.client.call("mark_processed", {
          candidate_id: command.target.candidate_id, handoff_id: requestId,
        }, this.clock()), requestId, "mark_processed", 2);
        this.persistReceipt(requestId, token, marked, completion, 2);
        this.finishV2(progress, reserved, marked.receipt_digest, "processed_complete", token);
      }
      return this.result(requestId, "completed", 2);
    } catch (error) {
      const code = error instanceof JarvisError ? error.code : "COMPANY_EXECUTION_UNCERTAIN";
      this.db.db.prepare(
        "UPDATE company_candidate_handoffs SET status='uncertain',failure_code=?,updated_at=? WHERE request_id=? AND lease_token=?",
      ).run(code, this.clock().toISOString(), requestId, token);
      throw error;
    } finally {
      this.db.db.prepare(
        "UPDATE company_candidate_handoffs SET lease_token=NULL,lease_expires_at=NULL WHERE request_id=? AND lease_token=?",
      ).run(requestId, token);
    }
  }

  private reserveV2(progress: CompanyProgress, command: CompanyCommandV2, operation: "accept" | "reject" | "complete" | "mark_processed", eventDigest: string, now: Date): CompanyProgressReservation {
    try {
      return progress.reserve(command, operation, eventDigest, now);
    } catch (error) {
      if (error instanceof JarvisError && error.code === "COMPANY_DUPLICATE_OPERATION") {
        throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      }
      throw error;
    }
  }

  private finishV2(progress: CompanyProgress, reservation: CompanyProgressReservation, evidenceDigest: string, terminalState: "accepted" | "rejected" | "completed" | "processed_complete", token?: string): void {
    const started = this.clock();
    if (token !== undefined) this.ownedHandoff(reservation.request_id, token, started);
    progress.finish(reservation, evidenceDigest, terminalState, started, () => {
      const now = this.clock();
      if (token !== undefined) this.ownedHandoff(reservation.request_id, token, now);
      const owned = token === undefined ? "" : " AND lease_token=? AND lease_expires_at>?";
      const ownedArgs = token === undefined ? [] : [token, now.toISOString()];
      if (terminalState === "accepted" || terminalState === "rejected") {
        const current = this.db.db.prepare(
          "SELECT status FROM company_candidate_handoffs WHERE request_id=? AND current=1",
        ).get(reservation.request_id) as { status: string } | undefined;
        if (current?.status === "completed" || current?.status === "rejected" || current?.status === "superseded") {
          if (current.status !== terminalState) throw new JarvisError("CONTROL_STATE_CONFLICT");
          return;
        }
        const handoff = this.db.db.prepare(
          `UPDATE company_candidate_handoffs SET status=?,failure_code=NULL,updated_at=? WHERE request_id=? AND current=1${owned}`,
        ).run(terminalState, now.toISOString(), reservation.request_id, ...ownedArgs);
        if (handoff.changes !== 1) throw new JarvisError("CONTROL_STATE_CONFLICT");
      }
      if (terminalState === "completed") return;
      if (terminalState === "processed_complete") {
        const current = this.db.db.prepare(
          "SELECT status FROM company_candidate_handoffs WHERE request_id=? AND current=1",
        ).get(reservation.request_id) as { status: string } | undefined;
        if (current?.status === "completed") return;
        const control = this.db.db.prepare(
          "UPDATE control_command_requests SET state='completed',completed_at=COALESCE(completed_at,?) WHERE request_id=? AND state IN ('approved','completed')",
        ).run(now.toISOString(), reservation.request_id);
        const handoff = this.db.db.prepare(
          `UPDATE company_candidate_handoffs SET status='completed',failure_code=NULL,updated_at=? WHERE request_id=? AND current=1${owned}`,
        ).run(now.toISOString(), reservation.request_id, ...ownedArgs);
        if (control.changes !== 1 || handoff.changes !== 1) throw new JarvisError("CONTROL_STATE_CONFLICT");
      }
    });
  }

  private v2Verifier(): CompanyCompletionVerifierV2 | undefined {
    const completion = this.completion;
    if (!completion) return undefined;
    if (completion.version !== 2) throw new JarvisError("COMPANY_VERIFIER_INVALID");
    return completion;
  }

  private async recoverTransition(command: CompanyCommandV2, approval: CommandApprovalReceipt, operation: "accept" | "reject", commandDigest: string): Promise<CompanySbReceipt> {
    const original = { candidate_id: command.target.candidate_id, handoff_id: command.request_id, approval };
    const query: TransitionReadArguments = {
      candidate_id: command.target.candidate_id, handoff_id: command.request_id, operation,
      transition_request_digest: transitionRequestDigest(operation, original),
      command_digest: commandDigest, content_digest: command.target.content_digest,
      approval_policy_version: command.args.approval_policy_version,
      approval_binding_digest: command.args.approval_binding_digest,
    };
    const lookupNonce = `jarvis:${randomUUID()}`;
    const parsed = transitionReadResponseSchema.safeParse(await this.client.call("read_transition_receipt", query, this.clock(), lookupNonce));
    if (!parsed.success) throw new JarvisError("COMPANY_CONTRACT_INVALID");
    const response = parsed.data;
    if (response.provider_instance_id !== command.target.provider_instance_id
      || response.workspace_id !== command.target.workspace_id
      || response.lookup_nonce !== lookupNonce
      || canonicalize(response.selector) !== canonicalize(query)
      || response.lookup_request_digest !== companyMemoryRequestDigest("read_transition_receipt", query)) {
      throw new JarvisError("COMPANY_SB_RECEIPT_INVALID");
    }
    if (response.outcome === "evidence_absent") throw new JarvisError("COMPANY_RECEIPT_EVIDENCE_ABSENT");
    if (response.outcome !== "found" || !response.receipt) throw new JarvisError("COMPANY_EXECUTION_UNCERTAIN");
    const receipt = response.receipt;
    const originalTime = Date.parse(operation === "accept" ? receipt.accepted_at ?? "" : receipt.decision_at);
    if (!Number.isFinite(originalTime)
      || originalTime < Math.max(Date.parse(command.requested_at), Date.parse(approval.not_before))
      || originalTime >= Math.min(Date.parse(command.expires_at), Date.parse(approval.expires_at))) {
      throw new JarvisError("COMPANY_RECEIPT_EVIDENCE_ABSENT");
    }
    return this.parseReceipt({
      receipt_id: receipt.receipt_id, receipt_digest: receipt.receipt_digest, operation: receipt.operation,
      state: receipt.state, handoff_id: receipt.handoff_id, receipt_created_at: receipt.receipt_created_at,
      decision_at: receipt.decision_at, accepted_at: receipt.accepted_at,
    }, command.request_id, operation, 2);
  }

  private assertNotRevoked(command: CompanyCommand, approval: CommandApprovalReceipt): void {
    const key = this.db.db.prepare(
      `SELECT k.public_key_pem,k.principal_id FROM trusted_authority_keys k
       JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision' WHERE k.key_id=?`,
    ).get(approval.key_id) as { public_key_pem: string; principal_id: string } | undefined;
    if (!key || key.principal_id !== command.args.owner
      || !verifyCommandApproval(approval, key.public_key_pem, new Date(approval.issued_at))) {
      throw new JarvisError("CONTROL_APPROVAL_INVALID");
    }
    if (this.db.db.prepare(
      "SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?",
    ).get(command.request_id, approval.receipt_id) || this.db.db.prepare(
      "SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?,?,?)",
    ).get(command.request_id, approval.receipt_id, approval.command_digest, approval.key_id, approval.signer_principal_id)) {
      throw new JarvisError("CONTROL_APPROVAL_REVOKED");
    }
  }

  private parseReceipt(value: unknown, requestId: string, operation: CompanyOperation, version: 1 | 2 = 1): CompanySbReceipt {
    const parsed = (version === 2 ? sbReceiptV2Schema : sbReceiptSchema).safeParse(value);
    const state = operation === "accept" ? "accepted" : operation === "reject" ? "rejected" : "processed_complete";
    if (!parsed.success || parsed.data.handoff_id !== requestId || parsed.data.operation !== operation
      || parsed.data.state !== state) throw new JarvisError("COMPANY_SB_RECEIPT_INVALID");
    return parsed.data;
  }

  private readReceipt(requestId: string, operation: string, version: 1 | 2 = 1): CompanySbReceipt | undefined {
    const row = this.db.db.prepare(
      "SELECT payload_json FROM company_candidate_sb_receipts WHERE request_id=? AND operation=?",
    ).get(requestId, operation) as { payload_json: string } | undefined;
    const known = operation === "accept" || operation === "reject" || operation === "mark_processed" ? operation : "reject";
    return row ? this.parseReceipt(JSON.parse(row.payload_json), requestId, known, version) : undefined;
  }

  private ownedHandoff(requestId: string, token: string, now: Date): { status: string } {
    const row = this.db.db.prepare(
      "SELECT status,lease_expires_at FROM company_candidate_handoffs WHERE request_id=? AND current=1 AND lease_token=?",
    ).get(requestId, token) as { status: string; lease_expires_at: string | null } | undefined;
    if (!row?.lease_expires_at || Date.parse(row.lease_expires_at) <= now.getTime()) {
      throw new JarvisError("COMPANY_EXECUTION_BUSY");
    }
    return row;
  }

  private update(requestId: string, token: string, status: string): void {
    const changed = this.db.db.prepare(
      "UPDATE company_candidate_handoffs SET status=?,failure_code=NULL,updated_at=? WHERE request_id=? AND lease_token=?",
    ).run(status, this.clock().toISOString(), requestId, token);
    if (changed.changes !== 1) throw new JarvisError("COMPANY_EXECUTION_BUSY");
  }

  private persistReceipt(requestId: string, token: string, receipt: CompanySbReceipt, completion?: CompanyCompletion | CompanyCompletionV2, version: 1 | 2 = 1): void {
    const status = receipt.state === "processed_complete" ? version === 2 ? "completing" : "completed" : receipt.state;
    this.db.db.transaction(() => {
      this.db.db.prepare(
        `INSERT INTO company_candidate_sb_receipts(request_id,operation,receipt_id,receipt_digest,payload_json,observed_at)
         VALUES(?,?,?,?,?,?)`,
      ).run(requestId, receipt.operation, receipt.receipt_id, receipt.receipt_digest, canonicalize(receipt), this.clock().toISOString());
      this.update(requestId, token, status);
      if (status === "completed") {
        const changed = this.db.db.prepare(
          "UPDATE control_command_requests SET state='completed',completed_at=? WHERE request_id=? AND state='approved'",
        ).run(this.clock().toISOString(), requestId);
        if (changed.changes !== 1) throw new JarvisError("CONTROL_STATE_CONFLICT");
      }
      const payload = { receipt, ...(completion ? { completion } : {}) };
      this.db.db.prepare(
        `INSERT INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at)
         VALUES(?,?,?,?,?,?)`,
      ).run(`company:${receipt.receipt_id}`, requestId, `company.candidate.${receipt.operation}`,
        canonicalize(payload), controlValueDigest(payload), this.clock().toISOString());
      new ControlPlane(this.db).emit({
        event_id: `evt:${requestId}:company:${receipt.operation}`, event_type: `control.command.company.${receipt.operation}`,
        source: "company-candidate-processor", subject: requestId, correlation_id: requestId,
        payload: receipt, created_at: this.clock().toISOString(),
      });
    }).immediate();
  }

  private result(requestId: string, state: string, version: 1 | 2 = 1) {
    const rows = this.db.db.prepare(
      "SELECT payload_json FROM company_candidate_sb_receipts WHERE request_id=? ORDER BY operation",
    ).all(requestId) as { payload_json: string }[];
    return { request_id: requestId, state, receipts: rows.map(row => (version === 2 ? sbReceiptV2Schema : sbReceiptSchema).parse(JSON.parse(row.payload_json))) };
  }
}
