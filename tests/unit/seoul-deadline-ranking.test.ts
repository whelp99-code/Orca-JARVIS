import { describe, expect, it } from "vitest";
import { rankPriorityActions } from "../../src/priority-engine.js";
import { generateMorningBrief, parseMorningBriefInput, DEFAULT_MORNING_BRIEF_LIMITS } from "../../src/morning-brief.js";
import { seoulBriefInput, seoulPriorityInput } from "../fixtures/seoul-priority-input.js";

const cases = [
  ["morning", "2026-09-07T22:15:00.000Z", "2026-09-08T08:00:00.000Z", "today"],
  ["next local day", "2026-09-08T14:59:59.999Z", "2026-09-08T15:00:00.000Z", "within_seven_days"],
  ["local midnight", "2026-09-08T15:00:00.000Z", "2026-09-09T08:00:00.000Z", "today"],
  ["UTC midnight", "2026-09-08T23:59:59.999Z", "2026-09-09T00:00:00.000Z", "today"],
  ["exact due", "2026-09-08T15:00:00.000Z", "2026-09-08T15:00:00.000Z", "today"],
  ["overdue", "2026-09-08T15:00:00.000Z", "2026-09-08T14:59:59.999Z", "overdue"],
  ["seven days", "2026-09-08T12:00:00.000Z", "2026-09-15T12:00:00.000Z", "within_seven_days"],
  ["after seven days", "2026-09-08T12:00:00.000Z", "2026-09-15T12:00:00.001Z", "later"],
  ["month boundary", "2026-09-30T22:15:00.000Z", "2026-10-01T08:00:00.000Z", "today"],
  ["year boundary", "2026-12-31T22:15:00.000Z", "2027-01-01T08:00:00.000Z", "today"],
  ["leap day", "2028-02-28T22:15:00.000Z", "2028-02-29T08:00:00.000Z", "today"],
] as const;

describe("Seoul deadline ranking and morning consumption", () => {
  it.each(cases)("classifies %s and preserves its classification through the brief", (_name, clock, due, expected) => {
    const { policy, input } = seoulPriorityInput(clock, due);
    const result = rankPriorityActions(policy, input);
    expect(result.status).toBe("ranked");
    const action = result.actions[0];
    expect(action?.rationale.lexicographic_fields.deadline_bucket).toBe(expected);
    if (action === undefined) throw new Error("ranked action required");
    const fields = action.rationale.lexicographic_fields;
    const raw = seoulBriefInput(clock, due, { ...fields, stable_identity: fields.stable_identity ?? "seoul-deadline" });
    const brief = generateMorningBrief(parseMorningBriefInput(raw));
    expect(brief.needs_you_first).toHaveLength(expected === "today" || expected === "overdue" ? 1 : 0);
    expect(result.authority).toBe("none");
    expect(result.effect).toBe("none");
  });

  it("retains the none bucket when there is no deadline", () => {
    const { policy, input } = seoulPriorityInput("2026-09-08T12:00:00.000Z", null);
    expect(rankPriorityActions(policy, input).actions[0]?.rationale.lexicographic_fields.deadline_bucket).toBe("none");
  });

  it.each([
    ["2026-09-07T22:15:00.000Z", "2026-09-08T08:00:00.000Z", true],
    ["2026-09-08T14:59:59.999Z", "2026-09-08T15:00:00.000Z", false],
    ["2026-12-31T14:59:59.999Z", "2026-12-31T15:00:00.000Z", false],
  ] as const)("independently validates the supplied today bucket at %s", (clock, due, sameDay) => {
    const raw = seoulBriefInput(clock, due);
    if (sameDay) expect(() => parseMorningBriefInput(raw)).not.toThrow();
    else expect(() => parseMorningBriefInput(raw)).toThrow("MORNING_BRIEF_INPUT_INVALID");
    // Invoke the generator separately so a parser-only fix cannot mask its UTC comparison.
    const generated = generateMorningBrief({ ...raw, schema_version: 1, context_readiness: "ready",
      external_intelligence: { enabled: false, state: "off" }, limits: DEFAULT_MORNING_BRIEF_LIMITS });
    expect(generated.needs_you_first).toHaveLength(sameDay ? 1 : 0);
    expect(generated.omissions).toEqual(sameDay ? [] : [{ reason: "insufficient_citation", count: 1 }]);
  });

  it.each([
    ["0000-01-02T22:15:00.000Z", "0000-01-03T08:00:00.000Z"],
    ["0099-12-31T22:15:00.000Z", "0100-01-01T08:00:00.000Z"],
    ["9999-12-31T15:00:00.000Z", "9999-12-31T23:00:00.000Z"],
  ])("compares supported UTC inputs at the %s year boundary without re-parsing local dates", (clock, due) => {
    const brief = generateMorningBrief(parseMorningBriefInput(seoulBriefInput(clock, due)));
    expect(brief.needs_you_first).toHaveLength(1);
    expect(brief.generated_at).toBe(clock);
    expect(brief.needs_you_first[0]?.deadline).toBe(due);
  });
});
