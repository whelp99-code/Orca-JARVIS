import { describe, expect, it } from "vitest";
import { canonicalDailyLoopKey, classifyDailyLoopInstant, evaluateRefreshContext, type RefreshCompletion } from "../../src/daily-loop.js";

const instant = (value: string): Date => new Date(value);

describe("Daily Control Loop calendar", () => {
  it("classifies morning, evening, quiet deferral, and critical bypass from injected KST instants", () => {
    // Given
    const morning = instant("2026-08-30T22:15:00.000Z");
    const evening = instant("2026-08-31T12:30:00.000Z");
    const quiet = instant("2026-08-31T14:00:00.000Z");

    // When
    const scheduledMorning = classifyDailyLoopInstant(morning, {
      kind: "scheduled",
    });
    const scheduledEvening = classifyDailyLoopInstant(evening, {
      kind: "scheduled",
    });
    const deferred = classifyDailyLoopInstant(quiet, {
      kind: "event",
      event_id: "evt:quiet",
      occurred_at: "2026-08-31T14:00:00.000Z",
      critical: false,
      items: 1,
      work: 1,
      bytes: 8,
    });
    const bypassed = classifyDailyLoopInstant(quiet, {
      kind: "event",
      event_id: "evt:critical",
      occurred_at: "2026-08-31T14:00:00.000Z",
      critical: true,
      critical_reason: "operator escalation",
      items: 1,
      work: 1,
      bytes: 8,
    });

    // Then
    expect(scheduledMorning).toEqual({
      kind: "due",
      local_date: "2026-08-31",
      phase: "morning",
      scheduled_at: "2026-08-30T22:15:00.000Z",
    });
    expect(scheduledEvening).toEqual({
      kind: "due",
      local_date: "2026-08-31",
      phase: "evening",
      scheduled_at: "2026-08-31T12:30:00.000Z",
    });
    expect(deferred).toEqual({
      kind: "deferred",
      next_allowed_at: "2026-08-31T22:00:00.000Z",
      deferred_key: "daily:2026-09-01:in_day:event:v2:62685b1cc9f46bc2dc572dc4cebd10a535d23add61fa4227165cacabffb1e47d",
    });
    expect(bypassed).toMatchObject({
      kind: "due",
      phase: "in_day",
      bypass_reason: "critical_quiet_hours_bypass",
    });
  });

  it("uses bounded canonical identities across repeated instants and date rollover", () => {
    // Given
    const eventId = "evt:" + "x".repeat(300);

    // When
    const first = canonicalDailyLoopKey("2026-08-31", "in_day", eventId);
    const repeat = canonicalDailyLoopKey("2026-08-31", "in_day", eventId);
    const rollover = canonicalDailyLoopKey("2026-09-01", "in_day", eventId);

    // Then
    expect(first).toBe(repeat);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(rollover).not.toBe(first);
  });
});

describe("Second Brain refresh boundary", () => {
  const at = instant("2026-08-30T22:15:00.000Z");
  const base = {
    schema_version: 1,
    refresh_id: "refresh:1",
    completed_at: "2026-08-30T22:00:00.000Z",
  } as const;
  const cases: readonly [RefreshCompletion | null, readonly [string, string]][] = [
    [{ ...base, state: "completed", protocol_version: 1, capped: false }, ["ready", "refresh_fresh"]],
    [{ ...base, state: "failed", protocol_version: 1, capped: false }, ["degraded", "refresh_failed"]],
    [null, ["no_data", "refresh_missing"]],
    [
      {
        ...base,
        state: "completed",
        completed_at: "2026-08-29T20:00:00.000Z",
        protocol_version: 1,
        capped: false,
      },
      ["degraded", "refresh_stale"],
    ],
    [{ ...base, state: "completed", protocol_version: 2, capped: false }, ["degraded", "refresh_incompatible"]],
    [{ ...base, state: "completed", protocol_version: 1, capped: true }, ["degraded", "refresh_capped"]],
  ];

  it.each(cases)("returns exact readiness and reason for refresh state %#", (refresh, expected) => {
    // Given / When
    const result = evaluateRefreshContext(refresh, at, 30 * 60_000);

    // Then
    expect([result.state, result.reason]).toEqual(expected);
  });
});
