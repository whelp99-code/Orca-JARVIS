import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { AuthorityDb } from "./db.js";
import { PreGjcShadow, type AuthorityReceipt, type OrcaResumeAdapter } from "./pre-gjc-shadow.js";
import { ingestClaudeHookEvent, ingestCodexAppServerEvent } from "./adapters.js";
import { classifyProgressEvidence } from "./progress-signal.js";
import type { ProgressEvidenceInput, ProgressSignal, ProgressSignalKey } from "./types.js";

export const REQUIRED_PRE_GJC_EVIDENCE = ["focused", "integration", "crash_replay", "cli", "full", "node24"] as const;
type EvidenceKind = typeof REQUIRED_PRE_GJC_EVIDENCE[number];
type RecordValue = Record<string, unknown>;
type KeyPurpose = "progress-signal" | "verification" | "census" | "authority-receipt";
export interface PreGjcTrustedKey { key_id: string; purpose: KeyPurpose; provider: "codex" | "claude"; public_key_pem: string; active: true; not_before: string; expires_at: string; }
export interface PreGjcEvidence { evidence_id: string; project: string; provider: "codex" | "claude"; terminal_id: string; session_id: string; incarnation_id: string; attempt_id: string; lease_id: string; fence: number; kind: EvidenceKind; argv: string[]; cwd: string; expected_exit: 0; actual_exit: 0; key_id: string; issued_at: string; signature: string; }
export interface PreGjcCensus { census_id: string; project: string; provider: "codex" | "claude"; terminal_id: string; session_id: string; incarnation_id: string; census_run_id: string; unresolved: []; resolved: string[]; key_id: string; issued_at: string; signature: string; }
export interface PreGjcAuthorityReceipt { receipt_id: string; request_id: string; project_id: string; provider: "codex" | "claude"; terminal_id: string; session_id: string; incarnation_id: string; signal_event_id: string; attempt_id: string; lease_id: string; fence: number; expires_at: string; decision: "approve" | "reject" | "needs_input"; answer?: string; key_id: string; issued_at: string; signature: string; }
export interface PreGjcTarget { provider: "codex" | "claude"; terminal_id: string; session_id: string; incarnation_id: string; cursor: string | null; connected: boolean; capture_complete: boolean; observed_at: string; signals: unknown[]; trusted_keys: PreGjcTrustedKey[]; evidence: PreGjcEvidence[]; census: PreGjcCensus; authority_receipt: PreGjcAuthorityReceipt; }
export interface PreGjcKeyRevocation { key_id: string; provider: "codex" | "claude"; purpose: KeyPurpose; reason: string; revoked_at: string; }
export interface PreGjcFixture { version: 1; targets: PreGjcTarget[]; revocations: PreGjcKeyRevocation[]; }

const DOMAIN = "orca-jarvis/pre-gjc-evidence/v1\0";
const fail = (): never => { throw new Error("signal rejected"); };
const isRecord = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: RecordValue, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const millis = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value;
const evidencePayload = (evidence: PreGjcEvidence) => { const { signature: ignored, ...payload } = evidence; void ignored; return payload; };
const censusPayload = (census: PreGjcCensus) => { const { signature: ignored, ...payload } = census; void ignored; return payload; };
const canonicalEd25519 = (pem: string): boolean => { try { const key = createPublicKey(pem); return key.asymmetricKeyType === "ed25519" && key.export({ type: "spki", format: "pem" }).toString() === pem; } catch { return false; } };
const canonicalSignature = (value: string): Buffer | undefined => { try { if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined; const result = Buffer.from(value, "base64url"); return result.length === 64 && result.toString("base64url") === value ? result : undefined; } catch { return undefined; } };

