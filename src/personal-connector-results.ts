import { PERSONAL_CONNECTOR_REGISTRY_SESSION } from "./personal-connector-checkpoints.js";
import type {
  PersonalCheckpointSessionResult,
  PersonalConnectorDefinition,
  PersonalConnectorFreshness,
  PersonalConnectorId,
  PersonalConnectorReason,
  PersonalConnectorResult,
  PersonalConnectorState,
  PersonalSourceSnapshot,
} from "./personal-connector-types.js";
import { freezePersonalResult, personalConnectorDigest } from "./personal-connector-values.js";

export type PersonalResultContext = {
  readonly checked_at: string | null;
  readonly checkpoint_session: PersonalCheckpointSessionResult;
};

export function personalResultBase(definition: PersonalConnectorDefinition, context: PersonalResultContext) {
  return {
    schema_version: 1 as const,
    registry_version: 1 as const,
    registry_session: PERSONAL_CONNECTOR_REGISTRY_SESSION,
    connector_id: definition.id,
    configured: definition.configured,
    capabilities: [...definition.capabilities],
    scopes: [...definition.scopes],
    allowed_fields: [...definition.allowed_fields],
    checked_at: context.checked_at,
    checkpoint_session: context.checkpoint_session,
  };
}

export function personalUnavailable(
  definition: PersonalConnectorDefinition,
  reason: PersonalConnectorReason,
  context: PersonalResultContext,
): PersonalConnectorResult {
  const evidence = personalConnectorDigest({ connector_id: definition.id, reason, checked_at: context.checked_at });
  return freezePersonalResult({
    ...personalResultBase(definition, context),
    state: "unavailable",
    reason,
    evidence: { evidence_id: `connector:${definition.id}:${evidence.slice(7)}`, digest: evidence },
    evidence_refs: [], observed_at: null, freshness: "unknown", cursor: null, checkpoint: null, values: {},
  });
}

export function personalNoScope(
  definition: PersonalConnectorDefinition,
  context: PersonalResultContext & { readonly checked_at: string },
): PersonalConnectorResult {
  const evidence = personalConnectorDigest({ connector_id: definition.id, reason: "no_scope", checked_at: context.checked_at });
  return freezePersonalResult({
    ...personalResultBase(definition, context),
    state: "no_data", reason: "no_scope", freshness: "unknown",
    evidence: { evidence_id: `connector:${definition.id}:${evidence.slice(7)}`, digest: evidence },
    evidence_refs: [], observed_at: context.checked_at, cursor: null, checkpoint: null, values: {},
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
      if (id === "messenger") {
        return age >= 0 && age <= 60_000
          ? { state: "ready", reason: "current", freshness: "fresh" }
          : { state: "unavailable", reason: "source_stale", freshness: "unknown" };
      }
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
