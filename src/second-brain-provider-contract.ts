import type { ChildProcess } from "node:child_process";

export type ProviderJson = Record<string, unknown>;

export const SECOND_BRAIN_PROVIDER_TOOLS = [
  "sb_provider_health",
  "sb_write_request",
  "sb_request_status",
  "sb_reconcile_write",
  "sb_restore_request",
  "sb_observe_artifact",
  "sb_export_history",
  "sb_open_conflicts",
  "sb_read_page",
  "sb_recent_changes",
  "sb_remember",
  "sb_search",
  "sb_run",
] as const;

export type SecondBrainProviderMethod = (typeof SECOND_BRAIN_PROVIDER_TOOLS)[number];

export type ProviderHealth = Readonly<{
  kind: "health";
  status: string;
  contract: string;
  version: string;
  capabilities: readonly string[];
  detail: string;
  writable: boolean;
}>;

export type ProviderWriteResponse = Readonly<{
  request_id: string;
  status: string;
  idempotent_replay: boolean;
  artifact_digest?: string;
  page_id?: string;
  error_code?: string;
  result: ProviderJson;
}>;

export type ProviderRequestStatus = Readonly<{
  kind: "request" | "no_data";
  found: boolean;
  reason?: string;
  request_id: string;
  status: string;
  artifact_digest?: string;
  page_id?: string;
  error_code?: string;
  result: ProviderJson;
  history: readonly ProviderJson[];
}>;

export type ProviderReconcileResponse = ProviderWriteResponse;

export type ProviderExecFile = (
  file: string,
  args: readonly string[],
  options: Readonly<Record<string, unknown>>,
) => ChildProcess;

export type ProviderTransportOptions = Readonly<{
  launcherPath?: string;
  launcherArgs?: readonly string[];
  configPath?: string;
  startupMs?: number;
  readMs?: number;
  writeMs?: number;
  retries?: 0 | 1;
  execFile?: ProviderExecFile;
  realpath?: (path: string) => string;
}>;

export interface SecondBrainProvider {
  health(): Promise<ProviderHealth>;
  writeRequest(value: ProviderJson): Promise<ProviderWriteResponse>;
  requestStatus(requestId: string): Promise<ProviderRequestStatus>;
  reconcileWrite(
    requestId: string,
    observedDigest?: string,
  ): Promise<ProviderReconcileResponse>;
  restoreRequest(requestId: string): Promise<ProviderWriteResponse>;
  observeArtifact(
    requestId: string,
    digest: string,
    pageId?: string,
  ): Promise<ProviderWriteResponse>;
  exportHistory(arguments_: ProviderJson): Promise<ProviderJson>;
}

function isRecord(value: unknown): value is ProviderJson {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function parseProviderHealth(value: ProviderJson): ProviderHealth {
  const capabilities = stringList(value.capabilities);
  const status = optionalString(value.status) ?? "unknown";
  return {
    kind: value.kind === "health" ? "health" : "health",
    status,
    contract: optionalString(value.contract) ?? "unknown",
    version: optionalString(value.version) ?? "unknown",
    capabilities,
    detail: optionalString(value.detail) ?? "",
    writable: status !== "error" && capabilities.includes("approved_write_requests"),
  };
}

export function parseProviderWrite(value: ProviderJson): ProviderWriteResponse {
  return {
    request_id: optionalString(value.request_id) ?? "",
    status: optionalString(value.status) ?? "unknown",
    idempotent_replay: value.idempotent_replay === true,
    artifact_digest: optionalString(value.artifact_digest),
    page_id: optionalString(value.page_id),
    error_code: optionalString(value.error_code),
    result: isRecord(value.result) ? value.result : {},
  };
}

export function parseProviderStatus(value: ProviderJson): ProviderRequestStatus {
  if (value.kind === "no_data") {
    return {
      kind: "no_data",
      found: false,
      reason: optionalString(value.reason),
      request_id: "",
      status: "unknown",
      result: {},
      history: [],
    };
  }
  const parsed = parseProviderWrite(value);
  return {
    kind: "request",
    found: true,
    request_id: parsed.request_id,
    status: parsed.status,
    artifact_digest: parsed.artifact_digest,
    page_id: parsed.page_id,
    error_code: parsed.error_code,
    result: parsed.result,
    history: Array.isArray(value.history)
      ? value.history.filter(isRecord)
      : [],
  };
}
