import { priorityCandidateFixture } from "./priority-engine-candidates.js";
import { PRIORITY_NOW, priorityEngineInput, priorityPolicyConfig } from "./priority-engine-input.js";
import { morningInput, morningRecord } from "./morning-brief-record.js";
import type { MorningBriefPriority } from "../../src/morning-brief-types.js";

export function seoulPriorityInput(clock: string, due: string | null) {
  const delta = Date.parse(clock) - Date.parse(PRIORITY_NOW);
  const retime = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item)) {
      return new Date(Date.parse(item) + delta).toISOString();
    }
    return item;
  }));
  const candidate = priorityCandidateFixture("seoul-deadline", "live:customer");
  candidate["deadline"] = due === null ? null : {
    due_at: new Date(Date.parse(due) - delta).toISOString(), evidence_ref: "live:customer",
    observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T12:30:00.000Z",
  };
  return { policy: retime(priorityPolicyConfig()), input: retime(priorityEngineInput({ candidates: [candidate] })) };
}

export function seoulBriefInput(clock: string, due: string, priority?: MorningBriefPriority) {
  const record = morningRecord();
  const observed = new Date(Date.parse(clock) - 60_000).toISOString();
  const until = new Date(Date.parse(clock) + 3_600_000).toISOString();
  return { ...morningInput([morningRecord({ owner_decision_required: false, deadline: due,
    observed_at: observed, valid_from: observed, valid_until: until, fresh_until: until,
    priority: priority ?? { ...record.priority, owner_safety_gate: "pass", deadline_bucket: "today" },
  })]), generated_at: clock };
}
