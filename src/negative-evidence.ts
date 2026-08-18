import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { controlCommandDigest, type ControlCommandRequestInput } from "./control-plane.js";

export type NegativeEvidenceReason =
  | "invalid_assumption"
  | "failed_approach"
  | "blocked_dependency"
  | "verification_failure"
  | "external_uncertain";

export interface NegativeEvidenceInputV1 {
  schema_version: 1;
  task_id: string;
  attempt_id: string;
  reason_code: NegativeEvidenceReason;
  scope: readonly string[];
  summary: string;
  evidence_digest: `sha256:${string}`;
}

export interface NegativeEvidenceBinding {
  request_id: string;
  receipt_id: string;
  fence: number;
}

export interface StoredNegativeEvidence {
  evidence_id: string;
  task_id: string;
  attempt_id: string;
  reason_code: NegativeEvidenceReason;
  scope: readonly string[];
  summary: string;
  evidence_digest: string;
  request_id: string;
  receipt_id: string;
  created_at: string;
}

const INPUT_KEYS = ["schema_version", "task_id", "attempt_id", "reason_code", "scope", "summary", "evidence_digest"] as const;
const BINDING_KEYS = ["request_id", "receipt_id", "fence"] as const;
const REASONS = ["invalid_assumption", "failed_approach", "blocked_dependency", "verification_failure", "external_uncertain"] as const;
const CREDENTIAL = /(?:\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GITHUB_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|API_KEY|api_key|access_token|refresh_token|client_secret|token|secret|password|authorization|cookie|set-cookie)\b\s*[:=]|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk-(?:proj-|ant-[A-Za-z0-9-]*|live-|test-)?|gh[pousr]_|github_pat_|xox[baprs]-|AIza|glpat-|gldt-|glrt-|glptt-|gloas-|npm_|pypi-|hf_)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ID_LIMIT = 256;
const SUMMARY_LIMIT = 1024;
const SCOPE_ITEM_LIMIT = 1024;
const SCOPE_MIN = 1;
const SCOPE_MAX = 20;

const invalid = (): never => { throw new JarvisError("NEGATIVE_EVIDENCE_INPUT_INVALID"); };
const conflict = (): never => { throw new JarvisError("NEGATIVE_EVIDENCE_REPLAY_CONFLICT"); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
};
const nfcString = (value: unknown, max: number): string => {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.trim().length === 0) return invalid();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > max) return invalid();
  return value;
};
const identifier = (value: unknown): string => nfcString(value, ID_LIMIT);
const digestOf = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

function parseReason(value: unknown): NegativeEvidenceReason {
  if (typeof value !== "string" || !(REASONS as readonly string[]).includes(value)) invalid();
  return value as NegativeEvidenceReason;
}

const credentialSafe = (value: string): string => CREDENTIAL.test(value) ? invalid() : value;

function parseScope(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < SCOPE_MIN || value.length > SCOPE_MAX) return invalid();
  return value.map((item: unknown) => credentialSafe(nfcString(item, SCOPE_ITEM_LIMIT)));
}

function parseSummary(value: unknown): string {
  return credentialSafe(nfcString(value, SUMMARY_LIMIT));
}

function parseDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid();
  return value as `sha256:${string}`;
}

export function parseNegativeEvidenceInput(value: unknown): NegativeEvidenceInputV1 {
  const input = object(value);
  exactKeys(input, INPUT_KEYS);
  if (input.schema_version !== 1) invalid();
  return {
    schema_version: 1,
    task_id: credentialSafe(identifier(input.task_id)),
    attempt_id: credentialSafe(identifier(input.attempt_id)),
    reason_code: parseReason(input.reason_code),
    scope: parseScope(input.scope),
    summary: parseSummary(input.summary),
    evidence_digest: parseDigest(input.evidence_digest),
  };
}

export function parseNegativeEvidenceBinding(value: unknown): NegativeEvidenceBinding {
  const input = object(value);
  exactKeys(input, BINDING_KEYS);
  if (!Number.isSafeInteger(input.fence) || Number(input.fence) < 1) invalid();
  return { request_id: identifier(input.request_id), receipt_id: identifier(input.receipt_id), fence: Number(input.fence) };
}

