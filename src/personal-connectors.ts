import { createSecondBrainReadAdapter } from "./second-brain-adapter.js";
import { PersonalCheckpointStore, PERSONAL_CONNECTOR_REGISTRY_SESSION } from "./personal-connector-checkpoints.js";
import { parsePersonalConnectorConfig, type ParsedPersonalConnectorConfig } from "./personal-connector-config.js";
import { personalConnectorDefinitionsForSecondBrain } from "./personal-connector-definitions.js";
import {
  OrcaPersonalConnectorSource,
  PersonalSourceBudgetError,
  PortfolioPersonalConnectorSource,
  TaskTimelinePersonalConnectorSource,
} from "./personal-connector-live-sources.js";
import { parsePersonalConnectorRequest, readPersonalClock } from "./personal-connector-request.js";
import { classifyPersonalSnapshot, personalNoScope, personalResultBase, personalUnavailable } from "./personal-connector-results.js";
import { SecondBrainPersonalConnectorSource, type SecondBrainConnectorRead } from "./personal-connector-second-brain-source.js";
import { OrcaReadonlyAdapter } from "./orca.js";
import { TaskTimeline } from "./task-timeline.js";
import {
  PERSONAL_CONNECTOR_IDS,
  PersonalConnectorConfigError,
  PersonalConnectorError,
  type ConfiguredPersonalConnectorId,
  type PersonalCheckpointSessionResult,
  type PersonalConnectorDefinition,
  type PersonalConnectorReadRequest,
  type PersonalConnectorRegistry,
  type PersonalConnectorResult,
  type PersonalSourceSnapshot,
} from "./personal-connector-types.js";
import { freezePersonalResult, personalConnectorDigest } from "./personal-connector-values.js";

export { PERSONAL_CONNECTOR_IDS, PERSONAL_CONNECTOR_REGISTRY_SESSION, PersonalConnectorError };
export { PersonalConnectorConfigError } from "./personal-connector-types.js";
export type {
  ConfiguredPersonalConnectorId,
  PersonalConnectorDefinition,
  PersonalConnectorFreshness,
  PersonalConnectorId,
  PersonalConnectorReadRequest,
  PersonalConnectorReason,
  PersonalConnectorRegistry,
  PersonalConnectorResult,
  PersonalConnectorState,
  PersonalConnectorValue,
  PersonalRegistrySessionContract,
  PersonalSourceSnapshot,
} from "./personal-connector-types.js";
export type { SecondBrainConnectorRead } from "./personal-connector-second-brain-source.js";

type PersonalConnectorSources = {
  readonly second_brain: SecondBrainPersonalConnectorSource;
  readonly orca: OrcaPersonalConnectorSource;
  readonly task_timeline: TaskTimelinePersonalConnectorSource;
  readonly portfolio: PortfolioPersonalConnectorSource;
};
type ConfiguredSource = PersonalConnectorSources[ConfiguredPersonalConnectorId];
const REGISTRY_TOKEN = Symbol("personal-connector-registry");

