import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { PortfolioProjection, portfolioFreshness } from "../../src/dashboard/portfolio-projection.js";
import { collectorError, jmReport, localReport, PORTFOLIO_AT } from "../fixtures/portfolio-report.js";
import { tempDb } from "../helpers.js";

const T0 = new Date(PORTFOLIO_AT);
const later = (ms: number): Date => new Date(T0.getTime() + ms);

async function projection(): Promise<{ db: AuthorityDb; store: PortfolioProjection }> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  return { db, store: new PortfolioProjection(db) };
}

function ingestJson(store: PortfolioProjection, source: "local" | "jm-server", value: unknown, now = T0) {
  return store.ingest(source, Buffer.from(JSON.stringify(value), "utf8"), now);
}

describe("portfolio projection ownership and replay", () => {
  it("stores jarvis-local and jarvis-jm-server producers for matching environments", async () => {
    const { db, store } = await projection();
    ingestJson(store, "local", localReport());
    ingestJson(store, "jm-server", jmReport());
    const rows = db.db.prepare("SELECT environment, producer FROM dashboard_portfolio_projection ORDER BY environment").all() as Array<{ environment: string; producer: string }>;
    expect(rows).toEqual([
      { environment: "jm-server", producer: "jarvis-jm-server" },
      { environment: "local", producer: "jarvis-local" },
    ]);
    expect(() => db.db.prepare("INSERT INTO dashboard_portfolio_projection(environment, producer, last_reported_at, last_received_at, report_digest, collector_status, collector_error) VALUES('local','jarvis-jm-server',?,?,?,'error','x')").run(PORTFOLIO_AT, PORTFOLIO_AT, "sha256:test")).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("rejects reports more than five minutes ahead of trusted receipt time", async () => {
    const { db, store } = await projection();
    expect(() => ingestJson(store, "local", localReport({ reported_at: "9999-12-31T23:59:59.999Z" }))).toThrow(expect.objectContaining({ code: "PORTFOLIO_CLOCK_SKEW" }));
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM dashboard_portfolio_projection").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("rejects source mismatch, out-of-order timestamps, and conflicting replay", async () => {
    const { db, store } = await projection();
    expect(() => ingestJson(store, "local", jmReport())).toThrow(expect.objectContaining({ code: "PORTFOLIO_SOURCE_MISMATCH" }));
    ingestJson(store, "local", localReport({ reported_at: "2026-08-20T00:01:00.000Z" }));
    expect(() => ingestJson(store, "local", localReport({ reported_at: "2026-08-20T00:00:00.000Z" }))).toThrow(expect.objectContaining({ code: "PORTFOLIO_OUT_OF_ORDER" }));
    expect(() => ingestJson(store, "local", localReport({ reported_at: "2026-08-20T00:01:00.000Z", github: { issue_count: 99, pull_request_count: 1 } }))).toThrow(expect.objectContaining({ code: "PORTFOLIO_REPLAY_CONFLICT" }));
    expect(ingestJson(store, "local", localReport({ reported_at: "2026-08-20T00:01:00.000Z" })).idempotent).toBe(true);
    db.close();
  });

  it("retains the last success snapshot when a collector error is ingested", async () => {
    const { db, store } = await projection();
    ingestJson(store, "local", localReport());
    ingestJson(store, "local", collectorError("local", { reported_at: "2026-08-20T00:02:00.000Z" }), later(2_000));
    const overview = store.overview(later(3_000));
    expect(overview.hosts[0]).toMatchObject({
      environment: "local",
      collector_status: "error",
      collector_error: "ORCA_UNAVAILABLE",
      worktree_count: 4,
      active_task_count: 5,
    });
    expect(overview.summary).toEqual({
      github: { issue_count: 11, pull_request_count: 3 },
      milestones: [{ title: "Control center", state: "in_progress" }],
      blockers: [{ title: "Approve live resume", kind: "approval_required" }],
    });
    db.close();
  });
});

describe("portfolio freshness from injected read time", () => {
  it("classifies unseen, live, stale, and offline from last_received_at", () => {
    expect(portfolioFreshness(null, T0)).toBe("unseen");
    expect(portfolioFreshness(PORTFOLIO_AT, later(90_000))).toBe("live");
    expect(portfolioFreshness(PORTFOLIO_AT, later(90_001))).toBe("stale");
    expect(portfolioFreshness(PORTFOLIO_AT, later(300_000))).toBe("stale");
    expect(portfolioFreshness(PORTFOLIO_AT, later(300_001))).toBe("offline");
  });

  it("returns LOCAL then JM-SERVER entries with unseen defaults when empty", async () => {
    const { db, store } = await projection();
    const overview = store.overview(T0);
    expect(overview.hosts.map(host => host.label)).toEqual(["LOCAL", "JM-SERVER"]);
    expect(overview.hosts.every(host => host.freshness === "unseen")).toBe(true);
    expect(overview.summary).toBeNull();
    db.close();
  });
});
