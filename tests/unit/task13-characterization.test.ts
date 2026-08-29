import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import {
  AuthorityDb,
  createSecondBrainReadAdapter,
  evaluateSecondBrainReadiness,
  OrcaReadonlyAdapter,
  SECOND_BRAIN_FROZEN_DIGEST,
  TaskTimeline,
} from "../../src/index.js";
import { signPortfolioEnvelope, verifyPortfolioAuthenticatedReport } from "../../src/dashboard/portfolio-auth.js";
import { portfolioFreshness } from "../../src/dashboard/portfolio-projection.js";
import { localReport } from "../fixtures/portfolio-report.js";
import { tempDb } from "../helpers.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");

describe("Task 13 source seam characterization", () => {
  it("preserves Orca readonly metadata without requiring preview prose", async () => {
    // Given: an injected Orca readonly response.
    const adapter = new OrcaReadonlyAdapter(async () => JSON.stringify({
      ok: true,
      result: { terminals: [{
        handle: "terminal-1", ptyId: "pty-1", incarnationId: "incarnation-1", worktreeId: "worktree-1",
        worktreePath: null, title: null, connected: true, writable: false, lastOutputAt: 1, preview: null,
      }] },
    }));
    // When: structured terminal metadata is read.
    const result = await adapter.list("active");
    // Then: identity/connectivity metadata remains machine-readable.
    expect(result).toMatchObject([{ handle: "terminal-1", incarnationId: "incarnation-1", connected: true }]);
  });

  it("preserves TaskTimeline reads and Task 11 typed no-data outcomes", async () => {
    // Given: an empty migrated authority and a typed no-data Second Brain transport.
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const memory = createSecondBrainReadAdapter({
      transport: { call: async () => ({ kind: "no_data", reason: "empty_result" }), restart: async () => {}, close: async () => {}, diagnostics: () => [] },
      budgets: { max_hits: 4, max_excerpt_bytes: 256, max_total_bytes: 4_096, max_page_bytes: 8_192 },
      clock: () => NOW, max_age_ms: 60_000, expiry_ms: 120_000,
    });
    // When: both existing readonly seams are read.
    const tasks = new TaskTimeline(db).list();
    const outcome = await memory.search("fixture");
    db.close();
    // Then: empty current data remains typed and distinct from source failure.
    expect(tasks).toEqual([]);
    expect(outcome).toMatchObject({ kind: "no_data", checked_at: NOW.toISOString() });
  });

  it("preserves authenticated portfolio projection and exact freshness boundaries", () => {
    // Given: an authenticated local projection and fixed key.
    const key = Buffer.alloc(32, 7);
    const envelope = signPortfolioEnvelope(localReport(), key);
    // When: the envelope and portfolio freshness are verified.
    const verified = verifyPortfolioAuthenticatedReport(Buffer.from(JSON.stringify(envelope)), key, "local");
    // Then: only authenticated projection fields and existing thresholds remain.
    expect(verified).toMatchObject({ kind: "report", report: { source: "local", host: { worktree_count: 4 } } });
    expect(portfolioFreshness(NOW.toISOString(), new Date(NOW.getTime() + 90_000))).toBe("live");
    expect(portfolioFreshness(NOW.toISOString(), new Date(NOW.getTime() + 300_000))).toBe("stale");
  });

  it("preserves Task 12 degradation and existing public values", () => {
    // Given: a read-only no-data readiness observation.
    const readiness = evaluateSecondBrainReadiness({
      executable: "available", configuration: "valid", contract_digest: SECOND_BRAIN_FROZEN_DIGEST,
      protocol_version: "2026-08-28", tools: ["sb_open_conflicts", "sb_read_page", "sb_recent_changes", "sb_remember", "sb_search"],
      schemas_compatible: true, status: "ok", doctor: "ok", handshake: "ok", status_operational: true,
      doctor_operational: true, read_authorization: "authorized", write_authorization: "disabled", data_state: "no_data",
      refresh: { kind: "missing" },
    }, NOW);
    // When: machine-consumed public values are inspected.
    const exports = ["OrcaReadonlyAdapter", "TaskTimeline", "createSecondBrainReadAdapter", "evaluateSecondBrainReadiness"];
    // Then: degradation stays unavailable and all existing exports remain additive.
    expect(exports.every(name => name in publicApi)).toBe(true);
    expect(readiness).toMatchObject({ readiness: "unavailable", stages: { data_state: { state: "no_data" } } });
  });

  it("has the canonical personal connector registry after Task 13", () => {
    // Given: the current public package.
    // When: the Task 13 registry seam is inspected.
    // Then: the canonical registry is exported.
    expect("createPersonalConnectorRegistry" in publicApi).toBe(true);
  });
});