const evidenceKeys = ["evidence_id","project","provider","terminal_id","session_id","incarnation_id","attempt_id","lease_id","fence","kind","argv","cwd","expected_exit","actual_exit","key_id","issued_at","signature"] as const;
const censusKeys = ["census_id","project","provider","terminal_id","session_id","incarnation_id","census_run_id","unresolved","resolved","key_id","issued_at","signature"] as const;
const keyKeys = ["key_id", "purpose", "provider", "public_key_pem", "active", "not_before", "expires_at"] as const;
const revocationKeys = ["key_id", "provider", "purpose", "reason", "revoked_at"] as const;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const revocationIdentity = (keyId: string, provider: string, purpose: KeyPurpose) => `${keyId}\0${provider}\0${purpose}`;
const trusted = (keys: readonly PreGjcTrustedKey[], keyId: string, provider: string, purpose: KeyPurpose, now: Date, revoked: ReadonlySet<string>): PreGjcTrustedKey | undefined => keys.find(key => key.key_id === keyId && key.provider === provider && key.purpose === purpose && !revoked.has(revocationIdentity(keyId, provider, purpose)) && key.active === true && millis(key.not_before) && millis(key.expires_at) && Date.parse(key.not_before) <= now.getTime() && now.getTime() <= Date.parse(key.expires_at) && canonicalEd25519(key.public_key_pem));
const parseStructuredSignal = (provider: PreGjcTarget["provider"], envelope: unknown): ProgressSignal => provider === "codex" ? ingestCodexAppServerEvent(envelope) : ingestClaudeHookEvent(envelope);
const targetSignals = (target: PreGjcTarget): ProgressSignal[] => target.signals.map(signal => parseStructuredSignal(target.provider, signal));
function validEvidence(target: PreGjcTarget, evidence: unknown, now: Date, required: EvidenceKind, revoked: ReadonlySet<string>): boolean {
  if (!isRecord(evidence) || !exact(evidence, evidenceKeys) || evidence.project !== `${target.provider}:${target.terminal_id}:${target.incarnation_id}` || evidence.provider !== target.provider || evidence.terminal_id !== target.terminal_id || evidence.session_id !== target.session_id || evidence.incarnation_id !== target.incarnation_id || evidence.kind !== required || typeof evidence.evidence_id !== "string" || typeof evidence.attempt_id !== "string" || typeof evidence.lease_id !== "string" || !Number.isSafeInteger(evidence.fence) || Number(evidence.fence) < 1 || !Array.isArray(evidence.argv) || evidence.argv.length < 1 || !evidence.argv.every(part => typeof part === "string" && part.length > 0) || typeof evidence.cwd !== "string" || !evidence.cwd.startsWith("/") || evidence.expected_exit !== 0 || evidence.actual_exit !== 0 || typeof evidence.key_id !== "string" || !millis(evidence.issued_at) || typeof evidence.signature !== "string") return false;
  const item = evidence as unknown as PreGjcEvidence; const key = trusted(target.trusted_keys, item.key_id, target.provider, "verification", now, revoked);
  if (!key || Date.parse(evidence.issued_at) > now.getTime() || now.getTime() - Date.parse(evidence.issued_at) > 15 * 60_000) return false;
  const signature = canonicalSignature(item.signature);
  try { return Boolean(signature && verify(null, Buffer.from(DOMAIN + canonicalize(evidencePayload(item))), key.public_key_pem, signature)); } catch { return false; }
}

function validCensus(target: PreGjcTarget, census: unknown, now: Date, revoked: ReadonlySet<string>): boolean {
  if (!isRecord(census) || !exact(census, censusKeys) || census.project !== `${target.provider}:${target.terminal_id}:${target.incarnation_id}` || census.provider !== target.provider || census.terminal_id !== target.terminal_id || census.session_id !== target.session_id || census.incarnation_id !== target.incarnation_id || typeof census.census_id !== "string" || typeof census.census_run_id !== "string" || !Array.isArray(census.unresolved) || census.unresolved.length !== 0 || !Array.isArray(census.resolved) || !census.resolved.every(value => typeof value === "string") || typeof census.key_id !== "string" || !millis(census.issued_at) || typeof census.signature !== "string") return false;
  const item = census as unknown as PreGjcCensus; const key = trusted(target.trusted_keys, item.key_id, target.provider, "census", now, revoked); const signature = canonicalSignature(item.signature);
  return Boolean(key && signature && Date.parse(item.issued_at) <= now.getTime() && now.getTime() - Date.parse(item.issued_at) <= 300_000 && verify(null, Buffer.from(DOMAIN + canonicalize(censusPayload(item))), key.public_key_pem, signature));
}

