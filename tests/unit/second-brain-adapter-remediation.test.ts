import { describe, expect, it } from "vitest";
import {
  createSecondBrainReadAdapter,
  SecondBrainTransportError,
  type SecondBrainAdapterBudgets,
  type SecondBrainReadOutcome,
} from "../../src/index.js";
import { NOW, QueuedTransport, page } from "../fixtures/second-brain-adapter-fixtures.js";

const budgets: SecondBrainAdapterBudgets = {
  max_hits: 2,
  max_excerpt_bytes: 60,
  max_total_bytes: 60,
  max_page_bytes: 1_024,
};

function adapter(
  outcomes: ConstructorParameters<typeof QueuedTransport>[0],
  selected = budgets,
  now = NOW,
) {
  return createSecondBrainReadAdapter({
    transport: new QueuedTransport(outcomes),
    budgets: selected,
    clock: () => now,
    max_age_ms: 86_400_000,
    expiry_ms: 172_800_000,
  });
}

function conflictPage(id: string, sides: readonly string[]): ReturnType<typeof page> {
  const facts = sides.map(sid => `1234567890[^${sid}]`).join("\n");
  const definitions = sides.map(sid => `[^${sid}]: source:${sid}`).join("\n");
  return page(`${facts}\n${definitions}\n`, { id: `conflicts/${id}`, status: "conflict" });
}

function expectAtomicInvalid(result: SecondBrainReadOutcome, code: string): void {
  expect(result).toEqual({ kind: "invalid", code, checked_at: NOW.toISOString() });
  expect("evidence" in result).toBe(false);
  expect("conflicts" in result).toBe(false);
}

