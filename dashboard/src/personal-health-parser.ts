import {
  booleanValue, closedDiscriminant, closedRecord, hasClosedDataField, member, text, timestamp, validationFailure,
} from "./personal-closed.js";
import type { HealthItem } from "./personal-types.js";

const SOURCE_STATES = ["fresh", "stale", "no_data", "unavailable", "offline"] as const;
const CAPABILITY_STATES = ["ready", "degraded", "offline"] as const;

export function parseHealthItem(value: unknown): HealthItem {
  const kind = closedDiscriminant(value, "kind");
  if (kind === "source") {
    const row = closedRecord(value, ["kind", "source_id", "state", "observed_at", "fresh_until", "checked_at"]);
    timestamp(row["observed_at"]); timestamp(row["fresh_until"]);
    return { kind, identity: text(row["source_id"]), state: member(row["state"], SOURCE_STATES),
      checked_at: timestamp(row["checked_at"]) };
  }
  if (kind === "capability") {
    const hasStages = hasClosedDataField(value, "stages");
    const row = closedRecord(value, hasStages
      ? ["kind", "capability_id", "state", "stages", "checked_at"]
      : ["kind", "capability_id", "state", "reason", "checked_at"]);
    if (hasStages) parseStages(row["stages"]); else text(row["reason"]);
    return { kind, identity: text(row["capability_id"]), state: member(row["state"], CAPABILITY_STATES),
      checked_at: timestamp(row["checked_at"]) };
  }
  return validationFailure();
}

function parseStages(value: unknown): void {
  const stages = closedRecord(value, ["installed", "configured", "protocol_compatible", "operational", "authorized"]);
  for (const stage of Object.values(stages)) {
    const result = closedRecord(stage, ["ok", "evidence"]);
    booleanValue(result["ok"]); text(result["evidence"]);
  }
}
