import {
  AuthorityDb,
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_PROTOCOL_VERSION,
  SECOND_BRAIN_REQUIRED_TOOLS,
  createPersonalConnectorRegistry,
  type PersonalConnectorId,
  type SecondBrainReadOutcome,
} from "../../src/index.js";
import { signPortfolioEnvelope } from "../../src/dashboard/portfolio-auth.js";
import { SecondBrainTransportError, type SecondBrainReadMethod } from "../../src/second-brain-transport.js";
import { page } from "./second-brain-adapter-fixtures.js";
import { localReport } from "./portfolio-report.js";
import { tempDb } from "../helpers.js";

export const CONNECTOR_NOW = new Date("2026-08-28T12:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;

export function currentMemoryOutcome(observedAt = CONNECTOR_NOW.toISOString()): SecondBrainReadOutcome {
  return {
    kind: "current", checked_at: CONNECTOR_NOW.toISOString(), evidence: [{
      kind: "memory", page_id: "page-1", sid: "sid-1", source_ref: "source-1",
      source_id: "src:pos:v1:second-brain:primary", source_version: "source-v1", sensitivity: "personal",
      observed_at: observedAt, valid_at: observedAt,
      freshness: { state: "fresh", checked_at: CONNECTOR_NOW.toISOString(), fresh_until: CONNECTOR_NOW.toISOString() },
      expires_at: CONNECTOR_NOW.toISOString(), trust: "untrusted", authority: "none", excerpt: null,
      content_digest: DIGEST, omission: null,
    }],
  };
}

type HarnessOptions = {
  readonly outcome?: SecondBrainReadOutcome;
  readonly connected?: boolean;
  readonly clock?: () => Date;
  readonly orca_overrides?: Readonly<Record<string, unknown>>;
  readonly portfolio_envelope?: Buffer;
  readonly portfolio_key?: Buffer;
  readonly portfolio_reported_at?: string;
  readonly portfolio_received_at?: Date;
  readonly orca_error?: Error;
  readonly orca_calls?: { count: number };
  readonly memory_calls?: { methods: SecondBrainReadMethod[] };
  readonly max_age_ms?: number;
  readonly expiry_ms?: number;
  readonly operation?:
    | { readonly kind: "search"; readonly query: string }
    | { readonly kind: "page"; readonly page_id: string }
    | { readonly kind: "recent"; readonly days: number }
    | { readonly kind: "conflicts" };
};

function transportCall(options: HarnessOptions) {
  return async (method: SecondBrainReadMethod) => {
    options.memory_calls?.methods.push(method);
    const outcome = options.outcome;
    if (outcome?.kind === "no_data") return { kind: "no_data" as const, reason: "empty_result" as const };
    if (outcome?.kind === "offline") throw new SecondBrainTransportError(outcome.code, "unavailable", { generation: 1 });
    if (outcome?.kind === "unavailable") throw new SecondBrainTransportError(outcome.code, "unavailable", { generation: 1 });
    if (method === "sb_search") return {
      kind: "data" as const,
      value: { results: [{ page_id: "wiki/principle", section: "Rule", snippet: "principle", score: 1 }] },
    };
    if (method === "sb_recent_changes") return {
      kind: "data" as const,
      value: { changes: [{ page_id: "wiki/principle", change: "modified", date: "2026-08-28" }] },
    };
    if (method === "sb_open_conflicts") return {
      kind: "data" as const,
      value: { conflicts: [{ conflict_id: "2026-08-28-project", page_id: "wiki/project", summary: "unresolved" }] },
    };
    if (options.operation?.kind === "conflicts") return page(
      "Use A.[^aaaaaaaa]\nUse B.[^bbbbbbbb]\n[^aaaaaaaa]: source:a\n[^bbbbbbbb]: source:b\n",
      { id: "conflicts/2026-08-28-project", status: "conflict" },
    );
    return page();
  };
}

export async function connectorHarness(options: HarnessOptions = {}) {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const key = options.portfolio_key ?? Buffer.alloc(32, 7);
  const envelope = options.portfolio_envelope ?? Buffer.from(JSON.stringify(signPortfolioEnvelope(localReport({
    reported_at: options.portfolio_reported_at ?? CONNECTOR_NOW.toISOString(),
  }), key)), "utf8");
  const runner = async () => {
    if (options.orca_calls !== undefined) options.orca_calls.count += 1;
    if (options.orca_error !== undefined) throw options.orca_error;
    return JSON.stringify({ ok: true, result: { terminals: [{
      handle: "terminal-1", ptyId: "pty-1", incarnationId: "incarnation-1", worktreeId: "worktree-1",
      worktreePath: "/fixture", title: "ignored prose", connected: options.connected ?? true, writable: false,
      lastOutputAt: CONNECTOR_NOW.getTime(), preview: "ignored body", ...(options.orca_overrides ?? {}),
    }] } });
  };
  const clock = options.clock ?? (() => CONNECTOR_NOW);
  const factory_input = {
    clock,
    second_brain: {
      call: transportCall(options),
      readiness_inspect: async () => ({
        executable: "available", configuration: "valid", contract_digest: SECOND_BRAIN_FROZEN_DIGEST,
        protocol_version: SECOND_BRAIN_PROTOCOL_VERSION, tools: SECOND_BRAIN_REQUIRED_TOOLS, schemas_compatible: true,
        status: "ok", doctor: "ok", handshake: "ok", status_operational: true, doctor_operational: true,
        read_authorization: "authorized", write_authorization: "disabled", data_state: "ready",
        refresh: { kind: "success", completed_at: CONNECTOR_NOW.toISOString() },
      }),
      budgets: { max_hits: 4, max_excerpt_bytes: 256, max_total_bytes: 4_096, max_page_bytes: 8_192 },
      max_age_ms: options.max_age_ms ?? 86_400_000,
      expiry_ms: options.expiry_ms ?? 172_800_000,
      operation: options.operation ?? { kind: "search" as const, query: "fixture" },
    },
    orca: { runner, environment: "local", worktree: "active" },
    timeline: { authority: db, limit: 8 },
    portfolio: {
      envelope,
      key,
      source: "local" as const,
      received_at: options.portfolio_received_at ?? CONNECTOR_NOW,
    },
  };
  return { db, factory_input, registry: createPersonalConnectorRegistry(factory_input) };
}

export function connectorRequest(id: PersonalConnectorId) {
  const table = {
    second_brain: {
      scopes: ["second_brain.search.read"],
      fields: ["evidence_id", "content_digest", "source_version", "sensitivity", "observed_at"],
    },
    orca: {
      scopes: ["orca.identity.read", "orca.connectivity.read", "orca.worktree.read", "orca.terminal.read", "orca.cursor.read"],
      fields: ["environment", "worktree_id", "terminal_id", "incarnation_id", "cursor", "connected", "last_output_at"],
    },
    task_timeline: {
      scopes: ["task_timeline.task.read", "task_timeline.event.read", "task_timeline.decision.read", "task_timeline.evidence.read"],
      fields: ["task_id", "event_id", "decision_id", "evidence_id", "state", "sequence", "observed_at", "pending_approval"],
    },
    portfolio: {
      scopes: ["portfolio.projection.read"],
      fields: [
        "source", "reported_at", "collector_status", "report_digest", "worktree_count", "terminal_count", "clean_count",
        "dirty_count", "dirty_path_count", "active_task_count", "issue_count", "pull_request_count",
      ],
    },
    calendar: { scopes: [], fields: [] }, mail: { scopes: [], fields: [] }, messenger: { scopes: [], fields: [] },
  };
  const selected = table[id];
  return { connector_id: id, scopes: selected.scopes, fields: selected.fields };
}

export function connectorSessionRequest(id: PersonalConnectorId, handle?: string) {
  return {
    ...connectorRequest(id),
    checkpoint_session: handle === undefined
      ? { mode: "start" as const, version: 1 as const }
      : { mode: "continue" as const, version: 1 as const, handle },
  };
}