describe("Second Brain complete read boundaries", () => {
  it("rejects one conflict request when cited sides exceed the shared UTF-8 total", async () => {
    const listed = { kind: "data", value: { conflicts: [
      { conflict_id: "first", page_id: "wiki/first", summary: "one" },
      { conflict_id: "second", page_id: "wiki/second", summary: "two" },
    ] } } as const;

    const transport = new QueuedTransport([
      listed,
      conflictPage("first", ["aaaaaaaa", "bbbbbbbb"]),
      conflictPage("second", ["cccccccc", "dddddddd"]),
    ]);
    const reader = createSecondBrainReadAdapter({
      transport,
      budgets: { ...budgets, max_total_bytes: 1_600 },
      clock: () => NOW,
      max_age_ms: 86_400_000,
      expiry_ms: 172_800_000,
    });

    const result = await reader.openConflicts();

    expect(transport.calls.map(call => call.method)).toEqual([
      "sb_open_conflicts",
      "sb_read_page",
      "sb_read_page",
    ]);
    expectAtomicInvalid(result, "SECOND_BRAIN_AGGREGATE_OVERSIZE");
  });

  it("rejects an ignored 600000-byte search section before reading a page", async () => {
    const result = await adapter([{ kind: "data", value: { results: [{
      page_id: "wiki/principle",
      section: "한".repeat(200_000),
      snippet: "small",
      score: 1,
    }] } }, page()]).search("fact");

    expectAtomicInvalid(result, "SECOND_BRAIN_AGGREGATE_OVERSIZE");
  });

  it("rejects a third cited conflict side instead of truncating the frozen pair", async () => {
    const result = await adapter([
      { kind: "data", value: { conflicts: [{ conflict_id: "three", page_id: "wiki/three", summary: "open" }] } },
      conflictPage("three", ["aaaaaaaa", "bbbbbbbb", "cccccccc"]),
    ], { ...budgets, max_total_bytes: 2_048 }).openConflicts();

    expectAtomicInvalid(result, "SECOND_BRAIN_CONFLICT_SHAPE_INVALID");
  });

  it("classifies checked_at equal to expires_at as hard expired", async () => {
    const expiresAt = new Date("2026-08-30T00:00:00.000Z");
    const result = await adapter([page()], { ...budgets, max_total_bytes: 2_048 }, expiresAt)
      .readPage("wiki/principle");

    expect(result).toEqual({
      kind: "invalid",
      code: "SECOND_BRAIN_EVIDENCE_EXPIRED",
      checked_at: expiresAt.toISOString(),
    });
  });

  it("accepts exactly two distinct conflict sides", async () => {
    const result = await adapter([
      { kind: "data", value: { conflicts: [{ conflict_id: "pair", page_id: "wiki/pair", summary: "open" }] } },
      conflictPage("pair", ["aaaaaaaa", "bbbbbbbb"]),
    ], { ...budgets, max_total_bytes: 2_048 }).openConflicts();

    expect(result).toMatchObject({
      kind: "conflicts",
      conflicts: [{ left: { sid: "aaaaaaaa" }, right: { sid: "bbbbbbbb" } }],
    });
  });

  it.each([
    ["zero", []],
    ["one", ["aaaaaaaa"]],
  ] as const)("rejects a %s-sided provider conflict", async (_name, sides) => {
    const result = await adapter([
      { kind: "data", value: { conflicts: [{ conflict_id: "shape", page_id: "wiki/shape", summary: "open" }] } },
      conflictPage("shape", sides),
    ], { ...budgets, max_total_bytes: 2_048 }).openConflicts();

    expectAtomicInvalid(result, "SECOND_BRAIN_CONFLICT_SHAPE_INVALID");
  });

  it("uses hard expiry before stale classification one millisecond around the boundary", async () => {
    const before = new Date("2026-08-29T23:59:59.999Z");
    const after = new Date("2026-08-30T00:00:00.001Z");

    const stale = await adapter([page()], { ...budgets, max_total_bytes: 2_048 }, before)
      .readPage("wiki/principle");
    const expired = await adapter([page()], { ...budgets, max_total_bytes: 2_048 }, after)
      .readPage("wiki/principle");

    expect(stale).toMatchObject({ kind: "stale", code: "SECOND_BRAIN_EVIDENCE_STALE" });
    expect(expired).toEqual({
      kind: "invalid",
      code: "SECOND_BRAIN_EVIDENCE_EXPIRED",
      checked_at: after.toISOString(),
    });
  });

  it("accepts the shared CJK provider-byte limit and rejects one byte over", async () => {
    const offline = () => new SecondBrainTransportError(
      "SECOND_BRAIN_DISCOVERY_FAILED",
      "unavailable",
      { generation: 1 },
    );
    const search = (section: string) => ({ kind: "data", value: { results: [{
      page_id: "p",
      section,
      snippet: "",
      score: 1,
    }] } } as const);
    const selected = { ...budgets, max_excerpt_bytes: 14, max_total_bytes: 14 };

    const exact = await adapter([search("한".repeat(4)), offline()], selected).search("x");
    const over = await adapter([search(`${"한".repeat(4)}a`), offline()], selected).search("x");

    expect(exact).toMatchObject({ kind: "offline", code: "SECOND_BRAIN_DISCOVERY_FAILED" });
    expectAtomicInvalid(over, "SECOND_BRAIN_AGGREGATE_OVERSIZE");
  });

  it("caps the complete page payload at exact and one-over UTF-8 bytes", async () => {
    const exactPage = page("한한[^a1b2c3d4]\n[^a1b2c3d4]: s\n");
    const overPage = page("한한a[^a1b2c3d4]\n[^a1b2c3d4]: s\n");
    if (exactPage.kind !== "data") throw new TypeError("data fixture required");
    const pageBytes = Buffer.byteLength(JSON.stringify(exactPage.value), "utf8");
    const selected = { ...budgets, max_total_bytes: 2_048, max_page_bytes: pageBytes };

    const exact = await adapter([exactPage], selected).readPage("wiki/principle");
    const over = await adapter([overPage], selected).readPage("wiki/principle");

    expect(exact.kind).toBe("current");
    expectAtomicInvalid(over, "SECOND_BRAIN_PAGE_OVERSIZE");
  });

  it("rejects huge ignored page metadata before using a small body", async () => {
    const result = await adapter([
      page("ok.[^a1b2c3d4]\n[^a1b2c3d4]: s\n", { ignored: "한".repeat(200_000) }),
    ], { ...budgets, max_total_bytes: 65_536, max_page_bytes: 1_024 }).readPage("wiki/principle");

    expectAtomicInvalid(result, "SECOND_BRAIN_PAGE_OVERSIZE");
  });
});
