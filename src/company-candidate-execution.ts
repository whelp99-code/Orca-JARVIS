import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { ControlPlane } from "./control-plane.js";
import { controlValueDigest, verifyCommandApproval } from "./control-plane-contract.js";
import type { CommandApprovalReceipt } from "./control-plane-contract.js";
import { parseCompanyCommand, type CompanyCommand } from "./company-candidate-contract.js";
import { assertCompanyContext, assertCompanyKeySeparation, companyEnrollmentContext } from "./company-candidate-import.js";
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
export type CompanySbReceipt = z.infer<typeof sbReceiptSchema>;
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
    private readonly completion?: CompanyCompletionVerifier,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(requestId: string) {
    assertCompanyKeySeparation(this.db, this.client);
    const control = new ControlPlane(this.db);
    const stored = control.get(requestId);
    if (!stored) throw new JarvisError("COMPANY_HANDOFF_NOT_FOUND");
    const command = parseCompanyCommand({
      schema_version: stored.schema_version, request_id: stored.request_id, action: stored.action,
      action_level: stored.action_level, target: stored.target, args: stored.args,
      reversible: stored.reversible, requested_by: stored.requested_by,
      requested_at: stored.requested_at, expires_at: stored.expires_at, nonce: stored.nonce,
    });
    assertCompanyContext(command, this.client.context);
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
        if (!this.completion) return this.result(requestId, acknowledged ? row.status : "accepted");
        this.update(requestId, token, "verifying");
        this.assertNotRevoked(command, approval);
        const parsed = completionSchema.safeParse(await this.completion.verify(command, receipt));
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

  private parseReceipt(value: unknown, requestId: string, operation: CompanyOperation): CompanySbReceipt {
    const parsed = sbReceiptSchema.safeParse(value);
    const state = operation === "accept" ? "accepted" : operation === "reject" ? "rejected" : "processed_complete";
    if (!parsed.success || parsed.data.handoff_id !== requestId || parsed.data.operation !== operation
      || parsed.data.state !== state) throw new JarvisError("COMPANY_SB_RECEIPT_INVALID");
    return parsed.data;
  }

  private readReceipt(requestId: string, operation: string): CompanySbReceipt | undefined {
    const row = this.db.db.prepare(
      "SELECT payload_json FROM company_candidate_sb_receipts WHERE request_id=? AND operation=?",
    ).get(requestId, operation) as { payload_json: string } | undefined;
    return row ? this.parseReceipt(JSON.parse(row.payload_json), requestId, operation === "accept" ? "accept" : "reject") : undefined;
  }

  private update(requestId: string, token: string, status: string): void {
    const changed = this.db.db.prepare(
      "UPDATE company_candidate_handoffs SET status=?,failure_code=NULL,updated_at=? WHERE request_id=? AND lease_token=?",
    ).run(status, this.clock().toISOString(), requestId, token);
    if (changed.changes !== 1) throw new JarvisError("COMPANY_EXECUTION_BUSY");
  }

  private persistReceipt(requestId: string, token: string, receipt: CompanySbReceipt, completion?: CompanyCompletion): void {
    const status = receipt.state === "processed_complete" ? "completed" : receipt.state;
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

  private result(requestId: string, state: string) {
    const rows = this.db.db.prepare(
      "SELECT payload_json FROM company_candidate_sb_receipts WHERE request_id=? ORDER BY operation",
    ).all(requestId) as { payload_json: string }[];
    return { request_id: requestId, state, receipts: rows.map(row => sbReceiptSchema.parse(JSON.parse(row.payload_json))) };
  }
}
