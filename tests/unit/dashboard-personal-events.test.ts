import { describe, expect, it } from "vitest";
import { ReconcileHub, topicsForPersonalEvent } from "../../src/dashboard/events.js";
import { PERSONAL_TOPICS } from "../../src/dashboard/personal-contracts.js";

function eventId(frame: string): string {
  const line = frame.split("\n").find((value) => value.startsWith("id: "));
  if (line === undefined) throw new Error("event id expected");
  return line.slice(4);
}

describe("personal dashboard invalidation events", () => {
  it("maps each producer event to only its affected resource topics", () => {
    // Given / When / Then
    expect(topicsForPersonalEvent("recommendation")).toEqual([PERSONAL_TOPICS.recommendations, PERSONAL_TOPICS.today]);
    expect(topicsForPersonalEvent("decision")).toEqual([PERSONAL_TOPICS.decisions, PERSONAL_TOPICS.today]);
    expect(topicsForPersonalEvent("daily_run")).toEqual([PERSONAL_TOPICS.dailyRuns, PERSONAL_TOPICS.today]);
    expect(topicsForPersonalEvent("notification")).toEqual([PERSONAL_TOPICS.notifications, PERSONAL_TOPICS.today]);
    expect(topicsForPersonalEvent("capability")).toEqual([PERSONAL_TOPICS.health, PERSONAL_TOPICS.today]);
    expect(topicsForPersonalEvent("context")).toEqual([PERSONAL_TOPICS.evidence, PERSONAL_TOPICS.health, PERSONAL_TOPICS.today]);
  });

  it("replays events after Last-Event-ID once and resets malformed or stale identities", () => {
    // Given
    const hub = new ReconcileHub();
    const first: string[] = [];
    const stop = hub.connect({ write: (frame) => first.push(frame), close: () => undefined });
    hub.publishPersonal("recommendation");
    const firstEvent = first.at(-1);
    if (firstEvent === undefined) throw new Error("first reconcile expected");
    hub.publishPersonal("decision");
    stop();
    const replay: string[] = [];
    // When
    hub.connect({ write: (frame) => replay.push(frame), close: () => undefined }, eventId(firstEvent));
    const reset: string[] = [];
    hub.connect({ write: (frame) => reset.push(frame), close: () => undefined }, "malformed");
    // Then
    expect(replay).toHaveLength(1);
    expect(replay[0]).toContain(PERSONAL_TOPICS.decisions);
    expect(reset).toHaveLength(1);
    expect(reset[0]).toContain("event: snapshot");
    expect(reset[0]).not.toContain("credential");
    hub.close();
  });
});
