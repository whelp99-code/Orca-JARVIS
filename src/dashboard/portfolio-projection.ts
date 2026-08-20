import type { AuthorityDb } from "../db.js";
import { JarvisError } from "../db.js";
import {
  PORTFOLIO_CLOCK_SKEW_MS,
  PORTFOLIO_ENVIRONMENTS,
  PORTFOLIO_LABELS,
  PORTFOLIO_LIVE_MS,
  PORTFOLIO_PRODUCERS,
  PORTFOLIO_STALE_MS,
  type PortfolioEnvironment,
  type PortfolioFreshness,
  type PortfolioHostOverview,
  type PortfolioOverview,
  type PortfolioReportV1,
  type PortfolioSummaryOverview,
} from "./portfolio-contracts.js";
import { digestPortfolioValue, parsePortfolioIngest } from "./portfolio-parse.js";

type ProjectionRow = {
  readonly environment: PortfolioEnvironment;
  readonly producer: string;
  readonly last_reported_at: string;
  readonly last_received_at: string;
  readonly report_digest: string;
  readonly collector_status: "ok" | "error";
  readonly collector_error: string | null;
  readonly last_success_snapshot_json: string | null;
  readonly last_success_digest: string | null;
};

export type PortfolioIngestResult = {
  readonly environment: PortfolioEnvironment;
  readonly idempotent: boolean;
  readonly digest: string;
};

export class PortfolioProjection {
  constructor(private readonly authority: AuthorityDb) {}

  ingest(
    source: PortfolioEnvironment,
    input: Buffer,
    receivedAt = new Date(),
  ): PortfolioIngestResult {
    const parsed = parsePortfolioIngest(input);
    const envelope = parsed.kind === "report" ? parsed.report : parsed.error;
    if (envelope.source !== source) throw new JarvisError("PORTFOLIO_SOURCE_MISMATCH");
    if (parsed.kind === "report") {
      const skew = Date.parse(parsed.report.reported_at) - receivedAt.getTime();
      if (skew > PORTFOLIO_CLOCK_SKEW_MS) throw new JarvisError("PORTFOLIO_CLOCK_SKEW");
    }
    const digest = digestPortfolioValue(envelope);
    const transaction = this.authority.db.transaction(() => {
      const existing = this.row(source);
      if (existing !== undefined) {
        const ordering = envelope.reported_at.localeCompare(existing.last_reported_at);
        if (ordering < 0) throw new JarvisError("PORTFOLIO_OUT_OF_ORDER");
        if (ordering === 0) {
          if (digest !== existing.report_digest) throw new JarvisError("PORTFOLIO_REPLAY_CONFLICT");
          return true;
        }
      }
      const received = receivedAt.toISOString();
      const producer = PORTFOLIO_PRODUCERS[source];
      if (parsed.kind === "report") {
        const snapshotJson = JSON.stringify(parsed.report);
        this.authority.db.prepare(`
          INSERT INTO dashboard_portfolio_projection(
            environment, producer, last_reported_at, last_received_at, report_digest,
            collector_status, collector_error, last_success_snapshot_json, last_success_digest
          ) VALUES(?, ?, ?, ?, ?, 'ok', NULL, ?, ?)
          ON CONFLICT(environment) DO UPDATE SET
            producer=excluded.producer,
            last_reported_at=excluded.last_reported_at,
            last_received_at=excluded.last_received_at,
            report_digest=excluded.report_digest,
            collector_status='ok',
            collector_error=NULL,
            last_success_snapshot_json=excluded.last_success_snapshot_json,
            last_success_digest=excluded.last_success_digest
        `).run(
          source,
          producer,
          parsed.report.reported_at,
          received,
          digest,
          snapshotJson,
          digest,
        );
      } else {
        this.authority.db.prepare(`
          INSERT INTO dashboard_portfolio_projection(
            environment, producer, last_reported_at, last_received_at, report_digest,
            collector_status, collector_error, last_success_snapshot_json, last_success_digest
          ) VALUES(?, ?, ?, ?, ?, 'error', ?, NULL, NULL)
          ON CONFLICT(environment) DO UPDATE SET
            producer=excluded.producer,
            last_reported_at=excluded.last_reported_at,
            last_received_at=excluded.last_received_at,
            report_digest=excluded.report_digest,
            collector_status='error',
            collector_error=excluded.collector_error
        `).run(
          source,
          producer,
          parsed.error.reported_at,
          received,
          digest,
          parsed.error.collector_error,
        );
      }
      return false;
    });
    return { environment: source, idempotent: transaction(), digest };
  }

