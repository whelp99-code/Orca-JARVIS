import { DashboardApiError } from "./api.js";
import type { HealthItem } from "./personal-types.js";

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_TEXT = 4096;

export function parseHealthItem(value: unknown): HealthItem {
  const row = record(value);
  const kind = row["kind"];
  if (kind === "source") {
    exact(value, ["kind", "source_id", "state", "observed_at", "fresh_until", "checked_at"]);
    time(row["observed_at"]); time(row["fresh_until"]);
    return { kind, identity: text(row["source_id"]), state: text(row["state"]), checked_at: time(row["checked_at"]) };
  }
  if (kind === "capability") {
    if ("stages" in row) {
      exact(value, ["kind", "capability_id", "state", "stages", "checked_at"]);
      parseStages(row["stages"]);
    } else {
      exact(value, ["kind", "capability_id", "state", "reason", "checked_at"]);
      text(row["reason"]);
    }
    return { kind, identity: text(row["capability_id"]), state: text(row["state"]), checked_at: time(row["checked_at"]) };
  }
  return fail();
}

function parseStages(value: unknown): void {
  const stages = exact(value, ["installed", "configured", "protocol_compatible", "operational", "authorized"]);
  for (const stage of Object.values(stages)) {
    const result = exact(stage, ["ok", "evidence"]);
    if (typeof result["ok"] !== "boolean") fail();
    text(result["evidence"]);
  }
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = record(value);
  const actual = Object.keys(row);
  if (actual.length !== keys.length || !actual.every((key) => keys.includes(key))) fail();
  return row;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TEXT || /[\uD800-\uDFFF]/u.test(value)) return fail();
  return value;
}
function time(value: unknown): string {
  const parsed = text(value);
  if (!TIME.test(parsed) || !Number.isFinite(Date.parse(parsed))) return fail();
  return parsed;
}
function fail(): never {
  throw new DashboardApiError({ kind: "server", code: "VALIDATION_ERROR", message: "Validation error", request_id: "" });
}
