export const PERSONAL_CONNECTOR_IDS = [
  "second_brain", "orca", "task_timeline", "portfolio", "calendar", "mail", "messenger",
] as const;
export type PersonalConnectorId = (typeof PERSONAL_CONNECTOR_IDS)[number];
export type ConfiguredPersonalConnectorId = "second_brain" | "orca" | "task_timeline" | "portfolio" | "mail" | "messenger";
export type PersonalConnectorState = "ready" | "no_data" | "stale" | "offline" | "unavailable";
export type PersonalConnectorReason =
  | "current" | "current_empty" | "source_stale" | "freshness_threshold_exceeded" | "source_offline" | "disconnected"
  | "source_unavailable" | "not_configured" | "invalid_source" | "adapter_failed" | "invalid_clock"
  | "no_scope" | "source_budget_exceeded" | "checkpoint_invalid" | "checkpoint_session_invalid"
  | "checkpoint_mismatch" | "checkpoint_stale" | "checkpoint_capacity" | "replay_conflict";
export type PersonalConnectorFreshness = "fresh" | "stale" | "unknown";
export type PersonalConnectorValue = string | number | boolean | null | readonly string[];
export type PersonalRegistrySessionContract = {
  readonly version: 1;
  readonly persistence: "process_local";
  readonly restart: "handles_invalid";
  readonly max_total: 4;
  readonly max_per_connector: 1;
};

export type PersonalConnectorDefinition = {
  readonly id: PersonalConnectorId;
  readonly configured: boolean;
  readonly capabilities: readonly string[];
  readonly scopes: readonly string[];
  readonly allowed_fields: readonly string[];
  readonly freshness: { readonly live_ms: number | null; readonly stale_ms: number | null };
  readonly registry_session: PersonalRegistrySessionContract;
};
export type PersonalConnectorRegistry = {
  readonly registry_session: PersonalRegistrySessionContract;
  readonly list: () => readonly PersonalConnectorDefinition[];
  readonly inspect: (input: unknown) => Promise<PersonalConnectorResult>;
};

export type PersonalConnectorEvidence = { readonly evidence_id: string; readonly digest: string };
export type PersonalCheckpointSessionRequest =
  | { readonly mode: "start"; readonly version: 1 }
  | { readonly mode: "continue"; readonly version: 1; readonly handle: string };
export type PersonalCheckpointSessionResult =
  | { readonly mode: "stateless"; readonly version: 1; readonly persistence: "process_local"; readonly handle: null }
  | { readonly mode: "explicit"; readonly version: 1; readonly persistence: "process_local"; readonly handle: string | null };

export type PersonalConnectorResult = {
  readonly schema_version: 1;
  readonly registry_version: 1;
  readonly registry_session: PersonalRegistrySessionContract;
  readonly connector_id: PersonalConnectorId;
  readonly configured: boolean;
  readonly capabilities: readonly string[];
  readonly scopes: readonly string[];
  readonly allowed_fields: readonly string[];
  readonly state: PersonalConnectorState;
  readonly reason: PersonalConnectorReason;
  readonly evidence: PersonalConnectorEvidence;
  readonly evidence_refs: readonly string[];
  readonly observed_at: string | null;
  readonly checked_at: string | null;
  readonly freshness: PersonalConnectorFreshness;
  readonly cursor: string | null;
  readonly checkpoint: string | null;
  readonly checkpoint_session: PersonalCheckpointSessionResult;
  readonly values: Readonly<Record<string, PersonalConnectorValue>>;
};

export type PersonalConnectorReadRequest = {
  readonly connector_id: PersonalConnectorId;
  readonly scopes: readonly string[];
  readonly fields: readonly string[];
  readonly checkpoint_session?: PersonalCheckpointSessionRequest;
};

export type PersonalSourceSnapshot = {
  readonly connector_id: ConfiguredPersonalConnectorId;
  readonly source_version: string;
  readonly incarnation: string | null;
  readonly sequence: number;
  readonly cursor: string;
  readonly observed_at: string;
  readonly fresh_until: string | null;
  readonly status: "current" | "no_data" | "stale" | "offline" | "unavailable" | "disconnected";
  readonly evidence_refs: readonly string[];
  readonly values: Readonly<Record<string, PersonalConnectorValue>>;
};

export class PersonalConnectorConfigError extends Error {
  readonly name = "PersonalConnectorConfigError";
  readonly code = "PERSONAL_CONNECTOR_CONFIG_INVALID";
  constructor() { super("PERSONAL_CONNECTOR_CONFIG_INVALID"); }
}

export class PersonalConnectorError extends Error {
  readonly name = "PersonalConnectorError";
  constructor(readonly code: "PERSONAL_CONNECTOR_UNKNOWN" | "PERSONAL_CONNECTOR_REQUEST_INVALID") { super(code); }
}