export function negativeEvidenceId(input: NegativeEvidenceInputV1): string {
  return digestOf({
    task_id: input.task_id,
    attempt_id: input.attempt_id,
    reason_code: input.reason_code,
    scope: input.scope,
    evidence_digest: input.evidence_digest,
  });
}

function stored(row: Record<string, unknown>): StoredNegativeEvidence {
  const scope = JSON.parse(String(row.scope_json)) as unknown;
  if (!Array.isArray(scope) || !scope.every(item => typeof item === "string")) throw new JarvisError("NEGATIVE_EVIDENCE_INPUT_INVALID");
  return {
    evidence_id: String(row.evidence_id),
    task_id: String(row.task_id),
    attempt_id: String(row.attempt_id),
    reason_code: parseReason(row.reason_code),
    scope,
    summary: String(row.summary),
    evidence_digest: String(row.evidence_digest),
    request_id: String(row.request_id),
    receipt_id: String(row.receipt_id),
    created_at: String(row.created_at),
  };
}

function load(authority: AuthorityDb, column: "evidence_id" | "request_id" | "receipt_id", value: string): StoredNegativeEvidence | undefined {
  const row = authority.db.prepare(`SELECT * FROM negative_evidence WHERE ${column}=?`).get(value) as Record<string, unknown> | undefined;
  return row ? stored(row) : undefined;
}

function sameRecord(prior: StoredNegativeEvidence, input: NegativeEvidenceInputV1, binding: NegativeEvidenceBinding, evidenceId: string): boolean {
  return prior.evidence_id === evidenceId
    && prior.task_id === input.task_id
    && prior.attempt_id === input.attempt_id
    && prior.reason_code === input.reason_code
    && canonicalize(prior.scope) === canonicalize(input.scope)
    && prior.summary === input.summary
    && prior.evidence_digest === input.evidence_digest
    && prior.request_id === binding.request_id
    && prior.receipt_id === binding.receipt_id;
}

function knownTask(authority: AuthorityDb, taskId: string): boolean {
  return Boolean(authority.db.prepare(`
    SELECT 1 FROM work_items WHERE id=?
    UNION ALL SELECT 1 FROM workflow_runs WHERE run_id=? OR correlation_id=? OR json_extract(input_json,'$.task_id')=?
    UNION ALL SELECT 1 FROM gjc_intents WHERE intent_id=? OR continuation_id=?
    UNION ALL SELECT 1 FROM control_command_requests WHERE action<>'evidence.negative.record' AND (request_id=? OR json_extract(target_json,'$.task_id')=? OR json_extract(args_json,'$.task_id')=?)
    LIMIT 1
  `).get(taskId, taskId, taskId, taskId, taskId, taskId, taskId, taskId, taskId));
}

