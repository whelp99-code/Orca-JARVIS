import { randomUUID } from "node:crypto";
import type { ConfiguredPersonalConnectorId, PersonalConnectorState } from "./personal-connector-types.js";

export const PERSONAL_CONNECTOR_REGISTRY_SESSION = Object.freeze({
  version: 1 as const,
  persistence: "process_local" as const,
  restart: "handles_invalid" as const,
  max_total: 4 as const,
  max_per_connector: 1 as const,
});

export type PersonalCheckpointState = {
  readonly connector_id: ConfiguredPersonalConnectorId;
  readonly source_version: string;
  readonly incarnation: string | null;
  readonly sequence: number;
  readonly cursor: string;
  readonly observed_at: string;
  readonly state: PersonalConnectorState;
  readonly source_digest: string;
};
export type PersonalCheckpointDecision =
  | { readonly kind: "accepted"; readonly handle: string }
  | { readonly kind: "exact"; readonly handle: string }
  | { readonly kind: "capacity" }
  | { readonly kind: "session_invalid" }
  | { readonly kind: "invalid" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "stale" }
  | { readonly kind: "conflict" };

type ActiveCheckpoint = { readonly handle: string; readonly state: PersonalCheckpointState };

function same(left: PersonalCheckpointState, right: PersonalCheckpointState): boolean {
  return left.connector_id === right.connector_id && left.source_version === right.source_version
    && left.incarnation === right.incarnation && left.sequence === right.sequence && left.cursor === right.cursor
    && left.observed_at === right.observed_at && left.state === right.state && left.source_digest === right.source_digest;
}

export class PersonalCheckpointStore {
  private readonly sessionId = randomUUID();
  private readonly states = new Map<ConfiguredPersonalConnectorId, ActiveCheckpoint>();

  activeCount(): number { return this.states.size; }

  resolve(handle: string): "active" | "session_invalid" | "invalid" {
    const parts = handle.split(":");
    if (parts.length !== 4 || parts[0] !== "pcp" || parts[1] !== "1") return "invalid";
    if (parts[2] !== this.sessionId) return "session_invalid";
    return [...this.states.values()].some(item => item.handle === handle) ? "active" : "invalid";
  }

  decide(current: PersonalCheckpointState, priorHandle: string | undefined): PersonalCheckpointDecision {
    const active = this.states.get(current.connector_id);
    if (priorHandle === undefined) {
      if (active !== undefined) return { kind: "conflict" };
      if (this.states.size >= PERSONAL_CONNECTOR_REGISTRY_SESSION.max_total) return { kind: "capacity" };
      return this.replace(current);
    }
    const resolution = this.resolve(priorHandle);
    if (resolution === "session_invalid") return { kind: "session_invalid" };
    if (resolution === "invalid") return { kind: "invalid" };
    const owner = [...this.states.entries()].find(([, item]) => item.handle === priorHandle);
    if (owner !== undefined && owner[0] !== current.connector_id) return { kind: "mismatch" };
    if (active?.handle !== priorHandle) return { kind: "invalid" };
    const prior = active.state;
    if (prior.source_version !== current.source_version || prior.incarnation !== current.incarnation) return { kind: "mismatch" };
    if (current.sequence < prior.sequence) return { kind: "stale" };
    if (current.sequence === prior.sequence) return same(current, prior)
      ? { kind: "exact", handle: priorHandle }
      : { kind: "conflict" };
    if (current.cursor === prior.cursor || Date.parse(current.observed_at) <= Date.parse(prior.observed_at)) return { kind: "stale" };
    return this.replace(current);
  }

  private replace(state: PersonalCheckpointState): PersonalCheckpointDecision {
    const handle = `pcp:1:${this.sessionId}:${randomUUID()}`;
    this.states.set(state.connector_id, Object.freeze({ handle, state: Object.freeze({ ...state }) }));
    return { kind: "accepted", handle };
  }
}
