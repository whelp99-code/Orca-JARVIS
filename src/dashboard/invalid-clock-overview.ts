import type { SecondBrainReadinessReportV1 } from "../second-brain-readiness.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";

export function invalidClockOverview(secondBrain: SecondBrainReadinessReportV1) {
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    generated_at: null,
    cards: [],
    recent_tasks: [],
    pending_approvals: [],
    risks: [],
    agents: [],
    portfolio: { hosts: [], summary: null },
    second_brain: secondBrain,
  };
}