  overview(now = new Date()): PortfolioOverview {
    const rows = new Map(
      (this.authority.db.prepare(`
        SELECT environment, producer, last_reported_at, last_received_at, report_digest,
          collector_status, collector_error, last_success_snapshot_json, last_success_digest
        FROM dashboard_portfolio_projection
      `).all() as ProjectionRow[]).map(row => [row.environment, row]),
    );
    const hosts = PORTFOLIO_ENVIRONMENTS.map(environment => this.host(environment, rows.get(environment), now));
    const local = rows.get("local");
    return {
      hosts,
      summary: local === undefined ? null : summaryFromRow(local),
    };
  }

  private row(environment: PortfolioEnvironment): ProjectionRow | undefined {
    return this.authority.db.prepare(`
      SELECT environment, producer, last_reported_at, last_received_at, report_digest,
        collector_status, collector_error, last_success_snapshot_json, last_success_digest
      FROM dashboard_portfolio_projection
      WHERE environment=?
    `).get(environment) as ProjectionRow | undefined;
  }

  private host(
    environment: PortfolioEnvironment,
    row: ProjectionRow | undefined,
    now: Date,
  ): PortfolioHostOverview {
    if (row === undefined) {
      return {
        environment,
        label: PORTFOLIO_LABELS[environment],
        freshness: "unseen",
        updated_at: null,
        collector_status: "unseen",
        collector_error: null,
        worktree_count: null,
        terminal_count: null,
        clean_count: null,
        dirty_count: null,
        dirty_path_count: null,
        active_task_count: null,
      };
    }
    const report = reportFromRow(row);
    const counts = report?.host;
    return {
      environment,
      label: PORTFOLIO_LABELS[environment],
      freshness: portfolioFreshness(row.last_received_at, now),
      updated_at: row.last_received_at,
      collector_status: row.collector_status,
      collector_error: row.collector_error,
      worktree_count: counts?.worktree_count ?? null,
      terminal_count: counts?.terminal_count ?? null,
      clean_count: counts?.clean_count ?? null,
      dirty_count: counts?.dirty_count ?? null,
      dirty_path_count: counts?.dirty_path_count ?? null,
      active_task_count: counts?.active_task_count ?? null,
    };
  }
}

export function portfolioFreshness(receivedAt: string | null, now: Date): PortfolioFreshness {
  if (receivedAt === null) return "unseen";
  const age = Math.max(0, now.getTime() - Date.parse(receivedAt));
  if (age <= PORTFOLIO_LIVE_MS) return "live";
  if (age <= PORTFOLIO_STALE_MS) return "stale";
  return "offline";
}

function reportFromRow(row: ProjectionRow): PortfolioReportV1 | null {
  if (row.last_success_snapshot_json === null) return null;
  const parsed = parsePortfolioIngest(Buffer.from(row.last_success_snapshot_json, "utf8"));
  if (parsed.kind !== "report" || parsed.report.source !== row.environment) {
    throw new JarvisError("PORTFOLIO_DATA_INVALID");
  }
  return parsed.report;
}

function summaryFromRow(row: ProjectionRow): PortfolioSummaryOverview | null {
  const report = reportFromRow(row);
  if (report === null || report.source !== "local") return null;
  return {
    github: report.github,
    milestones: report.milestones,
    blockers: report.blockers,
  };
}
