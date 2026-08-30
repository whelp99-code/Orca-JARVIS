import type Database from "better-sqlite3";
import {
  isSha256Digest,
  UNBOUND_ARTIFACT_DIGEST,
  UNBOUND_ARTIFACT_SELECTOR,
  type MemoryWriteReceipt,
  type MemoryWriteRequest,
} from "./memory-outbox-contract.js";
import { TerminalMemoryError } from "./terminal-memory-validation.js";

export function validateMemoryWriteReceipt(
  response: MemoryWriteReceipt,
): MemoryWriteReceipt {
  if (response.outcome !== "accepted") return response;
  if (!isSha256Digest(response.artifact_digest)
    || typeof response.page_id !== "string" || response.page_id.length === 0
    || typeof response.provider_status !== "string"
    || response.provider_status.length === 0) {
    return {
      outcome: "uncertain",
      error_code: "MEMORY_PROVIDER_RECEIPT_INVALID",
    };
  }
  return response;
}

export function memoryProviderReceiptConflicts(
  request: MemoryWriteRequest,
  response: MemoryWriteReceipt,
): boolean {
  return (request.expected_artifact_digest !== UNBOUND_ARTIFACT_DIGEST
    && request.expected_artifact_digest !== response.artifact_digest)
    || (request.expected_artifact_selector !== UNBOUND_ARTIFACT_SELECTOR
      && request.expected_artifact_selector !== response.page_id);
}

export function bindMemoryProviderReceipt(
  db: Database.Database,
  input: Readonly<{
    outbox_id: string;
    owner: string;
    fence: number;
    receipt: MemoryWriteReceipt;
    at: string;
    next: "accepted_unsettled" | "uncertain";
    lease_expires_at: string | null;
  }>,
): void {
  if (!isSha256Digest(input.receipt.artifact_digest)
    || !input.receipt.page_id || !input.receipt.provider_status) {
    throw new TerminalMemoryError("MEMORY_PROVIDER_RECEIPT_INVALID");
  }
  const keepLease = input.next === "accepted_unsettled";
  const changed = db.prepare(
    "UPDATE memory_outbox SET state=?,provider_artifact_digest=?,provider_page_id=?,"
    + "provider_status=?,lease_owner=?,lease_expires_at=?,updated_at=? "
    + "WHERE outbox_id=? AND state IN ('delivering','accepted_unsettled') "
    + "AND lease_owner=? AND lease_fence=?",
  ).run(
    input.next,
    input.receipt.artifact_digest,
    input.receipt.page_id,
    input.receipt.provider_status,
    keepLease ? input.owner : null,
    keepLease ? input.lease_expires_at : null,
    input.at,
    input.outbox_id,
    input.owner,
    input.fence,
  );
  if (changed.changes !== 1) {
    throw new TerminalMemoryError("MEMORY_OUTBOX_PROVIDER_BINDING_CONFLICT");
  }
}
