import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalize } from "./canonical.js";
import { assemblePersonalContext } from "./context-assembler.js";
import { classifyAssembledCitations } from "./personal-context-citation-contract.js";
import type { ObservationEnvelopeV1 } from "./personal-contracts.js";
import { parseObservationEnvelopeV1 } from "./personal-validation.js";

export const HERDR_LIVE_SOURCE = "src:pos:v1:herdr:local";
export const HERDR_FORBIDDEN_SOURCE = "src:pos:v1:orca:local";
const LINUX_HOST = "host:pos:linux-control-plane";
const GAJAE_AGENT = "gjc";
const ACTIVE = new Set(["working", "blocked", "done"]);
const ALLOWED_METHODS = new Set(["session.snapshot", "schema"]);
const FORBIDDEN_METHODS = new Set([
  "pane.read", "agent.read", "pane.selection.read", "pane.send_text", "pane.send_keys",
  "pane.send_input", "agent.prompt", "agent.start", "tab.create", "tab.close",
  "workspace.create", "workspace.close", "plugin.action.invoke",
]);
const AGENT_STATUSES = new Set(["idle", "working", "blocked", "done", "unknown"]);

export type HerdrWorkspace = {
  readonly workspace_id: string;
  readonly label: string;
};

export type HerdrTab = {
  readonly tab_id: string;
  readonly workspace_id: string;
};

export type HerdrPane = {
  readonly pane_id: string;
  readonly tab_id: string;
  readonly agent: string | null;
  readonly agent_status: string;
  readonly focused: boolean;
  readonly revision: number;
};

export type HerdrSnapshot = {
  readonly id: string;
  readonly result: {
    readonly type: "session_snapshot";
    readonly snapshot: {
      readonly protocol: number;
      readonly version: string;
      readonly workspaces: readonly HerdrWorkspace[];
      readonly tabs: readonly HerdrTab[];
      readonly panes: readonly HerdrPane[];
    };
  };
};

export type HerdrSchema = {
  readonly methods: readonly string[];
  readonly agent_status: readonly string[];
};

export type TimetableItem = {
  readonly id: string;
  readonly bot: string;
  readonly start: string;
  readonly status: string;
};

export type HerdrTodayFact = {
  readonly source_id: typeof HERDR_LIVE_SOURCE;
  readonly source_kind: "live_adapter";
  readonly host_id: typeof LINUX_HOST;
  readonly kind: "live_task";
  readonly trust: "verified";
  readonly state: string;
  readonly pane_id: string;
  readonly revision: number;
  readonly timetable_id: string | null;
  readonly start: string | null;
};

export class HerdrTodayError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "HerdrTodayError";
    this.code = code;
  }
}

function reject(code: string): never {
  throw new HerdrTodayError(code);
}

export function herdrMethodAllowed(method: string): boolean {
  if (FORBIDDEN_METHODS.has(method) || !ALLOWED_METHODS.has(method)) reject("HERDR_METHOD_FORBIDDEN");
  return true;
}

