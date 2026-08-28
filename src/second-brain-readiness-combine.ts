import type {
  SecondBrainAttemptFacts,
  SecondBrainAuthorizationFacts,
  SecondBrainLegacyStatus,
  SecondBrainPeerFacts,
} from "./second-brain-readiness-facts.js";
import type { SecondBrainDataState } from "./second-brain-readiness.js";

export type CombinedSecondBrainFacts = {
  readonly contract_digest: string | null;
  readonly protocol_version: string | null;
  readonly tools: readonly string[] | null;
  readonly input_schemas_compatible: boolean | null;
  readonly output_schemas_compatible: boolean | null;
  readonly status_operational: boolean | null;
  readonly doctor_operational: boolean | null;
  readonly channels_consistent: boolean;
  readonly authorization: SecondBrainAuthorizationFacts;
  readonly authorization_consistent: boolean;
  readonly data_state: SecondBrainDataState;
  readonly latest_refresh_attempt: SecondBrainAttemptFacts | null;
  readonly last_successful_refresh_at: string | null;
};

export function combineSecondBrainFacts(input: {
  readonly status: SecondBrainPeerFacts | undefined;
  readonly doctor: SecondBrainPeerFacts | undefined;
  readonly handshake: SecondBrainPeerFacts | undefined;
  readonly legacy: SecondBrainLegacyStatus | undefined;
}): CombinedSecondBrainFacts {
  const peers = [input.status, input.doctor, input.handshake].filter(isPeerFacts);
  const statusOperational = input.status === undefined ? null : input.status.operational === "ready";
  const doctorOperational = input.doctor === undefined ? null : input.doctor.operational === "ready";
  const authorizations = [input.status?.authorization, input.doctor?.authorization]
    .filter(isAuthorization);
  const authorizationConsistent = same(authorizations.map(value => JSON.stringify(value)));
  const authorization = authorizationConsistent && authorizations[0] !== undefined
    ? authorizations[0]
    : { read: "unauthorized" as const, write: "unauthorized" as const };
  const states = [input.status?.data_state, input.doctor?.data_state, input.legacy?.data_state]
    .filter(dataStateValue);
  const attempts = [
    input.status?.latest_refresh_attempt,
    input.doctor?.latest_refresh_attempt,
    input.legacy?.latest_refresh_attempt,
  ].filter(isAttemptFacts);
  const successes = [
    input.status?.last_successful_refresh_at,
    input.doctor?.last_successful_refresh_at,
    input.legacy?.last_successful_refresh_at,
  ].filter(isString);
  const compatibilityConsistent = same(peers.map(peer => JSON.stringify({
    digest: peer.contract_digest,
    input: peer.input_schemas_compatible,
    output: peer.output_schemas_compatible,
    protocol: peer.protocol_version,
    tools: peer.tools,
  })));
  const vaults = [input.status?.vault, input.doctor?.vault].filter(isVault);
  const operationalValues = [input.status?.operational, input.doctor?.operational]
    .filter((value): value is SecondBrainPeerFacts["operational"] => value !== undefined);
  return {
    contract_digest: mergedString(peers.map(peer => peer.contract_digest)),
    protocol_version: mergedString(peers.map(peer => peer.protocol_version)),
    tools: mergedTools(peers.map(peer => peer.tools)),
    input_schemas_compatible: mergedBoolean(peers.map(peer => peer.input_schemas_compatible)),
    output_schemas_compatible: mergedBoolean(peers.map(peer => peer.output_schemas_compatible)),
    status_operational: statusOperational,
    doctor_operational: doctorOperational,
    channels_consistent: compatibilityConsistent && same(operationalValues) && same(vaults),
    authorization,
    authorization_consistent: authorizationConsistent,
    data_state: conservativeDataState(states, vaults),
    latest_refresh_attempt: latestAttempt(attempts),
    last_successful_refresh_at: latestInstant(successes),
  };
}

function isPeerFacts(value: SecondBrainPeerFacts | undefined): value is SecondBrainPeerFacts {
  return value !== undefined;
}
function isAttemptFacts(value: SecondBrainAttemptFacts | null | undefined): value is SecondBrainAttemptFacts {
  return value !== null && value !== undefined;
}
function isAuthorization(
  value: SecondBrainAuthorizationFacts | undefined,
): value is SecondBrainAuthorizationFacts {
  return value !== undefined;
}
function isString(value: string | null | undefined): value is string {
  return typeof value === "string";
}
function isVault(value: SecondBrainPeerFacts["vault"] | undefined): value is SecondBrainPeerFacts["vault"] {
  return value !== undefined;
}
function same(values: readonly string[]): boolean {
  return values.length < 2 || values.every(value => value === values[0]);
}
function mergedString(values: readonly (string | null)[]): string | null {
  const observed = values.filter(isString);
  return observed.length === 0 ? null : same(observed) ? observed[0] ?? null : "contradictory";
}
function mergedBoolean(values: readonly (boolean | null)[]): boolean | null {
  const observed = values.filter((value): value is boolean => typeof value === "boolean");
  return observed.length === 0 ? null : observed.every(Boolean) && same(observed.map(String));
}
function mergedTools(values: readonly (readonly string[] | null)[]): readonly string[] | null {
  const observed = values.filter((value): value is readonly string[] => value !== null);
  if (observed.length === 0) return null;
  return same(observed.map(value => JSON.stringify(value))) ? observed[0] ?? null : ["contradictory"];
}
function conservativeDataState(
  states: readonly SecondBrainDataState[],
  vaults: readonly SecondBrainPeerFacts["vault"][],
): SecondBrainDataState {
  if (vaults.includes("locked") || states.includes("vault_locked")) return "vault_locked";
  if (vaults.includes("absent") || states.includes("vault_absent")) return "vault_absent";
  if (vaults.includes("unavailable") || states.includes("unavailable")) return "unavailable";
  if (!same(states)) return "unknown";
  return states[0] ?? "unknown";
}
function latestAttempt(values: readonly SecondBrainAttemptFacts[]): SecondBrainAttemptFacts | null {
  return [...values].sort((left, right) => right.at.localeCompare(left.at)
    || attemptRank(right.kind) - attemptRank(left.kind))[0] ?? null;
}
function attemptRank(kind: SecondBrainAttemptFacts["kind"]): number {
  return kind === "failed" ? 3 : kind === "capped" ? 2 : 1;
}
function latestInstant(values: readonly string[]): string | null {
  return [...values].sort((left, right) => right.localeCompare(left))[0] ?? null;
}
function dataStateValue(value: unknown): value is SecondBrainDataState {
  return value === "ready" || value === "no_data" || value === "vault_absent" || value === "vault_locked"
    || value === "unavailable" || value === "unknown";
}
