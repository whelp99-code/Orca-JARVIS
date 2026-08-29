import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { parsePersonalSourceSnapshot } from "./personal-connector-boundary.js";
import { PERSONAL_CONNECTOR_DEFINITIONS, personalConnectorDefinition } from "./personal-connector-definitions.js";
import {
  PERSONAL_CONNECTOR_IDS,
  PersonalConnectorError,
  type PersonalConnectorAdapters,
  type PersonalConnectorDefinition,
  type PersonalConnectorFreshness,
  type PersonalConnectorId,
  type PersonalConnectorReadRequest,
  type PersonalConnectorReason,
  type PersonalConnectorResult,
  type PersonalConnectorState,
  type PersonalSourceAdapter,
  type PersonalSourceSnapshot,
} from "./personal-connector-types.js";

export { PERSONAL_CONNECTOR_DEFINITIONS, PERSONAL_CONNECTOR_IDS, PersonalConnectorError };
export type {
  PersonalConnectorAdapters, PersonalConnectorDefinition, PersonalConnectorFreshness, PersonalConnectorId,
  PersonalConnectorReadRequest, PersonalConnectorReason, PersonalConnectorResult, PersonalConnectorState,
  PersonalConnectorValue, PersonalSourceAdapter, PersonalSourceSnapshot,
} from "./personal-connector-types.js";

const CHECKPOINT_VERSION = 1;
const MAX_CHECKPOINT_BYTES = 4_096;

type Checkpoint = {
  readonly schema_version: 1;
  readonly connector_id: PersonalConnectorId;
  readonly source_version: string;
  readonly incarnation: string | null;
  readonly sequence: number;
  readonly cursor: string;
  readonly observed_at: string;
  readonly state: PersonalConnectorState;
  readonly source_digest: string;
  readonly checkpoint_digest: string;
};

