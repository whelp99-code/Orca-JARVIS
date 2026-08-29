import { PERSONAL_CONNECTOR_REGISTRY_SESSION } from "./personal-connector-checkpoints.js";
import type {
  PersonalConnectorDefinition,
  PersonalConnectorFreshness,
  PersonalConnectorId,
  PersonalConnectorReason,
  PersonalConnectorResult,
  PersonalConnectorState,
  PersonalSourceSnapshot,
} from "./personal-connector-types.js";
import { freezePersonalResult, personalConnectorDigest } from "./personal-connector-values.js";

export function personalResultBase(definition: PersonalConnectorDefinition, checkedAt: string | null) {
  return {
    schema_version: 1 as const,
    registry_version: 1 as const,
    registry_session: PERSONAL_CONNECTOR_REGISTRY_SESSION,
    connector_id: definition.id,
    configured: definition.configured,
    capabilities: [...definition.capabilities],
    scopes: [...definition.scopes],
    allowed_fields: [...definition.allowed_fields],
    checked_at: checkedAt,
  };
}

export function personalUnavailable(
  definition: PersonalConnectorDefinition,
  reason: PersonalConnectorReason,
  checkedAt: string | null,
): PersonalConnectorResult {
  const evidence = personalConnectorDigest({ connector_id: definition.id, reason, checked_at: checkedAt });
  return freezePersonalResult({
    ...personalResultBase(definition, checkedAt),
    state: "unavailable",
    reason,
    evidence: { evidence_id: `connector:${definition.id}:${evidence.slice(7)}`, digest: evidence },
    evidence_refs: [], observed_at: null, freshness: "unknown", cursor: null, checkpoint: null, values: {},
  });
}

export function personalNoScope(definition: PersonalConnectorDefinition, checkedAt: string): PersonalConnectorResult {
  const evidence = personalConnectorDigest({ connector_id: definition.id, reason: "no_scope", checked_at: checkedAt });
  return freezePersonalResult({
    ...personalResultBase(definition, checkedAt),
    state: "no_data", reason: "no_scope", freshness: "unknown",
    evidence: { evidence_id: `connector:${definition.id}:${evidence.slice(7)}`, digest: evidence },
    evidence_refs: [], observed_at: checkedAt, cursor: null, checkpoint: null, values: {},
  });
}

export function classifyPersonalSnapshot(snapshot: PersonalSourceSnapshot, id: PersonalConnectorId, checkedAt: Date): {
  readonly state: PersonalConnectorState;
  readonly reason: PersonalConnectorReason;
  readonly freshness: PersonalConnectorFreshness;
} {
  const age = checkedAt.getTime() - Date.parse(snapshot.observed_at);
  switch (snapshot.status) {
    case "disconnected": return { state: "offline", reason: "disconnected", freshness: "unknown" };
    case "no_data": return age >= 0 && snapshot.fresh_until !== null
      && checkedAt.getTime() <= Date.parse(snapshot.fresh_until)
      ? { state: "no_data", reason: "current_empty", freshness: "fresh" }
      : { state: "unavailable", reason: "source_stale", freshness: "unknown" };
    case "stale": return { state: "stale", reason: "source_stale", freshness: "stale" };
    case "offline": return { state: "offline", reason: "source_offline", freshness: "unknown" };
    case "unavailable": return { state: "unavailable", reason: "source_unavailable", freshness: "unknown" };
    case "current": {
      if (id === "portfolio") {
        if (age <= 90_000) return { state: "ready", reason: "current", freshness: "fresh" };
        if (age <= 300_000) return { state: "stale", reason: "freshness_threshold_exceeded", freshness: "stale" };
        return { state: "offline", reason: "source_offline", freshness: "unknown" };
      }
      return { state: "ready", reason: "current", freshness: "unknown" };
    }
    default: { const exhaustive: never = snapshot.status; return exhaustive; }
  }
}