function validTarget(value: unknown, now: Date, revoked: ReadonlySet<string>): boolean {
  if (!isRecord(value) || !exact(value, ["provider", "terminal_id", "session_id", "incarnation_id", "cursor", "connected", "capture_complete", "observed_at", "signals", "trusted_keys", "evidence", "census", "authority_receipt"]) || !["codex", "claude"].includes(String(value.provider)) || !Array.isArray(value.signals) || !Array.isArray(value.trusted_keys) || !Array.isArray(value.evidence) || !isRecord(value.census) || !isRecord(value.authority_receipt)) return false;
  const target = value as unknown as PreGjcTarget;
  if (!millis(target.observed_at) || !target.connected || !target.capture_complete || !nonempty(target.terminal_id) || !nonempty(target.session_id) || !nonempty(target.incarnation_id) || target.signals.length < 1) return false;
  if (target.trusted_keys.length !== 4 || new Set(target.trusted_keys.map(key => key.purpose)).size !== 4 || !["progress-signal", "verification", "census", "authority-receipt"].every(purpose => target.trusted_keys.some(key => key.purpose === purpose)) || new Set(target.trusted_keys.map(key => key.key_id)).size !== 4) return false;
  const keyIdentities = new Set<string>();
  for (const key of target.trusted_keys) {
    if (!isRecord(key) || !exact(key, keyKeys) || !nonempty(key.key_id) || !["progress-signal", "verification", "census", "authority-receipt"].includes(String(key.purpose)) || key.provider !== target.provider || typeof key.public_key_pem !== "string" || key.active !== true || !millis(key.not_before) || !millis(key.expires_at) || Date.parse(key.not_before) >= Date.parse(key.expires_at) || !canonicalEd25519(key.public_key_pem)) return false;
    const identity = revocationIdentity(key.key_id, key.provider, key.purpose as KeyPurpose); if (keyIdentities.has(identity)) return false; keyIdentities.add(identity);
  }
  // Parse before classification so malformed input cannot be turned into a benign state.
  const signals = targetSignals(target); if (signals.some(signal => revoked.has(revocationIdentity(signal.key_id, signal.provider, "progress-signal")))) return false;
  const progressKeys = target.trusted_keys.filter(key => key.purpose === "progress-signal" && !revoked.has(revocationIdentity(key.key_id, key.provider, key.purpose))) as ProgressSignalKey[];
  const classification = classifyProgressEvidence({ provider: target.provider, terminal_id: target.terminal_id, incarnation_id: target.incarnation_id, cursor: target.cursor, connected: target.connected, capture_complete: target.capture_complete, observed_at: target.observed_at, now, signals, trusted_keys: progressKeys } as ProgressEvidenceInput);
  // A live/verifying observation proves neither completion nor quiescence.  The
  // release boundary accepts only the highest, valid, explicitly signed final
  // provider signal.
  if (classification.state !== "stopped") return false;
  if (target.evidence.length !== REQUIRED_PRE_GJC_EVIDENCE.length || new Set(target.evidence.map(item => item.kind)).size !== REQUIRED_PRE_GJC_EVIDENCE.length || new Set(target.evidence.map(item => item.evidence_id)).size !== REQUIRED_PRE_GJC_EVIDENCE.length || !REQUIRED_PRE_GJC_EVIDENCE.every(kind => validEvidence(target, target.evidence.find(item => item.kind === kind), now, kind, revoked))) return false;
  if (!validCensus(target, target.census, now, revoked)) return false;
  const receipt = target.authority_receipt; const expectedDecision = target.provider === "codex" ? "approve" : "needs_input"; const finalSignal = signals.at(-1); const firstEvidence = target.evidence[0]; const authorityKey = trusted(target.trusted_keys, receipt.key_id, target.provider, "authority-receipt", now, revoked); const signature = canonicalSignature(receipt.signature); const { signature: ignored, ...payload } = receipt; void ignored;
  return Boolean(finalSignal && firstEvidence && authorityKey && signature && receipt.project_id === `${target.provider}:${target.terminal_id}:${target.incarnation_id}` && receipt.provider === target.provider && receipt.terminal_id === target.terminal_id && receipt.session_id === target.session_id && receipt.incarnation_id === target.incarnation_id && receipt.signal_event_id === finalSignal.event_id && receipt.attempt_id === firstEvidence.attempt_id && receipt.lease_id === firstEvidence.lease_id && receipt.fence === firstEvidence.fence && receipt.decision === expectedDecision && (expectedDecision !== "needs_input" || nonempty(receipt.answer)) && millis(receipt.issued_at) && millis(receipt.expires_at) && Date.parse(receipt.issued_at) <= now.getTime() && now.getTime() < Date.parse(receipt.expires_at) && verify(null, Buffer.from(`orca-jarvis/pre-gjc-authority/v1\0${canonicalize(payload)}`), authorityKey.public_key_pem, signature));
}

