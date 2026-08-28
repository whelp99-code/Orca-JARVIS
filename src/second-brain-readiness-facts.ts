import { parseSecondBrainInstant } from "./second-brain-readiness-time.js";
import { parseSecondBrainStrictJson } from "./second-brain-strict-json.js";
import type { SecondBrainDataState } from "./second-brain-readiness.js";

const STATUS_PATTERN = /^(\S+) run \S+ (ok|capped|failed) pages=(\d+) conflicts=\d+ errors=\d+$/;
const FACT_KEYS = [
  "authorization",
  "contract_digest",
  "data_state",
  "input_schemas_compatible",
  "last_successful_refresh_at",
  "latest_refresh_attempt",
  "operational",
  "output_schemas_compatible",
  "protocol_version",
  "schema_version",
  "tools",
  "vault",
] as const;

export type SecondBrainAuthorizationFacts = {
  readonly read: "authorized" | "unauthorized";
  readonly write: "authorized" | "disabled" | "unauthorized";
};
export type SecondBrainAttemptFacts = {
  readonly kind: "success" | "capped" | "failed";
  readonly at: string;
};
export type SecondBrainPeerFacts = {
  readonly operational: "ready" | "unavailable";
  readonly vault: "ready" | "absent" | "locked" | "unavailable";
  readonly data_state: SecondBrainDataState;
  readonly authorization: SecondBrainAuthorizationFacts;
  readonly contract_digest: string | null;
  readonly protocol_version: string | null;
  readonly tools: readonly string[] | null;
  readonly input_schemas_compatible: boolean | null;
  readonly output_schemas_compatible: boolean | null;
  readonly latest_refresh_attempt: SecondBrainAttemptFacts | null;
  readonly last_successful_refresh_at: string | null;
};
export type SecondBrainLegacyStatus = {
  readonly data_state: SecondBrainDataState;
  readonly latest_refresh_attempt: SecondBrainAttemptFacts | null;
  readonly last_successful_refresh_at: string | null;
};
export function parseSecondBrainPeerFacts(text: string): SecondBrainPeerFacts | undefined {
  const value = parseSecondBrainStrictJson(text.trim());
  if (!record(value) || !exactKeys(value, FACT_KEYS) || value["schema_version"] !== 1) return undefined;
  const authorization = parseAuthorization(value["authorization"]);
  const latest = parseAttempt(value["latest_refresh_attempt"]);
  const success = parseOptionalInstant(value["last_successful_refresh_at"]);
  const tools = parseTools(value["tools"]);
  const dataState = value["data_state"];
  const vault = value["vault"];
  const operational = value["operational"];
  if (authorization === undefined || latest === undefined || success === undefined || tools === undefined
    || !dataStateValue(dataState) || !vaultValue(vault) || !operationalValue(operational)
    || !nullableString(value["contract_digest"]) || !nullableString(value["protocol_version"])
    || !nullableBoolean(value["input_schemas_compatible"])
    || !nullableBoolean(value["output_schemas_compatible"])) return undefined;
  return {
    operational,
    vault,
    data_state: dataState,
    authorization,
    contract_digest: value["contract_digest"],
    protocol_version: value["protocol_version"],
    tools,
    input_schemas_compatible: value["input_schemas_compatible"],
    output_schemas_compatible: value["output_schemas_compatible"],
    latest_refresh_attempt: latest,
    last_successful_refresh_at: success,
  };
}

export function parseSecondBrainLegacyStatus(text: string): SecondBrainLegacyStatus | undefined {
  const trimmed = text.trim();
  if (trimmed === "no runs") {
    return { data_state: "no_data", latest_refresh_attempt: null, last_successful_refresh_at: null };
  }
  const match = STATUS_PATTERN.exec(trimmed);
  if (match === null) return undefined;
  const instant = match[1] === undefined ? undefined : parseSecondBrainInstant(match[1]);
  const kind = match[2];
  const pages = Number(match[3]);
  if (instant === undefined || (kind !== "ok" && kind !== "capped" && kind !== "failed")
    || !Number.isSafeInteger(pages)) return undefined;
  const attempt: SecondBrainAttemptFacts = { kind: kind === "ok" ? "success" : kind, at: instant.canonical };
  return {
    data_state: kind === "ok" ? (pages === 0 ? "no_data" : "ready") : "unknown",
    latest_refresh_attempt: attempt,
    last_successful_refresh_at: kind === "ok" ? instant.canonical : null,
  };
}

function parseAuthorization(value: unknown): SecondBrainAuthorizationFacts | undefined {
  if (!record(value) || !exactKeys(value, ["read", "write"])) return undefined;
  const read = value["read"];
  const write = value["write"];
  if ((read !== "authorized" && read !== "unauthorized")
    || (write !== "authorized" && write !== "disabled" && write !== "unauthorized")) return undefined;
  return { read, write };
}

function parseAttempt(value: unknown): SecondBrainAttemptFacts | null | undefined {
  if (value === null) return null;
  if (!record(value) || !exactKeys(value, ["at", "kind"])) return undefined;
  const kind = value["kind"];
  const at = value["at"];
  if ((kind !== "success" && kind !== "capped" && kind !== "failed") || typeof at !== "string") return undefined;
  const parsed = parseSecondBrainInstant(at);
  return parsed === undefined ? undefined : { kind, at: parsed.canonical };
}

function parseOptionalInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return parseSecondBrainInstant(value)?.canonical;
}

function parseTools(value: unknown): readonly string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string") || new Set(value).size !== value.length) return undefined;
  return [...value].sort();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}
function operationalValue(value: unknown): value is SecondBrainPeerFacts["operational"] {
  return value === "ready" || value === "unavailable";
}
function vaultValue(value: unknown): value is SecondBrainPeerFacts["vault"] {
  return value === "ready" || value === "absent" || value === "locked" || value === "unavailable";
}
function dataStateValue(value: unknown): value is SecondBrainDataState {
  return value === "ready" || value === "no_data" || value === "vault_absent" || value === "vault_locked"
    || value === "unavailable" || value === "unknown";
}