export function assertHerdrSource(sourceId: string): void {
  if (sourceId === HERDR_FORBIDDEN_SOURCE || sourceId !== HERDR_LIVE_SOURCE) reject("HERDR_SOURCE_FORBIDDEN");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function workspaceOf(value: unknown): HerdrWorkspace | null {
  if (!isRecord(value) || typeof value.workspace_id !== "string" || typeof value.label !== "string") return null;
  return { workspace_id: value.workspace_id, label: value.label };
}

function tabOf(value: unknown): HerdrTab | null {
  if (!isRecord(value) || typeof value.tab_id !== "string" || typeof value.workspace_id !== "string") return null;
  return { tab_id: value.tab_id, workspace_id: value.workspace_id };
}

function paneOf(value: unknown): HerdrPane | null {
  if (!isRecord(value)) return null;
  if (typeof value.pane_id !== "string" || typeof value.tab_id !== "string") return null;
  if (!(value.agent === undefined || value.agent === null || typeof value.agent === "string")) return null;
  if (typeof value.agent_status !== "string" || typeof value.focused !== "boolean" || !Number.isInteger(value.revision)) return null;
  return {
    pane_id: value.pane_id,
    tab_id: value.tab_id,
    agent: value.agent ?? null,
    agent_status: value.agent_status,
    focused: value.focused,
    revision: value.revision,
  };
}

export function parseHerdrSnapshot(value: unknown): HerdrSnapshot {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.result)) reject("HERDR_SNAPSHOT_INVALID");
  if (value.result.type !== "session_snapshot" || !isRecord(value.result.snapshot)) reject("HERDR_SNAPSHOT_INVALID");
  const body = value.result.snapshot;
  if (!Number.isInteger(body.protocol) || typeof body.version !== "string") reject("HERDR_SNAPSHOT_INVALID");
  if (!Array.isArray(body.workspaces) || !Array.isArray(body.tabs) || !Array.isArray(body.panes)) reject("HERDR_SNAPSHOT_INVALID");
  const workspaces = body.workspaces.map(workspaceOf);
  const tabs = body.tabs.map(tabOf);
  const panes = body.panes.map(paneOf);
  if (workspaces.some(item => item === null) || tabs.some(item => item === null) || panes.some(item => item === null)) {
    reject("HERDR_SNAPSHOT_INVALID");
  }
  const workspaceIds = new Set(workspaces.map(item => item!.workspace_id));
  const tabIds = new Set<string>();
  for (const tab of tabs) {
    if (tabIds.has(tab!.tab_id) || !workspaceIds.has(tab!.workspace_id)) reject("HERDR_SNAPSHOT_INVALID");
    tabIds.add(tab!.tab_id);
  }
  if (panes.some(pane => !tabIds.has(pane!.tab_id))) reject("HERDR_SNAPSHOT_INVALID");
  return {
    id: value.id,
    result: {
      type: "session_snapshot",
      snapshot: {
        protocol: body.protocol,
        version: body.version,
        workspaces: workspaces as HerdrWorkspace[],
        tabs: tabs as HerdrTab[],
        panes: panes as HerdrPane[],
      },
    },
  };
}

export function assertHerdrSchema(schema: HerdrSchema): void {
  if (!schema.methods.includes("session.snapshot")) reject("HERDR_SCHEMA_INVALID");
  const statuses = [...schema.agent_status].sort().join(",");
  if (statuses !== [...AGENT_STATUSES].sort().join(",")) reject("HERDR_SCHEMA_INVALID");
}

const GAJAE_LABEL = "가재군";

export function selectGajaePane(snapshot: HerdrSnapshot): HerdrPane | null {
  const body = snapshot.result.snapshot;
  const gajaeIds = new Set(body.workspaces.filter(workspace => workspace.label === GAJAE_LABEL).map(workspace => workspace.workspace_id));
  const tabWorkspace = new Map(body.tabs.map(tab => [tab.tab_id, tab.workspace_id]));
  const gajae = body.panes.filter(pane => {
    const workspaceId = tabWorkspace.get(pane.tab_id);
    return workspaceId !== undefined && gajaeIds.has(workspaceId)
      && (pane.agent === null || pane.agent === "" || pane.agent === GAJAE_AGENT);
  });
  const focused = gajae.find(pane => pane.focused && ACTIVE.has(pane.agent_status));
  if (focused !== undefined) return focused;
  const active = gajae.filter(pane => ACTIVE.has(pane.agent_status));
  if (active.length === 0) return null;
  return active.reduce((best, pane) => pane.revision > best.revision ? pane : best);
}

export function selectTimetable(items: readonly TimetableItem[]): { id: string; start: string } | null {
  const open = items.filter(item => item.bot === "가재" && item.status.split("(")[0] === "진행 중");
  if (open.length === 0) return null;
  const top = open.reduce((best, item) => item.start > best.start ? item : best);
  if (open.filter(item => item.start === top.start).length !== 1) return { id: "", start: top.start };
  return { id: top.id, start: top.start };
}