/** Pure, read-only release gate. There is intentionally no importer, enqueue, or dispatch adapter here. */
export function evaluatePreGjcFixture(value: unknown, clock: string): { boundary: "pre_gjc_ready"; aggregate_status: "stopped"; completion_promoted: true; gjc_dispatched: false } {
  try {
    if (!millis(clock) || !isRecord(value) || !exact(value, ["version", "targets", "revocations"]) || value.version !== 1 || !Array.isArray(value.targets) || !Array.isArray(value.revocations) || value.targets.length !== 2) fail();
    const input = value as { targets: unknown[]; revocations: unknown[] };
    const now = new Date(clock); const identities = new Set<string>();
    const revoked = new Set<string>();
    for (const value of input.revocations) {
      if (!isRecord(value) || !exact(value, revocationKeys) || !nonempty(value.key_id) || !["codex", "claude"].includes(String(value.provider)) || !["progress-signal", "verification", "census", "authority-receipt"].includes(String(value.purpose)) || !nonempty(value.reason) || !millis(value.revoked_at) || Date.parse(value.revoked_at) > now.getTime()) fail();
      const revocation = value as RecordValue;
      const identity = revocationIdentity(revocation.key_id as string, revocation.provider as string, revocation.purpose as KeyPurpose);
      if (revoked.has(identity)) fail();
      revoked.add(identity);
    }
    const targets = input.targets;
    for (const target of targets) { if (!validTarget(target, now, revoked)) fail(); const item = target as PreGjcTarget; const identity = `${item.provider}\0${item.terminal_id}\0${item.incarnation_id}`; if (identities.has(identity)) fail(); identities.add(identity); }
    if (new Set(targets.map(target => (target as PreGjcTarget).provider)).size !== 2) fail();
    return { boundary: "pre_gjc_ready", aggregate_status: "stopped", completion_promoted: true, gjc_dispatched: false };
  } catch { throw new Error("signal rejected"); }
}

/**
 * Runtime-shaped release path used by the command gate.  Parsing and signature
 * checks remain pure above; this function deliberately drives the durable
 * candidate -> classified projection -> report path on a newly migrated DB.
 * It contains no integration, transport, queue, or dispatch side effect.
 */
export function runPreGjcFixture(db: AuthorityDb, value: unknown, clock: string, resumeAdapter: OrcaResumeAdapter = { resume: intent => ({ intent_id: intent.intent_id, receipt: `fixture-ack:${intent.intent_id}`, delivered_at: clock }) }): { boundary: "pre_gjc_ready"; aggregate_status: "stopped"; completion_promoted: true; gjc_dispatched: false } {
  const result = evaluatePreGjcFixture(value, clock);
  const now = new Date(clock); const input = value as PreGjcFixture; const shadow = new PreGjcShadow(db);
  for (const target of input.targets) {
    const projectId = `${target.provider}:${target.terminal_id}:${target.incarnation_id}`;
    shadow.configureProject(projectId, target.provider, 128, 128, 3);
    for (const key of target.trusted_keys) shadow.registerKey(key);
    for (const revocation of input.revocations.filter(item => item.provider === target.provider)) shadow.revokeKey(revocation.key_id, revocation.provider, revocation.purpose, revocation.reason);
    for (const signal of targetSignals(target).sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0)) {
      shadow.enqueueCandidate(`shadow:${projectId}`, signal, now);
      const claim = shadow.claimNext(`gate:${projectId}`, now);
      if (!claim) throw new Error("signal rejected");
      shadow.stageCandidate(claim, projectId, now);
      const shadowReport = shadow.claimReport(`report:${projectId}`, now);
      if (!shadowReport) throw new Error("signal rejected");
      shadow.acknowledgeReport(shadowReport, { report_id: shadowReport.report_id, local_only: true }, now);
      const report = db.pendingProgressReport();
      if (report) db.markProgressDelivered(report.report_id, now.toISOString());
    }
    const signal = targetSignals(target).sort((left, right) => BigInt(left.sequence) < BigInt(right.sequence) ? -1 : BigInt(left.sequence) > BigInt(right.sequence) ? 1 : 0).at(-1); const evidence = target.evidence[0];
    if (!signal || !evidence) throw new Error("signal rejected");
    const binding = { project_id: projectId, provider: target.provider, terminal_id: target.terminal_id, session_id: target.session_id, incarnation_id: target.incarnation_id, signal_event_id: signal.event_id, attempt_id: evidence.attempt_id, lease_id: evidence.lease_id, fence: evidence.fence, expires_at: target.authority_receipt.expires_at };
    const requestId = shadow.requestAuthority(binding, now); const decision = target.provider === "codex" ? "approve" as const : "needs_input" as const;
    const receipt: AuthorityReceipt = target.authority_receipt;
    if (receipt.request_id !== requestId || receipt.decision !== decision) throw new Error("signal rejected");
    shadow.consumeAuthorityReceipt(receipt, resumeAdapter, now);
    for (const item of target.evidence) shadow.recordCompletionEvidence(projectId, item.kind, item, now);
    shadow.recordCensus(projectId, target.census, now);
    shadow.promoteCompletion(projectId, now);
  }
  return result;
}

export function preGjcEvidenceId(payload: unknown): string { return `sha256:${createHash("sha256").update(canonicalize(payload)).digest("hex")}`; }
