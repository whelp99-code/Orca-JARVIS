import type Database from "better-sqlite3";
import type { MemoryWriteRequest } from "./memory-outbox.js";
import type { ProviderJson as Json } from "./second-brain-provider-contract.js";
import { TerminalMemoryError } from "./terminal-memory-validation.js";

export type TerminalWorkSummaryV1 = Readonly<{
  schema: "terminal-work-summary-v1";
  memory_candidate_id: string;
  jarvis_closeout_id: string;
  jarvis_receipt_digest: string;
  project_id: string;
  host_scope: readonly string[];
  terminal_count: number;
  started_at: string;
  finished_at: string;
  outcome: string;
  verified: true;
  purpose: string;
  work_performed: readonly string[];
  verified_results: readonly string[];
  failures: readonly Readonly<Record<string, string>>[];
  artifacts: readonly string[];
  commits: readonly string[];
  issues: readonly string[];
  improvements: readonly string[];
  next_actions: readonly string[];
  source_refs: readonly string[];
}>;

export type MemorySettlementContext = Readonly<{
  closeout_id?: string;
  receipt_digest?: string;
  purpose?: string;
  sensitivity?: string;
  retention?: string;
  expected_prior_digest?: string | null;
  source_refs?: readonly string[];
  summary?: TerminalWorkSummaryV1;
}>;

function row(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strings(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function candidateRow(db: Database.Database, candidateId: string): Record<string, unknown> {
  const candidate = row(db.prepare(
    "SELECT candidate_id,correlation_id,operation,sensitivity,purpose,"
    + "confirmation_receipt_digest,source_digest,expires_at "
    + "FROM memory_candidates WHERE candidate_id=?",
  ).get(candidateId));
  if (!candidate) throw new TerminalMemoryError("MEMORY_CANDIDATE_NOT_FOUND");
  return candidate;
}

function closeoutRow(
  db: Database.Database,
  correlationId: string,
): Record<string, unknown> | undefined {
  return row(db.prepare(
    "SELECT * FROM terminal_closeouts WHERE correlation_id=?",
  ).get(correlationId));
}

function hostAndStart(
  db: Database.Database,
  terminalIds: readonly string[],
  fallback: string,
): Readonly<{ hosts: readonly string[]; started_at: string }> {
  if (terminalIds.length === 0) return { hosts: [], started_at: fallback };
  const rows = db.prepare(
    "SELECT host_id,started_at FROM terminal_sessions "
    + "WHERE terminal_id IN (SELECT value FROM json_each(?)) "
    + "ORDER BY started_at,host_id",
  ).all(JSON.stringify(terminalIds)) as Array<{ host_id: string; started_at: string }>;
  return {
    hosts: [...new Set(rows.map((item) => item.host_id))],
    started_at: rows[0]?.started_at ?? fallback,
  };
}

function derivedSummary(
  db: Database.Database,
  candidate: Record<string, unknown>,
  closeout: Record<string, unknown>,
  receiptDigest: string,
  purpose: string,
  sourceRefs?: readonly string[],
): TerminalWorkSummaryV1 {
  const terminalIds = strings(closeout.terminal_ids_json);
  const projectIds = strings(closeout.project_ids_json);
  const verifiedResults = strings(closeout.verified_result_json);
  if (verifiedResults.length === 0) {
    throw new TerminalMemoryError("MEMORY_SETTLEMENT_VERIFICATION_REQUIRED");
  }
  const finishedAt = String(closeout.signed_at);
  const terminal = hostAndStart(db, terminalIds, finishedAt);
  const failed = [
    ...strings(closeout.failed_items_json),
    ...strings(closeout.unresolved_items_json),
  ];
  return {
    schema: "terminal-work-summary-v1",
    memory_candidate_id: String(candidate.candidate_id),
    jarvis_closeout_id: String(closeout.closeout_id),
    jarvis_receipt_digest: receiptDigest,
    project_id: projectIds[0] ?? "unassigned",
    host_scope: terminal.hosts,
    terminal_count: terminalIds.length,
    started_at: terminal.started_at,
    finished_at: finishedAt,
    outcome: String(closeout.outcome),
    verified: true,
    purpose,
    work_performed: [],
    verified_results: verifiedResults,
    failures: failed.map((summary) => ({ summary })),
    artifacts: strings(closeout.artifacts_json),
    commits: strings(closeout.commit_refs_json),
    issues: strings(closeout.issue_refs_json),
    improvements: strings(closeout.improvements_json),
    next_actions: strings(closeout.next_actions_json),
    source_refs: sourceRefs ?? [
      String(candidate.source_digest),
      String(closeout.canonical_digest),
    ],
  };
}

function validateSummary(
  summary: TerminalWorkSummaryV1,
  request: MemoryWriteRequest,
  closeoutId: string,
  receiptDigest: string,
): TerminalWorkSummaryV1 {
  if (summary.schema !== "terminal-work-summary-v1" || summary.verified !== true) {
    throw new TerminalMemoryError("MEMORY_SETTLEMENT_SUMMARY_INVALID");
  }
  if (summary.memory_candidate_id !== request.candidate_id
    || summary.jarvis_closeout_id !== closeoutId
    || summary.jarvis_receipt_digest !== receiptDigest) {
    throw new TerminalMemoryError("MEMORY_SETTLEMENT_SUMMARY_BINDING_MISMATCH");
  }
  return summary;
}

export function buildSecondBrainWriteRequest(
  db: Database.Database,
  request: MemoryWriteRequest,
  context?: MemorySettlementContext,
): Json {
  const candidate = candidateRow(db, request.candidate_id);
  if (String(candidate.operation) !== request.operation) {
    throw new TerminalMemoryError("MEMORY_OPERATION_CONFLICT");
  }
  const closeout = closeoutRow(db, String(candidate.correlation_id));
  const closeoutId = context?.closeout_id
    ?? context?.summary?.jarvis_closeout_id
    ?? optionalString(closeout?.closeout_id);
  const receiptDigest = context?.receipt_digest
    ?? context?.summary?.jarvis_receipt_digest
    ?? optionalString(candidate.confirmation_receipt_digest)
    ?? optionalString(closeout?.canonical_digest);
  if (!closeoutId || !receiptDigest?.startsWith("sha256:")) {
    throw new TerminalMemoryError("MEMORY_SETTLEMENT_AUTHORITY_REQUIRED");
  }
  const purpose = context?.purpose ?? String(candidate.purpose);
  let summary = context?.summary;
  if (!summary && (request.operation === "remember" || request.operation === "correct")) {
    if (!closeout) throw new TerminalMemoryError("MEMORY_SETTLEMENT_CLOSEOUT_REQUIRED");
    summary = derivedSummary(
      db,
      candidate,
      closeout,
      receiptDigest,
      purpose,
      context?.source_refs,
    );
  }
  if (summary) summary = validateSummary(summary, request, closeoutId, receiptDigest);
  return {
    schema: "second-brain-write-request-v1",
    operation: request.operation,
    candidate_id: request.candidate_id,
    closeout_id: closeoutId,
    receipt_digest: receiptDigest,
    purpose,
    sensitivity: context?.sensitivity ?? String(candidate.sensitivity),
    retention: context?.retention ?? "durable",
    expected_prior_digest: context?.expected_prior_digest ?? null,
    idempotency_key: request.idempotency_key,
    summary: summary ?? null,
    request_id: request.outbox_id,
  };
}