function operationInfo(operation: SecondBrainConnectorRead): {
  readonly capability: "search" | "read_page" | "recent_changes" | "open_conflicts";
  readonly scope: string;
} {
  switch (operation.kind) {
    case "search": return { capability: "search", scope: "second_brain.search.read" };
    case "page": return { capability: "read_page", scope: "second_brain.page.read" };
    case "recent": return { capability: "recent_changes", scope: "second_brain.recent.read" };
    case "conflicts": return { capability: "open_conflicts", scope: "second_brain.conflict.read" };
    default: { const exhaustive: never = operation; return exhaustive; }
  }
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
function requested(values: readonly string[], allowed: readonly string[]): boolean {
  return values.length === new Set(values).size && values.every(value => allowed.includes(value));
}
function fieldAllowed(id: ConfiguredPersonalConnectorId, field: string, scopes: readonly string[]): boolean {
  if (id === "portfolio") return scopes.includes("portfolio.projection.read");
  if (id === "second_brain") return scopes.length === 1;
  if (id === "orca") {
    if (field === "environment") return scopes.includes("orca.identity.read");
    if (field === "connected" || field === "last_output_at") return scopes.includes("orca.connectivity.read");
    if (field === "worktree_id") return scopes.includes("orca.worktree.read");
    if (field === "terminal_id" || field === "incarnation_id") return scopes.includes("orca.terminal.read");
    return field === "cursor" && scopes.includes("orca.cursor.read");
  }
  if (field === "task_id" || field === "state" || field === "observed_at" || field === "pending_approval") {
    return scopes.includes("task_timeline.task.read");
  }
  if (field === "event_id" || field === "sequence") return scopes.includes("task_timeline.event.read");
  if (field === "decision_id") return scopes.includes("task_timeline.decision.read");
  return field === "evidence_id" && scopes.includes("task_timeline.evidence.read");
}
function definitionFor(definitions: readonly PersonalConnectorDefinition[], id: PersonalConnectorReadRequest["connector_id"]): PersonalConnectorDefinition {
  const found = definitions.find(item => item.id === id);
  if (found === undefined) throw new TypeError("PERSONAL_CONNECTOR_DEFINITION_MISSING");
  return found;
}
function checkpointSession(
  request: PersonalConnectorReadRequest,
  handle: string | null,
): PersonalCheckpointSessionResult {
  return request.checkpoint_session === undefined
    ? { mode: "stateless", version: 1, persistence: "process_local", handle: null }
    : { mode: "explicit", version: 1, persistence: "process_local", handle };
}
function buildSources(config: ParsedPersonalConnectorConfig): PersonalConnectorSources {
  const transport = Object.freeze({
    call: config.second_brain.call,
    restart: async () => {},
    close: async () => {},
    diagnostics: () => [],
  });
  const memory = new SecondBrainPersonalConnectorSource({
    adapter: createSecondBrainReadAdapter({
      transport,
      budgets: config.second_brain.budgets,
      clock: config.clock,
      max_age_ms: config.second_brain.max_age_ms,
      expiry_ms: config.second_brain.expiry_ms,
    }),
    readiness: { inspect: config.second_brain.readiness_inspect },
    read: config.second_brain.operation,
  });
  return Object.freeze({
    second_brain: memory,
    orca: new OrcaPersonalConnectorSource({
      adapter: new OrcaReadonlyAdapter(config.orca.runner),
      environment: config.orca.environment,
      worktree: config.orca.worktree,
    }),
    task_timeline: new TaskTimelinePersonalConnectorSource({
      timeline: new TaskTimeline(config.timeline.authority),
      limit: config.timeline.limit,
    }),
    portfolio: new PortfolioPersonalConnectorSource(config.portfolio),
  });
}

class PersonalConnectorRegistryAuthority {
  readonly registry_session = PERSONAL_CONNECTOR_REGISTRY_SESSION;
  readonly #checkpoints = new PersonalCheckpointStore();
  readonly #config: ParsedPersonalConnectorConfig;
  readonly #sources: PersonalConnectorSources;
  readonly #definitions: readonly PersonalConnectorDefinition[];

  constructor(token: symbol, config: ParsedPersonalConnectorConfig) {
    if (token !== REGISTRY_TOKEN) throw new PersonalConnectorConfigError();
    const info = operationInfo(config.second_brain.operation);
    this.#config = config;
    this.#sources = buildSources(config);
    this.#definitions = personalConnectorDefinitionsForSecondBrain(info.capability, info.scope);
  }

  list(): readonly PersonalConnectorDefinition[] { return this.#definitions; }

  async inspect(input: unknown): Promise<PersonalConnectorResult> {
    const request = parsePersonalConnectorRequest(input);
    const definition = definitionFor(this.#definitions, request.connector_id);
    const emptyCheckpointSession = checkpointSession(request, null);
    if (!requested(request.scopes, definition.scopes) || !requested(request.fields, definition.allowed_fields)) {
      throw new PersonalConnectorError("PERSONAL_CONNECTOR_REQUEST_INVALID");
    }
    if (configured(request.connector_id)) {
      const configuredId = request.connector_id;
      if (!request.fields.every(field => fieldAllowed(configuredId, field, request.scopes))) {
        throw new PersonalConnectorError("PERSONAL_CONNECTOR_REQUEST_INVALID");
      }
    }
    const now = readPersonalClock(this.#config.clock);
    if (now === undefined) {
      return personalUnavailable(definition, "invalid_clock", { checked_at: null, checkpoint_session: emptyCheckpointSession });
    }
    const checkedAt = now.toISOString();
    const resultContext = { checked_at: checkedAt, checkpoint_session: emptyCheckpointSession };
    if (!configured(request.connector_id)) return personalUnavailable(definition, "not_configured", resultContext);
    if (request.scopes.length === 0) return personalNoScope(definition, resultContext);
    const session = request.checkpoint_session;
    if (session?.mode === "continue") {
      const resolution = this.#checkpoints.resolve(session.handle);
      if (resolution === "session_invalid") {
        return personalUnavailable(definition, "checkpoint_session_invalid", resultContext);
      }
      if (resolution === "invalid") return personalUnavailable(definition, "checkpoint_invalid", resultContext);
    }
    let snapshot: PersonalSourceSnapshot;
    try { snapshot = await sourceFor(this.#sources, request.connector_id).read(now); }
    catch (error) {
      return personalUnavailable(
        definition,
        error instanceof PersonalSourceBudgetError ? "source_budget_exceeded" : "adapter_failed",
        resultContext,
      );
    }
    if (snapshot.connector_id !== request.connector_id || Date.parse(snapshot.observed_at) > now.getTime()) {
      return personalUnavailable(definition, "invalid_source", resultContext);
    }
    if (snapshot.status !== "current" && snapshot.status !== "stale" && Object.keys(snapshot.values).length !== 0) {
      return personalUnavailable(definition, "invalid_source", resultContext);
    }
    const sourceDigest = personalConnectorDigest(snapshot);
    const health = classifyPersonalSnapshot(snapshot, request.connector_id, now);
    let checkpointHandle: string | null = null;
    if (session !== undefined) {
      const checkpoint = this.#checkpoints.decide({
        connector_id: request.connector_id, source_version: snapshot.source_version, incarnation: snapshot.incarnation,
        sequence: snapshot.sequence, cursor: snapshot.cursor, observed_at: snapshot.observed_at, state: health.state,
        source_digest: sourceDigest,
      }, session.mode === "continue" ? session.handle : undefined);
      if (checkpoint.kind === "capacity") return personalUnavailable(definition, "checkpoint_capacity", resultContext);
      if (checkpoint.kind === "session_invalid") {
        return personalUnavailable(definition, "checkpoint_session_invalid", resultContext);
      }
      if (checkpoint.kind === "invalid") return personalUnavailable(definition, "checkpoint_invalid", resultContext);
      if (checkpoint.kind === "mismatch") return personalUnavailable(definition, "checkpoint_mismatch", resultContext);
      if (checkpoint.kind === "stale") return personalUnavailable(definition, "checkpoint_stale", resultContext);
      if (checkpoint.kind === "conflict") return personalUnavailable(definition, "replay_conflict", resultContext);
      checkpointHandle = checkpoint.handle;
    }
    const exposeValues = health.state === "ready" || health.state === "stale";
    const values = Object.fromEntries(Object.entries(snapshot.values).filter(([field]) => request.fields.includes(field)));
    return freezePersonalResult({
      ...personalResultBase(definition, {
        checked_at: checkedAt, checkpoint_session: checkpointSession(request, checkpointHandle),
      }),
      ...health,
      evidence: { evidence_id: `connector:${request.connector_id}:${sourceDigest.slice(7)}`, digest: sourceDigest },
      evidence_refs: exposeValues ? [...snapshot.evidence_refs] : [],
      observed_at: snapshot.observed_at, cursor: snapshot.cursor, checkpoint: checkpointHandle,
      values: exposeValues ? values : {},
    });
  }
}

export function createPersonalConnectorRegistry(input: unknown): PersonalConnectorRegistry {
  const authority = new PersonalConnectorRegistryAuthority(REGISTRY_TOKEN, parsePersonalConnectorConfig(input));
  const facade = {
    registry_session: authority.registry_session,
    list: authority.list.bind(authority),
    inspect: authority.inspect.bind(authority),
  };
  Object.setPrototypeOf(facade, null);
  return Object.freeze(facade);
}
