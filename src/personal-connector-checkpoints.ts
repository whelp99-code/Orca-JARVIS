import { randomUUID } from "node:crypto";
import type { PersonalConnectorId, PersonalConnectorState } from "./personal-connector-types.js";

export type PersonalCheckpointState = {
  readonly connector_id: PersonalConnectorId;
  readonly source_version: string;
  readonly incarnation: string | null;
  readonly sequence: number;
  readonly cursor: string;
  readonly observed_at: string;
  readonly state: PersonalConnectorState;
  readonly source_digest: string;
};

type CheckpointDecision =
  | { readonly kind: "accepted"; readonly handle: string }
  | { readonly kind: "exact"; readonly handle: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "stale" }
  | { readonly kind: "conflict" };

function same(left: PersonalCheckpointState, right: PersonalCheckpointState): boolean {
  return left.connector_id === right.connector_id && left.source_version === right.source_version
    && left.incarnation === right.incarnation && left.sequence === right.sequence && left.cursor === right.cursor
    && left.observed_at === right.observed_at && left.state === right.state && left.source_digest === right.source_digest;
}

export class PersonalCheckpointStore {
  private readonly states = new Map<string, PersonalCheckpointState>();

  has(handle: string): boolean { return this.states.has(handle); }

  decide(current: PersonalCheckpointState, priorHandle: string | undefined): CheckpointDecision {
    if (priorHandle === undefined) return this.insert(current);
    const prior = this.states.get(priorHandle);
    if (prior === undefined) return { kind: "invalid" };
    if (prior.connector_id !== current.connector_id || prior.source_version !== current.source_version
      || prior.incarnation !== current.incarnation) return { kind: "mismatch" };
    if (current.sequence < prior.sequence) return { kind: "stale" };
    if (current.sequence === prior.sequence) return same(current, prior)
      ? { kind: "exact", handle: priorHandle }
      : { kind: "conflict" };
    if (current.cursor === prior.cursor || Date.parse(current.observed_at) <= Date.parse(prior.observed_at)) return { kind: "stale" };
    return this.insert(current);
  }

  private insert(state: PersonalCheckpointState): CheckpointDecision {
    const handle = `pcp:${randomUUID()}`;
    this.states.set(handle, Object.freeze({ ...state }));
    return { kind: "accepted", handle };
  }
}
