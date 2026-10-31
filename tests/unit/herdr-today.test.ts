import { describe, expect, it } from "vitest";
import {
  assertHerdrSchema, collectHerdrToday, classifyHerdrFact, herdrCollectorSideEffects,
  herdrMethodAllowed, HerdrTodayError, selectTimetable, type HerdrSchema, type HerdrSnapshot,
} from "../../src/herdr-today.js";

const CHECKED = "2026-11-01T00:00:00.000Z";
const schema: HerdrSchema = {
  methods: ["session.snapshot", "schema"],
  agent_status: ["idle", "working", "blocked", "done", "unknown"],
};
const timetable = [
  { id: "go10-crm-viewer", bot: "가재", start: "1793461234.666149", status: "진행 중" },
  { id: "go11-pr76-deploy", bot: "가재", start: "1793461234.666149", status: "끝" },
  { id: "go8-today", bot: "도리", start: "1793461234.666149", status: "대기" },
];

function pane(agent: string | null, status: string, extra: Partial<HerdrSnapshot["session"]["snapshot"]["panes"][number]> = {}) {
  return {
    pane_id: extra.pane_id ?? `${agent ?? "empty"}:${status}`,
    tab_id: "tab",
    agent,
    agent_status: status,
    focused: extra.focused ?? false,
    revision: extra.revision ?? 1,
  };
}

function snapshot(panes: ReturnType<typeof pane>[]): HerdrSnapshot {
  return { protocol: 22, schema_version: 1, session: { snapshot: { panes } } };
}

describe("herdr today", () => {
  it("accepts the snapshot method and only the five agent statuses", () => {
    expect(() => assertHerdrSchema(schema)).not.toThrow();
  });

  it("rejects a method outside the allowlist", () => {
    expect(() => herdrMethodAllowed("pane.read")).toThrow(HerdrTodayError);
  });

  it("classifies one gjc live fact through the existing classifier", () => {
    const [fact] = collectHerdrToday({
      snapshot: snapshot([pane("gjc", "working", { focused: true, revision: 4 })]),
      schema, timetable,
    });
    expect(fact).toMatchObject({
      source_id: "src:pos:v1:herdr:local", source_kind: "live_adapter",
      host_id: "host:pos:linux-control-plane", kind: "live_task", trust: "verified",
    });
    expect(classifyHerdrFact(fact!, CHECKED)).toBe(1);
  });

  it("rejects the Orca source", () => {
    expect(() => collectHerdrToday({
      snapshot: snapshot([pane("gjc", "working")]), schema, timetable,
      methods: ["src:pos:v1:orca:local"],
    })).toThrow(HerdrTodayError);
  });

  it("does not classify an unverified fact", () => {
    const [fact] = collectHerdrToday({
      snapshot: snapshot([pane("gjc", "working", { focused: true })]), schema, timetable,
    });
    expect(classifyHerdrFact({ ...fact!, trust: "inferred" }, CHECKED)).toBe(0);
  });

  it("returns no fact when the snapshot is missing", () => {
    expect(collectHerdrToday({ snapshot: { session: { snapshot: { panes: [] } } }, schema, timetable })).toEqual([]);
  });

  it("keeps pane bodies, titles, selections, and timetable prose out of the fact", () => {
    const [fact] = collectHerdrToday({
      snapshot: snapshot([pane("gjc", "done", { focused: true })]), schema, timetable,
    });
    const encoded = JSON.stringify(fact);
    expect(encoded).not.toContain("content");
    expect(encoded).not.toContain("request");
    expect(encoded).not.toContain("title");
    expect(encoded).not.toContain("selection");
  });

  it("returns no fact when another bot pane is focused and working", () => {
    expect(collectHerdrToday({
      snapshot: snapshot([
        pane("pi", "working", { focused: true, revision: 9, pane_id: "w3:p2" }),
        pane("gjc", "idle", { revision: 2 }),
      ]),
      schema, timetable,
    })).toEqual([]);
  });

  it("opens neither port 6769 nor orca-desktop", () => {
    expect(herdrCollectorSideEffects()).toEqual([]);
  });

  it("drops a Dori row and a finished Gajae row", () => {
    expect(selectTimetable([
      { id: "go8-today", bot: "도리", start: "9", status: "진행 중" },
      { id: "go11-pr76-deploy", bot: "가재", start: "9", status: "끝" },
    ])).toBeNull();
  });

  it("names the single open Gajae timetable row and omits it without a pane", () => {
    const [fact] = collectHerdrToday({
      snapshot: snapshot([pane("gjc", "working", { focused: true })]), schema, timetable,
    });
    expect(fact).toMatchObject({ timetable_id: "go10-crm-viewer", start: "1793461234.666149" });
    expect(collectHerdrToday({ snapshot: snapshot([]), schema, timetable })).toEqual([]);
  });

  it("does not infer Gajae from cwd or a title fragment", () => {
    expect(collectHerdrToday({
      snapshot: snapshot([pane("other", "working", { focused: true, pane_id: "가재군" })]),
      schema, timetable,
    })).toEqual([]);
  });
});