type RegistryOptions = {
  readonly adapters: PersonalConnectorAdapters;
  readonly clock: () => Date;
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function connectorId(value: string): PersonalConnectorId {
  for (const id of PERSONAL_CONNECTOR_IDS) if (id === value) return id;
  throw new PersonalConnectorError("PERSONAL_CONNECTOR_UNKNOWN");
}

function requested(values: readonly string[], allowed: readonly string[]): boolean {
  return values.length === new Set(values).size && values.every(value => allowed.includes(value));
}

function adapterFor(adapters: PersonalConnectorAdapters, id: PersonalConnectorId): PersonalSourceAdapter | undefined {
  switch (id) {
    case "second_brain": return adapters.second_brain;
    case "orca": return adapters.orca;
    case "task_timeline": return adapters.task_timeline;
    case "portfolio": return adapters.portfolio;
    case "calendar": case "mail": case "messenger": return undefined;
    default: { const exhaustive: never = id; return exhaustive; }
  }
}

function resultBase(definition: PersonalConnectorDefinition, checkedAt: string | null) {
  return {
    schema_version: 1 as const, registry_version: 1 as const, connector_id: definition.id, configured: definition.configured,
    capabilities: [...definition.capabilities], scopes: [...definition.scopes], allowed_fields: [...definition.allowed_fields], checked_at: checkedAt,
  };
}

function unavailable(
  definition: PersonalConnectorDefinition,
  reason: PersonalConnectorReason,
  checkedAt: string | null,
): PersonalConnectorResult {
  const evidence = digest({ connector_id: definition.id, reason, checked_at: checkedAt });
  return {
    ...resultBase(definition, checkedAt),
    state: "unavailable",
    reason,
    evidence: { evidence_id: `connector:${definition.id}:${evidence.slice(7)}`, digest: evidence },
    evidence_refs: [],
    observed_at: null,
    freshness: "unknown",
    cursor: null,
    checkpoint: null,
    values: {},
  };
}

function encodeCheckpoint(value: Omit<Checkpoint, "checkpoint_digest">): string {
  const checkpoint: Checkpoint = { ...value, checkpoint_digest: digest(value) };
  return Buffer.from(canonicalize(checkpoint), "utf8").toString("base64url");
}

function checkpointState(value: unknown): PersonalConnectorState | undefined {
  if (value === "ready" || value === "no_data" || value === "stale" || value === "offline" || value === "unavailable") return value;
  return undefined;
}

function parseCheckpoint(encoded: string, id: PersonalConnectorId): Checkpoint | undefined {
  if (Buffer.byteLength(encoded, "utf8") > MAX_CHECKPOINT_BYTES || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  let value: unknown;
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) return undefined;
    value = JSON.parse(decoded.toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.values(descriptors).every(item => "value" in item)) return undefined;
  const keys = Object.keys(value).sort().join("\0");
  const expectedKeys = [
    "checkpoint_digest", "connector_id", "cursor", "incarnation", "observed_at", "schema_version", "sequence",
    "source_digest", "source_version", "state",
  ].sort().join("\0");
  if (keys !== expectedKeys) return undefined;
  const read = (key: string): unknown => descriptors[key]?.value;
  const state = checkpointState(read("state"));
  if (read("schema_version") !== CHECKPOINT_VERSION || read("connector_id") !== id
    || typeof read("source_version") !== "string"
    || (read("incarnation") !== null && typeof read("incarnation") !== "string")
    || typeof read("sequence") !== "number" || !Number.isSafeInteger(read("sequence")) || Number(read("sequence")) < 0
    || typeof read("cursor") !== "string" || typeof read("observed_at") !== "string"
    || typeof read("source_digest") !== "string" || typeof read("checkpoint_digest") !== "string" || state === undefined) return undefined;
  const body = {
    schema_version: 1 as const, connector_id: id, source_version: String(read("source_version")),
    incarnation: read("incarnation") === null ? null : String(read("incarnation")), sequence: Number(read("sequence")),
    cursor: String(read("cursor")), observed_at: String(read("observed_at")), state,
    source_digest: String(read("source_digest")),
  };
  return digest(body) === read("checkpoint_digest") ? { ...body, checkpoint_digest: String(read("checkpoint_digest")) } : undefined;
}

function classify(snapshot: PersonalSourceSnapshot, id: PersonalConnectorId, checkedAt: Date): {
  readonly state: PersonalConnectorState; readonly reason: PersonalConnectorReason; readonly freshness: PersonalConnectorFreshness;
} {
  switch (snapshot.status) {
    case "no_data": return { state: "no_data", reason: "current_empty", freshness: "fresh" };
    case "stale": return { state: "stale", reason: "source_stale", freshness: "stale" };
    case "offline": return { state: "offline", reason: "source_offline", freshness: "unknown" };
    case "unavailable": return { state: "unavailable", reason: "source_unavailable", freshness: "unknown" };
    case "current": {
      if (id !== "portfolio") return { state: "ready", reason: "current", freshness: "unknown" };
      const age = checkedAt.getTime() - Date.parse(snapshot.observed_at);
      if (age <= 90_000) return { state: "ready", reason: "current", freshness: "fresh" };
      if (age <= 300_000) return { state: "stale", reason: "freshness_threshold_exceeded", freshness: "stale" };
      return { state: "offline", reason: "source_offline", freshness: "unknown" };
    }
    default: { const exhaustive: never = snapshot.status; return exhaustive; }
  }
}

export class PersonalConnectorRegistry {
  constructor(private readonly options: RegistryOptions) {}

  list(): readonly PersonalConnectorDefinition[] {
    return PERSONAL_CONNECTOR_DEFINITIONS.map(definition => ({
      ...definition, capabilities: [...definition.capabilities], scopes: [...definition.scopes],
      allowed_fields: [...definition.allowed_fields], freshness: { ...definition.freshness },
    }));
  }

  async inspect(request: PersonalConnectorReadRequest): Promise<PersonalConnectorResult> {
    const id = connectorId(request.connector_id);
    const definition = personalConnectorDefinition(id);
    const now = this.options.clock();
    if (!Number.isFinite(now.getTime())) return unavailable(definition, "invalid_clock", null);
    const checkedAt = now.toISOString();
    if (!requested(request.scopes, definition.scopes) || !requested(request.fields, definition.allowed_fields)) {
      throw new PersonalConnectorError("PERSONAL_CONNECTOR_REQUEST_INVALID");
    }
    if (!definition.configured) return unavailable(definition, "not_configured", checkedAt);
    const prior = request.checkpoint === undefined ? undefined : parseCheckpoint(request.checkpoint, id);
    if (request.checkpoint !== undefined && prior === undefined) return unavailable(definition, "checkpoint_invalid", checkedAt);
    let raw: unknown;
    try {
      raw = await adapterFor(this.options.adapters, id)?.read();
    } catch {
      return unavailable(definition, "adapter_failed", checkedAt);
    }
    let snapshot: PersonalSourceSnapshot | undefined;
    try {
      snapshot = parsePersonalSourceSnapshot(raw, definition.allowed_fields);
    } catch {
      return unavailable(definition, "invalid_source", checkedAt);
    }
    if (snapshot === undefined || Date.parse(snapshot.observed_at) > now.getTime()) {
      return unavailable(definition, "invalid_source", checkedAt);
    }
    const sourceDigest = digest(snapshot);
    if (prior !== undefined) {
      if (prior.source_version !== snapshot.source_version || prior.incarnation !== snapshot.incarnation) {
        return unavailable(definition, "checkpoint_mismatch", checkedAt);
      }
      if (snapshot.sequence < prior.sequence) return unavailable(definition, "checkpoint_stale", checkedAt);
      if (snapshot.sequence === prior.sequence && sourceDigest !== prior.source_digest) return unavailable(definition, "replay_conflict", checkedAt);
    }
    const health = classify(snapshot, id, now);
    const checkpoint = encodeCheckpoint({
      schema_version: 1, connector_id: id, source_version: snapshot.source_version, incarnation: snapshot.incarnation,
      sequence: snapshot.sequence, cursor: snapshot.cursor, observed_at: snapshot.observed_at, state: health.state, source_digest: sourceDigest,
    });
    return {
      ...resultBase(definition, checkedAt), ...health,
      evidence: { evidence_id: `connector:${id}:${sourceDigest.slice(7)}`, digest: sourceDigest },
      evidence_refs: snapshot.evidence_refs, observed_at: snapshot.observed_at, cursor: snapshot.cursor, checkpoint, values: snapshot.values,
    };
  }
}

export function createPersonalConnectorRegistry(options: RegistryOptions): PersonalConnectorRegistry {
  return new PersonalConnectorRegistry(options);
}