function requireClaimedBinding(authority: AuthorityDb, input: NegativeEvidenceInputV1, binding: NegativeEvidenceBinding, now: Date): void {
  const row = authority.db.prepare(`
    SELECT r.*,a.receipt_id,a.decision,a.command_digest AS receipt_digest,a.expires_at AS approval_expires,
           x.lease_fence AS redemption_fence
    FROM control_command_requests r
    JOIN control_command_receipts a ON a.request_id=r.request_id AND a.receipt_id=?
    JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.receipt_id=a.receipt_id
    WHERE r.request_id=?
  `).get(binding.receipt_id, binding.request_id) as Record<string, unknown> | undefined;
  if (!row || row.action !== "evidence.negative.record" || Number(row.action_level) !== 2 || row.state !== "claimed" || row.decision !== "approve" || Number(row.lease_fence) !== binding.fence || Number(row.redemption_fence) !== binding.fence) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
  const nowMs = now.getTime();
  if (Date.parse(String(row.lease_expires_at)) <= nowMs || Date.parse(String(row.expires_at)) <= nowMs || Date.parse(String(row.approval_expires)) <= nowMs) throw new JarvisError("CONTROL_STALE_FENCE");
  const target = JSON.parse(String(row.target_json)) as unknown;
  const args = JSON.parse(String(row.args_json)) as unknown;
  if (canonicalize(args) !== canonicalize(input) || typeof target !== "object" || target === null || Array.isArray(target) || (target as Record<string, unknown>).task_id !== input.task_id) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
  const request: ControlCommandRequestInput = { schema_version: 1, request_id: String(row.request_id), action: String(row.action), action_level: Number(row.action_level) as ControlCommandRequestInput["action_level"], target: target as Record<string, unknown>, args: args as Record<string, unknown>, reversible: Boolean(row.reversible), requested_by: String(row.requested_by), requested_at: String(row.requested_at), expires_at: String(row.expires_at), nonce: String(row.nonce) };
  if (controlCommandDigest(request) !== row.command_digest || row.receipt_digest !== row.command_digest) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
  if (authority.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?").get(binding.request_id, binding.receipt_id) || authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference IN (?,?,?)").get(binding.request_id, binding.receipt_id, String(row.command_digest))) throw new JarvisError("CONTROL_APPROVAL_REVOKED");
  if (!knownTask(authority, input.task_id)) invalid();
}

function persistNegativeEvidence(authority: AuthorityDb, value: unknown, bindingValue: unknown, now: Date): StoredNegativeEvidence {
  const input = parseNegativeEvidenceInput(value);
  const binding = parseNegativeEvidenceBinding(bindingValue);
  if (!Number.isFinite(now.getTime())) invalid();
  const evidenceId = negativeEvidenceId(input);
  const createdAt = now.toISOString();
  requireClaimedBinding(authority, input, binding, now);
  const existing = [load(authority, "evidence_id", evidenceId), load(authority, "request_id", binding.request_id), load(authority, "receipt_id", binding.receipt_id)].filter((row): row is StoredNegativeEvidence => row !== undefined);
  if (existing.length > 0) {
    const first = existing[0];
    if (first === undefined || existing.some(row => row.evidence_id !== first.evidence_id) || !sameRecord(first, input, binding, evidenceId)) return conflict();
    return first;
  }
  authority.db.prepare("INSERT INTO negative_evidence(evidence_id,task_id,attempt_id,reason_code,scope_json,summary,evidence_digest,request_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(evidenceId, input.task_id, input.attempt_id, input.reason_code, canonicalize(input.scope), input.summary, input.evidence_digest, binding.request_id, binding.receipt_id, createdAt);
  const inserted = load(authority, "evidence_id", evidenceId);
  return inserted ?? invalid();
}

export function appendSettledNegativeEvidence(
  authority: AuthorityDb,
  control: { settle(requestId: string, fence: number, outcome: { state: "completed" | "failed" | "uncertain"; effect_type: string; payload: unknown; failure_code?: string }, now?: Date): void },
  command: { request_id: string; receipt_id: string; fence: number; args: unknown },
  now = new Date(),
  settledAt = now,
): { evidence_id: string; payload_digest: string } {
  return authority.db.transaction(() => {
    const recorded = persistNegativeEvidence(authority, command.args, { request_id: command.request_id, receipt_id: command.receipt_id, fence: command.fence }, now);
    const payload = {
      evidence_id: recorded.evidence_id,
      payload_digest: `sha256:${createHash("sha256").update(canonicalize({
        evidence_id: recorded.evidence_id,
        task_id: recorded.task_id,
        attempt_id: recorded.attempt_id,
        reason_code: recorded.reason_code,
        scope: recorded.scope,
        evidence_digest: recorded.evidence_digest,
      })).digest("hex")}`,
    };
    control.settle(command.request_id, command.fence, { state: "completed", effect_type: "evidence.negative.recorded", payload }, settledAt);
    const settled = authority.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(command.request_id) as { state?: string } | undefined;
    if (settled?.state === "claimed") throw new JarvisError("CONTROL_SETTLE_INVALID");
    return payload;
  })();
}
