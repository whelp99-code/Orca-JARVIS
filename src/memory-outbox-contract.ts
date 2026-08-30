import { TerminalMemoryError } from "./terminal-memory-validation.js";

export const UNBOUND_ARTIFACT_DIGEST = `sha256:${"0".repeat(64)}` as const;
export const UNBOUND_ARTIFACT_SELECTOR = "selector:unbound" as const;

export type MemoryWriteRequest = Readonly<{
  outbox_id: string;
  candidate_id: string;
  idempotency_key: string;
  operation: "remember" | "correct" | "forget" | "export";
  request_digest: string;
  expected_artifact_digest: string;
  expected_artifact_selector: string;
  provider_version: string;
}>;

export type MemoryWriteReceipt = Readonly<{
  outcome: "accepted" | "rejected" | "uncertain";
  error_code?: string;
  artifact_digest?: string;
  page_id?: string;
  provider_status?: string;
}>;

export type MemoryWriter = (
  request: MemoryWriteRequest,
) => Promise<MemoryWriteReceipt>;

export type MemoryOutboxRow = Readonly<{
  outbox_id: string;
  candidate_id: string;
  state: string;
  lease_owner: string | null;
  lease_fence: number;
  lease_expires_at: string | null;
  request_digest: string;
  expected_artifact_digest: string;
  expected_artifact_selector: string;
  provider_artifact_digest: string | null;
  provider_page_id: string | null;
  provider_status: string | null;
}>;

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function expectedArtifactDigest(value?: string | null): string {
  if (value === undefined || value === null) return UNBOUND_ARTIFACT_DIGEST;
  if (!isSha256Digest(value)) throw new TerminalMemoryError("MEMORY_ARTIFACT_DIGEST_INVALID");
  return value;
}

export function expectedArtifactSelector(value?: string | null): string {
  if (value === undefined || value === null || value.length === 0) {
    return UNBOUND_ARTIFACT_SELECTOR;
  }
  if (Buffer.byteLength(value, "utf8") > 512 || value.includes("\0")) {
    throw new TerminalMemoryError("MEMORY_ARTIFACT_SELECTOR_INVALID");
  }
  return value;
}

export function memoryOutboxRow(value: Record<string, unknown>): MemoryOutboxRow {
  return {
    outbox_id: String(value.outbox_id),
    candidate_id: String(value.candidate_id),
    state: String(value.state),
    lease_owner: value.lease_owner === null ? null : String(value.lease_owner),
    lease_fence: Number(value.lease_fence),
    lease_expires_at: value.lease_expires_at === null
      ? null
      : String(value.lease_expires_at),
    request_digest: String(value.request_digest),
    expected_artifact_digest: String(value.expected_artifact_digest),
    expected_artifact_selector: String(value.expected_artifact_selector),
    provider_artifact_digest: value.provider_artifact_digest === null
      ? null
      : String(value.provider_artifact_digest),
    provider_page_id: value.provider_page_id === null
      ? null
      : String(value.provider_page_id),
    provider_status: value.provider_status === null
      ? null
      : String(value.provider_status),
  };
}

export type MemoryOutboxQueueInput = Readonly<{
  outbox_id: string;
  candidate_id: string;
  idempotency_key: string;
  operation: MemoryWriteRequest["operation"];
  expected_artifact_selector?: string | null;
  expected_artifact_digest?: string | null;
  provider_version: string;
  expires_at: string;
  now: string;
}>;
