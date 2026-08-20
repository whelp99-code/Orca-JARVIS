import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { PortfolioProjection } from "../../src/dashboard/portfolio-projection.js";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";
import { localReport, PORTFOLIO_AT } from "../fixtures/portfolio-report.js";
import { tempDb } from "../helpers.js";

const roots = new Set<string>();
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function start(clock = () => new Date(PORTFOLIO_AT)) {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  roots.add(dirname(db.filename));
  const root = mkdtempSync(join(tmpdir(), "jarvis-portfolio-api-"));
  roots.add(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><title>JARVIS</title>");
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock });
  return { db, server, origin: `http://${server.address.host}:${String(server.address.port)}` };
}

describe("dashboard overview portfolio field", () => {
  it("returns deterministic LOCAL then JM-SERVER unseen entries without mutating health", async () => {
    const { db, server, origin } = await start();
    try {
      const overview = await request(`${origin}/api/v1/overview`);
      expect(overview.statusCode).toBe(200);
      const body = JSON.parse(await overview.body.text()) as OverviewResponse;
      expect(body.portfolio.hosts.map(host => host.label)).toEqual(["LOCAL", "JM-SERVER"]);
      expect(body.portfolio.hosts.map(host => host.freshness)).toEqual(["unseen", "unseen"]);
      expect(body.portfolio.summary).toBeNull();
      const health = await request(`${origin}/api/v1/health`);
      expect(health.statusCode).toBe(200);
      const healthBody = JSON.parse(await health.body.text()) as { status: string; authority: string };
      expect(healthBody).toMatchObject({ status: "ok", authority: "ready" });
      expect("portfolio" in healthBody).toBe(false);
    } finally {
      server.close();
      db.close();
    }
  });

  it("projects LOCAL-owned summary and freshness from last_received_at using the injected clock", async () => {
    const { db, server, origin } = await start(() => new Date("2026-08-20T00:01:00.000Z"));
    try {
      new PortfolioProjection(db).ingest("local", Buffer.from(JSON.stringify(localReport()), "utf8"), new Date(PORTFOLIO_AT));
      const overview = await request(`${origin}/api/v1/overview`);
      const body = JSON.parse(await overview.body.text()) as OverviewResponse;
      expect(body.portfolio.hosts[0]).toMatchObject({ label: "LOCAL", freshness: "live", worktree_count: 4 });
      expect(body.portfolio.summary?.github).toEqual({ issue_count: 11, pull_request_count: 3 });
    } finally {
      server.close();
      db.close();
    }
  });

  it("does not expose an HTTP ingest route", async () => {
    const { db, server, origin } = await start();
    try {
      const sessionResponse = await request(`${origin}/api/v1/session`);
      const session = JSON.parse(await sessionResponse.body.text()) as { csrf_token: string };
      for (const path of ["/api/v1/portfolio", "/api/v1/portfolio/ingest"]) {
        const response = await request(`${origin}${path}`, {
          method: "POST",
          body: "{}",
          headers: {
            "content-type": "application/json",
            origin,
            "x-jarvis-csrf": session.csrf_token,
          },
        });
        expect(response.statusCode).toBe(404);
        const body = JSON.parse(await response.body.text()) as { error: { code: string } };
        expect(body.error.code).toBe("NOT_FOUND");
      }
    } finally {
      server.close();
      db.close();
    }
  });
});
