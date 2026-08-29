import {
  AuthorityDb,
  OrcaPersonalConnectorSource,
  OrcaReadonlyAdapter,
  PortfolioPersonalConnectorSource,
  SecondBrainPersonalConnectorSource,
  TaskTimeline,
  TaskTimelinePersonalConnectorSource,
  createPersonalConnectorRegistry,
  SECOND_BRAIN_FROZEN_DIGEST,
  SECOND_BRAIN_PROTOCOL_VERSION,
  SECOND_BRAIN_REQUIRED_TOOLS,
  type PersonalConnectorId,
  type SecondBrainReadOutcome,
} from "../../src/index.js";
import { signPortfolioEnvelope } from "../../src/dashboard/portfolio-auth.js";
import { localReport } from "./portfolio-report.js";
import { tempDb } from "../helpers.js";

export const CONNECTOR_NOW = new Date("2026-08-28T12:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;

export function currentMemoryOutcome(observedAt = CONNECTOR_NOW.toISOString()): SecondBrainReadOutcome {
  return {
    kind: "current",
    checked_at: CONNECTOR_NOW.toISOString(),
    evidence: [{
      kind: "memory", page_id: "page-1", sid: "sid-1", source_ref: "source-1",
      source_id: "src:pos:v1:second-brain:primary", source_version: "source-v1", sensitivity: "personal",
      observed_at: observedAt, valid_at: observedAt,
      freshness: { state: "fresh", checked_at: CONNECTOR_NOW.toISOString(), fresh_until: CONNECTOR_NOW.toISOString() },
      expires_at: CONNECTOR_NOW.toISOString(), trust: "untrusted", authority: "none", excerpt: null,
      content_digest: DIGEST, omission: null,
    }],
  };
}

function memorySource(outcome: SecondBrainReadOutcome): SecondBrainPersonalConnectorSource {
  const adapter = {
    search: async () => outcome, readPage: async () => outcome,
    recentChanges: async () => outcome, openConflicts: async () => outcome,
  };
  return new SecondBrainPersonalConnectorSource({
    adapter,
    readiness: { inspect: async () => ({
      executable: "available", configuration: "valid", contract_digest: SECOND_BRAIN_FROZEN_DIGEST,
      protocol_version: SECOND_BRAIN_PROTOCOL_VERSION, tools: SECOND_BRAIN_REQUIRED_TOOLS, schemas_compatible: true,
      status: "ok", doctor: "ok", handshake: "ok", status_operational: true, doctor_operational: true,
      read_authorization: "authorized", write_authorization: "disabled", data_state: "ready",
      refresh: { kind: "success", completed_at: CONNECTOR_NOW.toISOString() },
    }) },
    read: { kind: "search", query: "fixture" },
  });
}

type OrcaFixture = {
  readonly connected: boolean;
  readonly overrides: Readonly<Record<string, unknown>>;
  readonly error: Error | undefined;
  readonly calls: { count: number } | undefined;
};

function orcaSource(fixture: OrcaFixture): OrcaPersonalConnectorSource {
  const runner = async () => {
    if (fixture.calls !== undefined) fixture.calls.count += 1;
    if (fixture.error !== undefined) throw fixture.error;
    return JSON.stringify({ ok: true, result: { terminals: [{
    handle: "terminal-1", ptyId: "pty-1", incarnationId: "incarnation-1", worktreeId: "worktree-1",
    worktreePath: "/fixture", title: "ignored prose", connected: fixture.connected, writable: false,
    lastOutputAt: CONNECTOR_NOW.getTime(), preview: "ignored body", ...fixture.overrides,
  }] } });
  };
  return new OrcaPersonalConnectorSource({ adapter: new OrcaReadonlyAdapter(runner), environment: "local", worktree: "active" });
}

export async function connectorHarness(options: {
  readonly outcome?: SecondBrainReadOutcome;
  readonly connected?: boolean;
  readonly clock?: () => Date;
  readonly orca_overrides?: Readonly<Record<string, unknown>>;
  readonly portfolio_envelope?: Buffer;
  readonly portfolio_key?: Buffer;
  readonly orca_error?: Error;
  readonly orca_calls?: { count: number };
} = {}) {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const key = options.portfolio_key ?? Buffer.alloc(32, 7);
  const envelope = options.portfolio_envelope
    ?? Buffer.from(JSON.stringify(signPortfolioEnvelope(localReport(), key)), "utf8");
  const sources = {
    second_brain: memorySource(options.outcome ?? currentMemoryOutcome()),
    orca: orcaSource({
      connected: options.connected ?? true,
      overrides: options.orca_overrides ?? {},
      error: options.orca_error,
      calls: options.orca_calls,
    }),
    task_timeline: new TaskTimelinePersonalConnectorSource({ timeline: new TaskTimeline(db), limit: 8 }),
    portfolio: new PortfolioPersonalConnectorSource({ envelope, key, source: "local", received_at: CONNECTOR_NOW }),
  };
  return {
    db,
    sources,
    registry: createPersonalConnectorRegistry({ sources, clock: options.clock ?? (() => CONNECTOR_NOW) }),
  };
}

export function connectorRequest(id: PersonalConnectorId, checkpoint?: string) {
  const table = {
    second_brain: {
      scopes: ["second_brain.search.read", "second_brain.page.read", "second_brain.recent.read", "second_brain.conflict.read"],
      fields: ["evidence_id", "content_digest", "source_version", "sensitivity", "observed_at", "conflict_id"],
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
  return { connector_id: id, scopes: selected.scopes, fields: selected.fields, ...(checkpoint === undefined ? {} : { checkpoint }) };
}
