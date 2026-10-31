import { describe, expect, it } from "vitest";
import {
  classifyGajaewayFact, collectGajaewayCurrent, gajaewayCollectorSideEffects, GajaewayCurrentError,
} from "../../src/gajaeway-current.js";
import type { TimetableItem } from "../../src/herdr-today.js";

const CHECKED = "2026-11-01T00:00:00.000Z";
const PID = 3875239;
const SYSTEMCTL = `MainPID=${PID}`;
const timetable = [
  { id: "go10-crm-viewer", bot: "가재", start: "1793461234.666149", status: "진행 중", content: "do-not-copy", request: "do-not-copy" },
] as unknown as readonly TimetableItem[];

function session(extra: Record<string, unknown> = {}) {
  return {
    sessionId: "session-one",
    origin: "slack/thread/one",
    lastActivityAt: "2026-11-01T00:00:00.000Z",
    status: "accepted",
    body: "do-not-copy",
    token: "do-not-copy",
    head: "do-not-copy",
    content: "secret prose",
    ...extra,
  };
}

function read(result: Record<string, unknown> | unknown[], systemctl: unknown = SYSTEMCTL) {
  return { command: "sessions current", result, systemctl, timetable };
}

describe("gajaeway sessions current", () => {
  it("returns no fact when no session is active", () => {
    expect(collectGajaewayCurrent(read({ status: { pid: PID }, current: null }))).toEqual([]);
  });

  it("does not pick when two or more sessions are active", () => {
    expect(collectGajaewayCurrent(read({
      status: { pid: PID }, current: null, reason: "ambiguous",
      sessions: [session(), session({ sessionId: "session-two", origin: "other" })],
    }))).toEqual([]);
    expect(collectGajaewayCurrent(read([session(), session({ origin: "other" })]))).toEqual([]);
  });

  it("keeps body fields out of the fact", () => {
    const [fact] = collectGajaewayCurrent(read({ status: { pid: PID }, current: session() }));
    expect(fact).toMatchObject({
      source_id: "src:pos:v1:gajaeway:local", source_kind: "live_adapter",
      sessionId: "session-one", origin: "slack/thread/one", status: "accepted",
      timetable_id: "go10-crm-viewer", start: "1793461234.666149", trust: "verified",
    });
    const encoded = JSON.stringify(fact);
    expect(encoded).not.toContain("do-not-copy");
    expect(encoded).not.toContain("secret prose");
    expect(encoded).not.toContain("body");
    expect(encoded).not.toContain("token");
    expect(encoded).not.toContain("head");
    expect(encoded).not.toContain("content");
    expect(encoded).not.toContain("request");
    expect(classifyGajaewayFact(fact!, CHECKED)).toBe(1);
  });

  it("rejects the Orca source", () => {
    expect(() => collectGajaewayCurrent({
      ...read({ status: { pid: PID }, current: session() }),
      sourceId: "src:pos:v1:orca:local",
    })).toThrow(GajaewayCurrentError);
  });

  it("returns no fact when the status pid is missing", () => {
    expect(collectGajaewayCurrent(read({ current: session() }))).toEqual([]);
    expect(collectGajaewayCurrent(read({ status: {}, current: session() }))).toEqual([]);
  });

  it("returns no fact when the status pid does not match the gateway MainPID", () => {
    expect(collectGajaewayCurrent(read(
      { status: { pid: PID }, current: session() },
      "MainPID=111",
    ))).toEqual([]);
    expect(collectGajaewayCurrent({
      command: "sessions current",
      gatewayPid: PID,
      result: { current: session() },
      systemctl: SYSTEMCTL,
      timetable,
    })).toEqual([]);
  });

  it("does not start or change a session", () => {
    expect(() => collectGajaewayCurrent({
      command: "work start", result: { status: { pid: PID }, current: session() }, systemctl: SYSTEMCTL,
    })).toThrow(GajaewayCurrentError);
    expect(gajaewayCollectorSideEffects()).toEqual([]);
  });
});
