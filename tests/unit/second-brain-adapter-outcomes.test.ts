import { describe, expect, it } from "vitest";
import {
  createSecondBrainReadAdapter,
  type SecondBrainAdapterBudgets,
} from "../../src/second-brain-adapter.js";
import { SecondBrainTransportError } from "../../src/second-brain-transport.js";
import { NOW, QueuedTransport, page } from "../fixtures/second-brain-adapter-fixtures.js";

const budgets: SecondBrainAdapterBudgets = {
  max_hits: 2,
  max_excerpt_bytes: 80,
  max_total_bytes: 4_096,
  max_page_bytes: 512,
};
const adapter = (transport: QueuedTransport, selected = budgets, now = NOW) => createSecondBrainReadAdapter({
  transport,
  budgets: selected,
  clock: () => now,
  max_age_ms: 86_400_000,
  expiry_ms: 172_800_000,
});

describe("Second Brain adapter outcomes", () => {
  it("keeps no_data distinct from current evidence and unavailable transport", async () => {
    const noData = await adapter(new QueuedTransport([{ kind: "no_data", reason: "empty_result" }])).search("none");
    const timeout = new SecondBrainTransportError("SECOND_BRAIN_READ_TIMEOUT", "unavailable", { generation: 1 });
    const unavailable = await adapter(new QueuedTransport([timeout])).search("none");
    expect(noData).toEqual({ kind: "no_data", checked_at: NOW.toISOString(), fresh_until: "2026-08-28T12:01:00.000Z" });
    expect(unavailable).toEqual({ kind: "unavailable", code: "SECOND_BRAIN_READ_TIMEOUT", checked_at: NOW.toISOString() });
  });

  it("maps offline discovery and child crashes separately from malformed provider data", async () => {
    for (const code of ["SECOND_BRAIN_DISCOVERY_FAILED", "SECOND_BRAIN_CHILD_EXIT"] as const) {
      const error = new SecondBrainTransportError(code, "unavailable", { generation: 1 });
      const result = await adapter(new QueuedTransport([error])).search("fact");
      expect(result).toEqual({ kind: "offline", code, checked_at: NOW.toISOString() });
    }
    const malformed = await adapter(new QueuedTransport([{ kind: "data", value: { unknown: [] } }])).search("fact");
    expect(malformed).toEqual({ kind: "invalid", code: "SECOND_BRAIN_SEARCH_MALFORMED", checked_at: NOW.toISOString() });
  });

  it("uses configured search limits, reads ranked pages, and returns deterministic page order", async () => {
    const transport = new QueuedTransport([
      { kind: "data", value: { results: [
        { page_id: "wiki/project", section: "Fact", snippet: "project", score: 99 },
        { page_id: "wiki/principle", section: "Rule", snippet: "principle", score: -1 },
      ] } },
      page("Project shipped.[^bbbbbbbb]\n[^bbbbbbbb]: project:task-10\n", { id: "wiki/project" }),
      page(),
    ]);
    const result = await adapter(transport).search("what matters");
    expect(result).toMatchObject({ kind: "current", evidence: [
      { page_id: "wiki/principle", sid: "a1b2c3d4", trust: "untrusted" },
      { page_id: "wiki/project", sid: "bbbbbbbb", trust: "untrusted" },
    ] });
    expect(transport.calls[0]).toEqual({ method: "sb_search", arguments_: { query: "what matters", limit: 2 } });
  });

  it("rejects result, aggregate, and page budgets before returning content", async () => {
    const tooMany = await adapter(new QueuedTransport([{ kind: "data", value: { results: [
      { page_id: "a", section: "", snippet: "", score: 1 },
      { page_id: "b", section: "", snippet: "", score: 2 },
      { page_id: "c", section: "", snippet: "", score: 3 },
    ] } }])).search("x");
    expect(tooMany).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_RESULTS_OVERSIZE" });

    const aggregate = await adapter(new QueuedTransport([page(
      "1234567890[^aaaaaaaa]\n1234567890[^bbbbbbbb]\n[^aaaaaaaa]: source:a\n[^bbbbbbbb]: source:b\n",
    )]), { ...budgets, max_excerpt_bytes: 30, max_total_bytes: 40 }).readPage("wiki/principle");
    expect(aggregate).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_AGGREGATE_OVERSIZE" });

    const oversizedPage = await adapter(new QueuedTransport([page("x".repeat(513))])).readPage("wiki/principle");
    expect(oversizedPage).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_PAGE_OVERSIZE" });
  });

  it("returns stale cited evidence separately at the freshness deadline", async () => {
    const staleNow = new Date("2026-08-29T00:00:00.001Z");
    const result = await adapter(new QueuedTransport([page()]), budgets, staleNow).readPage("wiki/principle");
    expect(result).toMatchObject({ kind: "stale", code: "SECOND_BRAIN_EVIDENCE_STALE", evidence: [{ freshness: { state: "stale" } }] });
  });

  it("deduplicates exact replay and separates changed duplicate identity as a conflict", async () => {
    const exact = "same.[^aaaaaaaa]\nsame.[^aaaaaaaa]\n[^aaaaaaaa]: source:a\n";
    const replay = await adapter(new QueuedTransport([page(exact)])).readPage("wiki/principle");
    expect(replay).toMatchObject({ kind: "current" });
    if (replay.kind === "current") expect(replay.evidence).toHaveLength(1);

    const changed = "first.[^aaaaaaaa]\nsecond.[^aaaaaaaa]\n[^aaaaaaaa]: source:a\n";
    const conflict = await adapter(new QueuedTransport([page(changed)])).readPage("wiki/principle");
    expect(conflict).toMatchObject({ kind: "conflicts", conflicts: [{ conflict_id: "duplicate:wiki/principle:aaaaaaaa" }] });
  });

  it("keeps provider conflicts unresolved with both cited identities and digests", async () => {
    const transport = new QueuedTransport([
      { kind: "data", value: { conflicts: [{ conflict_id: "2026-08-28-project", page_id: "wiki/project", summary: "unresolved" }] } },
      page(
        "Use A.[^aaaaaaaa]\nUse B.[^bbbbbbbb]\n[^aaaaaaaa]: source:a\n[^bbbbbbbb]: source:b\n",
        { id: "conflicts/2026-08-28-project", status: "conflict" },
      ),
    ]);
    const result = await adapter(transport).openConflicts();
    expect(result).toMatchObject({ kind: "conflicts", conflicts: [{
      conflict_id: "2026-08-28-project",
      page_id: "wiki/project",
      state: "unresolved",
      left: { sid: "aaaaaaaa", content_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
      right: { sid: "bbbbbbbb", content_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    }] });
    expect(transport.calls[1]).toEqual({ method: "sb_read_page", arguments_: { id: "conflicts/2026-08-28-project" } });
  });

  it("maps bounded recent changes through cited page reads", async () => {
    const transport = new QueuedTransport([
      { kind: "data", value: { changes: [{ page_id: "wiki/principle", change: "modified", date: "2026-08-28" }] } },
      page(),
    ]);
    const result = await adapter(transport).recentChanges(7);
    expect(result).toMatchObject({ kind: "current", evidence: [{ page_id: "wiki/principle", valid_at: "2026-08-28T00:00:00.000Z" }] });
    expect(transport.calls[0]).toEqual({ method: "sb_recent_changes", arguments_: { days: 7 } });
  });
});