export function collectHerdrToday(input: {
  readonly snapshot: unknown;
  readonly schema: HerdrSchema;
  readonly timetable: readonly TimetableItem[];
  readonly methods?: readonly string[];
}): readonly HerdrTodayFact[] {
  for (const method of input.methods ?? ["session.snapshot"]) herdrMethodAllowed(method);
  assertHerdrSource(HERDR_LIVE_SOURCE);
  assertHerdrSchema(input.schema);
  const pane = selectGajaePane(parseHerdrSnapshot(input.snapshot));
  if (pane === null) return [];
  const named = selectTimetable(input.timetable);
  return [{
    source_id: HERDR_LIVE_SOURCE,
    source_kind: "live_adapter",
    host_id: LINUX_HOST,
    kind: "live_task",
    trust: "verified",
    state: pane.agent_status,
    pane_id: pane.pane_id,
    revision: pane.revision,
    timetable_id: named !== null && named.id !== "" ? named.id : null,
    start: named !== null && named.id !== "" ? named.start : null,
  }];
}

export function readTimetableFile(path: string): readonly TimetableItem[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown };
  if (!Array.isArray(parsed.items)) reject("HERDR_TIMETABLE_INVALID");
  return parsed.items.flatMap(item => {
    if (item === null || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.bot !== "string"
      || typeof row.start !== "string" || typeof row.status !== "string") return [];
    return [{ id: row.id, bot: row.bot, start: row.start, status: row.status }];
  });
}

export function herdrFactEnvelope(fact: HerdrTodayFact, checkedAt: string): ObservationEnvelopeV1 {
  assertHerdrSource(fact.source_id);
  if (fact.trust !== "verified") reject("HERDR_TRUST_UNVERIFIED");
  const subject = fact.timetable_id === null ? `pane:${fact.pane_id}` : `task:${fact.timetable_id}`;
  const value = {
    state: fact.state,
    pane_id: fact.pane_id,
    revision: fact.revision,
    ...(fact.timetable_id === null ? {} : { timetable_id: fact.timetable_id, start: fact.start }),
  };
  const digest = `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
  const hex = digest.slice(7);
  const identity = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(12, 15)}-8${hex.slice(15, 18)}-${hex.slice(18, 30)}`;
  const observedAt = new Date(Date.parse(checkedAt) - 1_000).toISOString();
  return parseObservationEnvelopeV1({
    schema_version: 1,
    id: `obs:pos:v1:${fact.source_id}:${identity}`,
    created_at: checkedAt,
    observed_at: observedAt,
    valid_at: observedAt,
    source: {
      source_id: fact.source_id,
      source_kind: fact.source_kind,
      host_id: fact.host_id,
      source_version: "herdr-snapshot-v1",
      evidence_ref: `herdr:${fact.pane_id}:${fact.revision}`,
    },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: {
      state: "fresh", checked_at: checkedAt,
      fresh_until: new Date(Date.parse(checkedAt) + 300_000).toISOString(),
    },
    expires_at: new Date(Date.parse(checkedAt) + 3_600_000).toISOString(),
    idempotency_key: `idem:pos:v1:herdr:${hex}`,
    correlation_id: `corr:pos:v1:${identity}`,
    causation_id: null,
    payload: {
      kind: fact.kind, subject, value, trust: fact.trust, sensitivity: "personal",
      cursor: String(fact.revision), checkpoint: `${fact.pane_id}:${fact.revision}`,
      content_digest: digest, state: "fresh",
    },
    policy_decision: { decision: "allow", policy_version: "personal-observation-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence: [{
      evidence_id: `evi:pos:v1:${identity}`, digest, kind: "structured_ref",
      source_id: fact.source_id, observed_at: observedAt,
    }],
    receipt: null,
  });
}

export function classifyHerdrFact(fact: HerdrTodayFact, checkedAt: string): number {
  if (fact.trust !== "verified") return 0;
  const observation = herdrFactEnvelope(fact, checkedAt);
  const classified = classifyAssembledCitations(assemblePersonalContext({
    purpose: "daily_prioritization", query: "today", clock: checkedAt, expires_in_ms: 240_000,
    budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 },
    observations: [observation], pending_authority_refs: [], memories: [],
  }), [observation], []);
  return classified.citable.filter(item => item.citation_kind === "linux_live_fact").length;
}

export function herdrCollectorSideEffects(): readonly string[] {
  return [];
}
