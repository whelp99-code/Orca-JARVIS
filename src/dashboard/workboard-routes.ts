import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ActionCapability } from "../workboard/action-contracts.js";
import type { WorkboardActions } from "../workboard/actions.js";
import type { ServerResponse } from "node:http";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { writeDashboardJson } from "./http.js";
import type { AttentionItem, AttentionRow } from "../workboard/attention.js";
import { readWorkboard, type SourceCoverageRow } from "../workboard/projection.js";
import type { ActionDelivery, AttemptExecution, Disposition } from "../workboard/state.js";
import { assembleWorkboard } from "./workboard-cards.js";

/**
 * GET /api/v1/workboard: a read-only view over the stored workboard projection.
 * No Orca call, no DB write. Collectors own every workboard table; this route only SELECTs.
 * Identifiers (work/session/attempt keys, digests, source generations) travel in `evidence`
 * so the UI can keep them out of the default render.
 */
export const WORKBOARD_PATH = "/api/v1/workboard";

const REQUIRED_TABLES = [
  "workboard_works", "workboard_sources", "workboard_attention",
  "workboard_purposes", "workboard_purpose_candidates", "workboard_purpose_bindings",
] as const;

export type WorkboardPurposeStatus = "confirmed" | "proposed" | "unknown";
export type WorkboardWaitKind = NonNullable<AttentionRow["wait_kind"]>;
export type WorkboardEvidenceItem = { readonly label: string; readonly value: string };
export type WorkboardCard = {
  readonly work_id: string;
  readonly action_capability?: ActionCapability;
  readonly summary: string;
  readonly source: { readonly host: string; readonly app: string; readonly scope: string };
  readonly disposition: Disposition;
  readonly attempt_execution: AttemptExecution;
  readonly action_delivery: ActionDelivery;
  readonly freshness: AttentionItem["freshness"];
  readonly rank: AttentionItem["rank"];
  readonly reasons: readonly string[];
  readonly wait_kind: WorkboardWaitKind | null;
  readonly wait_reason: string | null;
  readonly wait_started_at: string | null;
  readonly deadline_at: string | null;
  readonly impact: number | null;
  readonly actions_enabled: boolean;
  readonly warning: string | null;
  readonly source_at: string;
  readonly observed_at: string | null;
  readonly purpose: {
    readonly project_id: string | null;
    readonly text: string | null;
    readonly status: WorkboardPurposeStatus;
    readonly why: string | null;
    readonly needs_reconfirmation: boolean;
  };
  readonly evidence: readonly WorkboardEvidenceItem[];
};
export type WorkboardGroup = {
  readonly project_id: string | null;
  readonly purpose: string | null;
  readonly status: WorkboardPurposeStatus;
  readonly works: readonly WorkboardCard[];
};
export type WorkboardSourceCoverage = {
  readonly id: string;
  readonly classification: "current_work" | "unknown_current_work_coverage";
  readonly reason: string | null;
  readonly current_work_total: number | null;
};
export type WorkboardResponse = {
  readonly schema_version: typeof DASHBOARD_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly collected: boolean;
  readonly attention: readonly WorkboardCard[];
  readonly groups: readonly WorkboardGroup[];
  readonly sources: readonly WorkboardSourceCoverage[];
};

export type WorkboardReadInput = {
  readonly db: Database.Database;
  readonly path: string;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly now: Date;
  readonly actions?: WorkboardActions;
};

export function tryHandleWorkboardRead(input: WorkboardReadInput): boolean {
  if (input.path !== WORKBOARD_PATH) return false;
  writeDashboardJson(input.response, {
    status: 200,
    body: readWorkboardResponse(input.db, input.now, input.actions),
    requestId: input.requestId,
  });
  return true;
}

const sourceConfig = JSON.parse(readFileSync(resolve("config/workboard-sources.json"), "utf8")) as {
  source_ids: string[]; coverage_limitations: Record<string, string>;
};
const missingObservation = "현재 작업 관측 결과가 아직 등록되지 않았습니다.";

function sourceCoverage(rows: readonly SourceCoverageRow[]): WorkboardSourceCoverage[] {
  const byId = new Map<string, SourceCoverageRow>();
  for (const row of rows) {
    const id = sourceConfig.source_ids.find(id => row.source_key === id || row.source_key.startsWith(`${id}:`))
      ?? row.source_key.split(":").slice(0, -1).join(":");
    byId.set(id, row);
  }
  return [...new Set([...sourceConfig.source_ids, ...byId.keys()])].map(id => {
    const row = byId.get(id);
    const total = row?.current_work_total ?? null;
    return {
      id,
      classification: total === null ? "unknown_current_work_coverage" : "current_work",
      reason: total === null ? row?.warning ?? sourceConfig.coverage_limitations[id] ?? missingObservation : null,
      current_work_total: total,
    };
  });
}

export function readWorkboardResponse(db: Database.Database, now: Date, actions?: WorkboardActions): WorkboardResponse {
  const generated_at = now.toISOString();
  if (!tablesPresent(db)) {
    return {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      generated_at,
      collected: false,
      attention: [],
      groups: [],
      sources: sourceCoverage([]),
    };
  }
  return db.transaction((): WorkboardResponse => {
    const projection = readWorkboard(db, now);
    const assembled = assembleWorkboard(db, projection, actions);
    return {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      generated_at,
      collected: true,
      attention: assembled.attention,
      groups: assembled.groups,
      sources: sourceCoverage(projection.sources),
    };
  })();
}

function tablesPresent(db: Database.Database): boolean {
  const placeholders = REQUIRED_TABLES.map(() => "?").join(",");
  const row = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`)
    .get(...REQUIRED_TABLES) as { count: number };
  return row.count === REQUIRED_TABLES.length;
}
