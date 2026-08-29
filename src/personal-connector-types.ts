export const PERSONAL_CONNECTOR_IDS = [
  "second_brain", "orca", "task_timeline", "portfolio", "calendar", "mail", "messenger",
] as const;
export type PersonalConnectorId = (typeof PERSONAL_CONNECTOR_IDS)[number];
export type PersonalConnectorState = "ready" | "no_data" | "stale" | "offline" | "unavailable";
export type PersonalConnectorReason =
  | "current" | "current_empty" | "source_stale" | "freshness_threshold_exceeded" | "source_offline"
  | "source_unavailable" | "not_configured" | "invalid_source" | "adapter_failed" | "invalid_clock"
  | "checkpoint_invalid" | "checkpoint_mismatch" | "checkpoint_stale" | "replay_conflict";
export type PersonalConnectorFreshness = "fresh" | "stale" | "unknown";
export type PersonalConnectorValue = string | number | boolean | null | readonly string[];

export type PersonalConnectorDefinition = {
  readonly id: PersonalConnectorId;
  readonly configured: boolean;
  readonly capabilities: readonly string[];
  readonly scopes: readonly string[];
  readonly allowed_fields: readonly string[];
  readonly freshness: { readonly live_ms: number | null; readonly stale_ms: number | null };
};

export type PersonalConnectorEvidence = {
  readonly evidence_id: string;
  readonly digest: string;
};

export type PersonalConnectorResult = {
  readonly schema_version: 1;
  readonly registry_version: 1;
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
  readonly values: Readonly<Record<string, PersonalConnectorValue>>;
};

export type PersonalConnectorReadRequest = {
  readonly connector_id: string;
  readonly scopes: readonly string[];
  readonly fields: readonly string[];
  readonly checkpoint?: string;
};

export interface PersonalSourceAdapter {
  read(): Promise<unknown>;
}

export type PersonalConnectorAdapters = {
  readonly second_brain: PersonalSourceAdapter;
  readonly orca: PersonalSourceAdapter;
  readonly task_timeline: PersonalSourceAdapter;
  readonly portfolio: PersonalSourceAdapter;
};

export type PersonalSourceSnapshot = {
  readonly schema_version: 1;
  readonly source_version: string;
  readonly incarnation: string | null;
  readonly sequence: number;
  readonly cursor: string;
  readonly observed_at: string;
  readonly status: "current" | "no_data" | "stale" | "offline" | "unavailable";
  readonly evidence_refs: readonly string[];
  readonly values: Readonly<Record<string, PersonalConnectorValue>>;
};

export class PersonalConnectorError extends Error {
  readonly name = "PersonalConnectorError";
  constructor(readonly code: "PERSONAL_CONNECTOR_UNKNOWN" | "PERSONAL_CONNECTOR_REQUEST_INVALID") {
    super(code);
  }
}
