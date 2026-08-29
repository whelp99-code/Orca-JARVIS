import type { PersonalConnectorDefinition, PersonalConnectorId } from "./personal-connector-types.js";

export const PERSONAL_CONNECTOR_DEFINITIONS = [
  {
    id: "second_brain", configured: true,
    capabilities: ["search", "read_page", "recent_changes", "open_conflicts"],
    scopes: ["second_brain.search.read", "second_brain.page.read", "second_brain.recent.read", "second_brain.conflict.read"],
    allowed_fields: ["evidence_id", "content_digest", "source_version", "sensitivity", "observed_at", "conflict_id"],
    freshness: { live_ms: null, stale_ms: null },
  },
  {
    id: "orca", configured: true,
    capabilities: ["identity", "connectivity", "worktree_metadata", "terminal_metadata", "cursor_metadata"],
    scopes: ["orca.identity.read", "orca.connectivity.read", "orca.worktree.read", "orca.terminal.read", "orca.cursor.read"],
    allowed_fields: ["environment", "worktree_id", "terminal_id", "incarnation_id", "cursor", "connected", "last_output_at"],
    freshness: { live_ms: null, stale_ms: null },
  },
  {
    id: "task_timeline", configured: true,
    capabilities: ["task_summary", "event_metadata", "decision_metadata", "evidence_metadata"],
    scopes: ["task_timeline.task.read", "task_timeline.event.read", "task_timeline.decision.read", "task_timeline.evidence.read"],
    allowed_fields: ["task_id", "event_id", "decision_id", "evidence_id", "state", "sequence", "observed_at", "pending_approval"],
    freshness: { live_ms: null, stale_ms: null },
  },
  {
    id: "portfolio", configured: true,
    capabilities: ["authenticated_projection"], scopes: ["portfolio.projection.read"],
    allowed_fields: [
      "source", "reported_at", "collector_status", "report_digest", "worktree_count", "terminal_count", "clean_count",
      "dirty_count", "dirty_path_count", "active_task_count", "issue_count", "pull_request_count",
    ],
    freshness: { live_ms: 90_000, stale_ms: 300_000 },
  },
  { id: "calendar", configured: false, capabilities: [], scopes: [], allowed_fields: [], freshness: { live_ms: null, stale_ms: null } },
  { id: "mail", configured: false, capabilities: [], scopes: [], allowed_fields: [], freshness: { live_ms: null, stale_ms: null } },
  { id: "messenger", configured: false, capabilities: [], scopes: [], allowed_fields: [], freshness: { live_ms: null, stale_ms: null } },
] as const satisfies readonly PersonalConnectorDefinition[];

export function personalConnectorDefinition(id: PersonalConnectorId): PersonalConnectorDefinition {
  switch (id) {
    case "second_brain": return PERSONAL_CONNECTOR_DEFINITIONS[0];
    case "orca": return PERSONAL_CONNECTOR_DEFINITIONS[1];
    case "task_timeline": return PERSONAL_CONNECTOR_DEFINITIONS[2];
    case "portfolio": return PERSONAL_CONNECTOR_DEFINITIONS[3];
    case "calendar": return PERSONAL_CONNECTOR_DEFINITIONS[4];
    case "mail": return PERSONAL_CONNECTOR_DEFINITIONS[5];
    case "messenger": return PERSONAL_CONNECTOR_DEFINITIONS[6];
    default: { const exhaustive: never = id; return exhaustive; }
  }
}
