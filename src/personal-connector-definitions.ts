import { PERSONAL_CONNECTOR_REGISTRY_SESSION } from "./personal-connector-checkpoints.js";
import type { PersonalConnectorDefinition, PersonalConnectorId } from "./personal-connector-types.js";

function frozenDefinition(value: Omit<PersonalConnectorDefinition, "registry_session">): PersonalConnectorDefinition {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
    scopes: Object.freeze([...value.scopes]),
    allowed_fields: Object.freeze([...value.allowed_fields]),
    freshness: Object.freeze({ ...value.freshness }),
    registry_session: PERSONAL_CONNECTOR_REGISTRY_SESSION,
  });
}

export const PERSONAL_CONNECTOR_DEFINITIONS = Object.freeze([
  frozenDefinition({
    id: "second_brain", configured: true,
    capabilities: ["search", "read_page", "recent_changes", "open_conflicts"],
    scopes: ["second_brain.search.read", "second_brain.page.read", "second_brain.recent.read", "second_brain.conflict.read"],
    allowed_fields: ["evidence_id", "content_digest", "source_version", "sensitivity", "observed_at", "conflict_id"],
    freshness: { live_ms: null, stale_ms: null },
  }),
  frozenDefinition({
    id: "orca", configured: true,
    capabilities: ["identity", "connectivity", "worktree_metadata", "terminal_metadata", "cursor_metadata"],
    scopes: ["orca.identity.read", "orca.connectivity.read", "orca.worktree.read", "orca.terminal.read", "orca.cursor.read"],
    allowed_fields: ["environment", "worktree_id", "terminal_id", "incarnation_id", "cursor", "connected", "last_output_at"],
    freshness: { live_ms: null, stale_ms: null },
  }),
  frozenDefinition({
    id: "task_timeline", configured: true,
    capabilities: ["task_summary", "event_metadata", "decision_metadata", "evidence_metadata"],
    scopes: ["task_timeline.task.read", "task_timeline.event.read", "task_timeline.decision.read", "task_timeline.evidence.read"],
    allowed_fields: ["task_id", "event_id", "decision_id", "evidence_id", "state", "sequence", "observed_at", "pending_approval"],
    freshness: { live_ms: null, stale_ms: null },
  }),
  frozenDefinition({
    id: "portfolio", configured: true,
    capabilities: ["authenticated_projection"], scopes: ["portfolio.projection.read"],
    allowed_fields: [
      "source", "reported_at", "collector_status", "report_digest", "worktree_count", "terminal_count", "clean_count",
      "dirty_count", "dirty_path_count", "active_task_count", "issue_count", "pull_request_count",
    ],
    freshness: { live_ms: 90_000, stale_ms: 300_000 },
  }),
  frozenDefinition({ id: "calendar", configured: false, capabilities: [], scopes: [], allowed_fields: [], freshness: { live_ms: null, stale_ms: null } }),
  frozenDefinition({ id: "mail", configured: false, capabilities: [], scopes: [], allowed_fields: [], freshness: { live_ms: null, stale_ms: null } }),
  frozenDefinition({ id: "messenger", configured: false, capabilities: [], scopes: [], allowed_fields: [], freshness: { live_ms: null, stale_ms: null } }),
]);

export function personalConnectorDefinitionsForSecondBrain(
  capability: "search" | "read_page" | "recent_changes" | "open_conflicts",
  scope: string,
  mailConfigured = false,
): readonly PersonalConnectorDefinition[] {
  const memory = PERSONAL_CONNECTOR_DEFINITIONS[0];
  if (memory === undefined) throw new TypeError("PERSONAL_CONNECTOR_DEFINITION_MISSING");
  const narrowed = frozenDefinition({
    ...memory,
    capabilities: [capability],
    scopes: [scope],
    allowed_fields: capability === "open_conflicts"
      ? memory.allowed_fields
      : memory.allowed_fields.filter(field => field !== "conflict_id"),
  });
  return Object.freeze([narrowed, ...PERSONAL_CONNECTOR_DEFINITIONS.slice(1).map(item =>
    item.id === "mail" ? personalMailConnectorDefinition(mailConfigured) : item)]);
}

export function personalMailConnectorDefinition(configured: boolean): PersonalConnectorDefinition {
  return frozenDefinition({
    id: "mail", configured,
    capabilities: configured ? ["storage_summary"] : [],
    scopes: configured ? ["mail.summary.read"] : [],
    allowed_fields: configured ? ["message_count", "thread_count", "observed_at"] : [],
    freshness: { live_ms: null, stale_ms: null },
  });
}

export function personalConnectorDefinition(id: PersonalConnectorId): PersonalConnectorDefinition {
  const found = PERSONAL_CONNECTOR_DEFINITIONS.find(item => item.id === id);
  if (found === undefined) throw new TypeError("PERSONAL_CONNECTOR_DEFINITION_MISSING");
  return found;
}
