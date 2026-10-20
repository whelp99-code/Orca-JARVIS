import { describe, expect, it, vi } from "vitest";
import { executeCompanyCandidates } from "../../src/cli-company-candidates.js";
import { configuredCompanyDailyReport } from "../../src/company-internal-runtime.js";
import { CompanyDailyReportCycle } from "../../src/company-daily-report-cycle.js";
import type { CliCommandContext } from "../../src/cli-command-context.js";
import { initialized } from "../helpers.js";

vi.mock("../../src/company-internal-runtime.js", () => ({ configuredCompanyDailyReport: vi.fn() }));

describe("manual company daily report", () => {
  it("publishes an old date with the command clock and a fresh seven-day notification", async () => {
    const db = await initialized();
    const now = new Date("2026-10-20T13:00:00.000Z");
    const cutoff = "2026-10-01T09:00:00.000Z";
    const publisher = new CompanyDailyReportCycle(db, { enabled: true,
      scope: { provider: "provider:report", workspace: "workspace:report" }, activation_cutoff: cutoff,
      source: { readPage: request => ({ schema_version: 1, epoch: "1", pinned_cutoff: request.cutoff_to,
        from_global_sequence: 0, to_global_sequence: 0, rows: [], next_cursor: null }) } });
    vi.mocked(configuredCompanyDailyReport).mockReturnValue(publisher);
    const context: CliCommandContext = { args: [], values: { db: db.filename, "company-config": "/fixture/config", date: "2026-10-01" },
      positionals: ["company-candidates", "daily-report"], command: "company-candidates", subcommand: "daily-report",
      argument: undefined, fourth: undefined, fifth: undefined, sixth: undefined, db, dependencies: { clock: () => now } };
    try {
      await expect(executeCompanyCandidates(context)).resolves.toMatchObject({ report: { status: "published", created: true } });
      expect(db.db.prepare("SELECT report_date,cutoff_to,published_at FROM company_daily_reports").get()).toEqual({
        report_date: "2026-10-01", cutoff_to: cutoff, published_at: now.toISOString(),
      });
      expect(db.db.prepare("SELECT state,created_at,updated_at,expires_at FROM notification_intents").get()).toEqual({
        state: "queued", created_at: now.toISOString(), updated_at: now.toISOString(), expires_at: "2026-10-27T13:00:00.000Z",
      });
      await expect(executeCompanyCandidates(context)).resolves.toMatchObject({ report: { created: false } });
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM notification_intents").get()).toEqual({ n: 1 });
    } finally { db.close(); vi.mocked(configuredCompanyDailyReport).mockReset(); }
  });
});
