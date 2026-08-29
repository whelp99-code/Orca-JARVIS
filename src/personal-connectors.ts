import { PersonalCheckpointStore } from "./personal-connector-checkpoints.js";
import { PERSONAL_CONNECTOR_DEFINITIONS, personalConnectorDefinition } from "./personal-connector-definitions.js";
import {
  OrcaPersonalConnectorSource,
  PortfolioPersonalConnectorSource,
  TaskTimelinePersonalConnectorSource,
} from "./personal-connector-live-sources.js";
import { parsePersonalConnectorRequest, readPersonalClock } from "./personal-connector-request.js";
import { classifyPersonalSnapshot, personalResultBase, personalUnavailable } from "./personal-connector-results.js";
import { SecondBrainPersonalConnectorSource } from "./personal-connector-second-brain-source.js";
import {
  PERSONAL_CONNECTOR_IDS,
  PersonalConnectorError,
  type ConfiguredPersonalConnectorId,
  type PersonalConnectorDefinition,
  type PersonalConnectorReadRequest,
  type PersonalConnectorResult,
  type PersonalSourceSnapshot,
} from "./personal-connector-types.js";
import { freezePersonalResult, personalConnectorDigest } from "./personal-connector-values.js";

export { PERSONAL_CONNECTOR_DEFINITIONS, PERSONAL_CONNECTOR_IDS, PersonalConnectorError };
export { OrcaPersonalConnectorSource, PortfolioPersonalConnectorSource, TaskTimelinePersonalConnectorSource };
export { SecondBrainPersonalConnectorSource };
export type {
  ConfiguredPersonalConnectorId,
  PersonalConnectorDefinition,
  PersonalConnectorFreshness,
  PersonalConnectorId,
  PersonalConnectorReadRequest,
  PersonalConnectorReason,
  PersonalConnectorResult,
  PersonalConnectorState,
  PersonalConnectorValue,
  PersonalSourceSnapshot,
} from "./personal-connector-types.js";
export type { SecondBrainConnectorRead } from "./personal-connector-second-brain-source.js";

type PersonalConnectorSources = {
  readonly second_brain: SecondBrainPersonalConnectorSource;
  readonly orca: OrcaPersonalConnectorSource;
  readonly task_timeline: TaskTimelinePersonalConnectorSource;
  readonly portfolio: PortfolioPersonalConnectorSource;
};

type RegistryOptions = { readonly sources: PersonalConnectorSources; readonly clock: () => Date };
type ConfiguredSource = PersonalConnectorSources[ConfiguredPersonalConnectorId];

function requested(values: readonly string[], allowed: readonly string[]): boolean {
  return values.length === new Set(values).size && values.every(value => allowed.includes(value));
}

function sourceFor(sources: PersonalConnectorSources, id: ConfiguredPersonalConnectorId): ConfiguredSource {
  switch (id) {
    case "second_brain": return sources.second_brain;
    case "orca": return sources.orca;
    case "task_timeline": return sources.task_timeline;
    case "portfolio": return sources.portfolio;
    default: { const exhaustive: never = id; return exhaustive; }
  }
}

function configured(id: PersonalConnectorReadRequest["connector_id"]): id is ConfiguredPersonalConnectorId {
  return id === "second_brain" || id === "orca" || id === "task_timeline" || id === "portfolio";
}

function validSourceClass(source: ConfiguredSource, id: ConfiguredPersonalConnectorId): boolean {
  switch (id) {
    case "second_brain": return source instanceof SecondBrainPersonalConnectorSource;
    case "orca": return source instanceof OrcaPersonalConnectorSource;
    case "task_timeline": return source instanceof TaskTimelinePersonalConnectorSource;
    case "portfolio": return source instanceof PortfolioPersonalConnectorSource;
    default: { const exhaustive: never = id; return exhaustive; }
  }
}

export class PersonalConnectorRegistry {
  private readonly checkpoints = new PersonalCheckpointStore();
  constructor(private readonly options: RegistryOptions) {}

  list(): readonly PersonalConnectorDefinition[] { return PERSONAL_CONNECTOR_DEFINITIONS; }

  async inspect(input: unknown): Promise<PersonalConnectorResult> {
    const request = parsePersonalConnectorRequest(input);
    const definition = personalConnectorDefinition(request.connector_id);
    if (!requested(request.scopes, definition.scopes) || !requested(request.fields, definition.allowed_fields)) {
      throw new PersonalConnectorError("PERSONAL_CONNECTOR_REQUEST_INVALID");
    }
    const now = readPersonalClock(this.options.clock);
    if (now === undefined) return personalUnavailable(definition, "invalid_clock", null);
    const checkedAt = now.toISOString();
    if (!configured(request.connector_id)) return personalUnavailable(definition, "not_configured", checkedAt);
    if (request.checkpoint !== undefined && !this.checkpoints.has(request.checkpoint)) {
      return personalUnavailable(definition, "checkpoint_invalid", checkedAt);
    }
    const source = sourceFor(this.options.sources, request.connector_id);
    if (!validSourceClass(source, request.connector_id)) return personalUnavailable(definition, "invalid_source", checkedAt);
    let snapshot: PersonalSourceSnapshot;
    try {
      snapshot = await source.read(now);
    } catch {
      return personalUnavailable(definition, "adapter_failed", checkedAt);
    }
    if (snapshot.connector_id !== request.connector_id || Date.parse(snapshot.observed_at) > now.getTime()) {
      return personalUnavailable(definition, "invalid_source", checkedAt);
    }
    if (snapshot.status !== "current" && snapshot.status !== "stale" && Object.keys(snapshot.values).length !== 0) {
      return personalUnavailable(definition, "invalid_source", checkedAt);
    }
    const sourceDigest = personalConnectorDigest(snapshot);
    const health = classifyPersonalSnapshot(snapshot, request.connector_id, now);
    const checkpoint = this.checkpoints.decide({
      connector_id: request.connector_id,
      source_version: snapshot.source_version,
      incarnation: snapshot.incarnation,
      sequence: snapshot.sequence,
      cursor: snapshot.cursor,
      observed_at: snapshot.observed_at,
      state: health.state,
      source_digest: sourceDigest,
    }, request.checkpoint);
    if (checkpoint.kind === "invalid") return personalUnavailable(definition, "checkpoint_invalid", checkedAt);
    if (checkpoint.kind === "mismatch") return personalUnavailable(definition, "checkpoint_mismatch", checkedAt);
    if (checkpoint.kind === "stale") return personalUnavailable(definition, "checkpoint_stale", checkedAt);
    if (checkpoint.kind === "conflict") return personalUnavailable(definition, "replay_conflict", checkedAt);
    return freezePersonalResult({
      ...personalResultBase(definition, checkedAt),
      ...health,
      evidence: { evidence_id: `connector:${request.connector_id}:${sourceDigest.slice(7)}`, digest: sourceDigest },
      evidence_refs: [...snapshot.evidence_refs],
      observed_at: snapshot.observed_at,
      cursor: snapshot.cursor,
      checkpoint: checkpoint.handle,
      values: { ...snapshot.values },
    });
  }
}

export function createPersonalConnectorRegistry(options: RegistryOptions): PersonalConnectorRegistry {
  return new PersonalConnectorRegistry(options);
}
