import { readCurrentLocalTimelineObservation } from "./local-timeline-observation.js";
import type Database from "better-sqlite3";
import type { Evidence, Freshness, UtcTimestamp } from "./personal-contracts.js";
import type { ParsedContextPersistenceInput } from "./personal-context-types.js";
import type { PersistenceErrorFactory } from "./personal-persistence-values.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";

type ResolvedContextEvidence = {
  readonly evidence: Evidence;
  readonly freshness_state: Freshness["state"];
  readonly fresh_until: UtcTimestamp;
};

export class PersonalContextEvidenceResolver {
  constructor(
    private readonly database: Database.Database,
    private readonly error: PersistenceErrorFactory,
  ) {}

  resolve(input: ParsedContextPersistenceInput, now: string): readonly ResolvedContextEvidence[] {
    this.requireMemoryCardinality(input);
    const resolved: ResolvedContextEvidence[] = [];
    for (const reference of input.context.payload.included_observation_refs) {
      resolved.push(this.observationEvidence(input, reference, now));
    }
    for (const reference of input.context.payload.included_memory_refs) {
      resolved.push(this.memoryEvidence(input, reference));
    }
    if (resolved.length !== input.context.evidence.length
      || new Set(resolved.map(item => item.evidence.evidence_id)).size !== resolved.length) {
      throw this.error("PERSONAL_CONTEXT_EVIDENCE_CONFLICT");
    }
    if (input.context.payload.state === "sufficient") {
      this.requireFresh(input, resolved, now);
      for (const item of resolved) {
        if (Date.parse(input.context.expires_at) > Date.parse(item.fresh_until)) {
          throw this.error("PERSONAL_CONTEXT_EVIDENCE_DEADLINE_CONFLICT");
        }
      }
    }
    return resolved;
  }

  private requireMemoryCardinality(input: ParsedContextPersistenceInput): void {
    const references = input.context.payload.included_memory_refs;
    const bindings = input.memory_evidence;
    if (references.length !== bindings.length
      || references.some(reference => bindings.filter(item => item.memory_ref === reference).length !== 1)) {
      throw this.error("PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT");
    }
  }

  private observationEvidence(input: ParsedContextPersistenceInput, reference: string, now: string): ResolvedContextEvidence {
    const value = this.database.prepare(
      `SELECT source_id,canonical_digest,freshness_state,fresh_until,observed_at,expires_at
       FROM personal_observations WHERE observation_id=?`,
    ).get(reference);
    if (value === undefined) throw this.error("PERSONAL_CONTEXT_INVALID");
    const stored = persistenceRow(value);
    if (stored["source_id"] === "src:pos:v1:task-timeline:local") {
      try { readCurrentLocalTimelineObservation({ db: this.database }, reference, () => new Date(now)); }
      catch { throw this.error("PERSONAL_CONTEXT_SOURCE_UNAVAILABLE"); }
    }
    if (Date.parse(persistenceText(stored["expires_at"])) <= Date.parse(now)) {
      throw this.error("PERSONAL_CONTEXT_SOURCE_EXPIRED");
    }
    const evidence = input.context.evidence.filter(item => (
      item.source_id === stored["source_id"] && item.digest === stored["canonical_digest"]
    ));
    if (evidence.length !== 1) throw this.error("PERSONAL_CONTEXT_EVIDENCE_CONFLICT");
    const selected = evidence[0];
    if (selected === undefined || selected.observed_at !== stored["observed_at"]) {
      throw this.error("PERSONAL_CONTEXT_EVIDENCE_CONFLICT");
    }
    const state = stored["freshness_state"];
    if (state !== "fresh" && state !== "stale" && state !== "no_data"
      && state !== "unavailable" && state !== "offline") {
      throw new TypeError("stored freshness state required");
    }
    return {
      evidence: selected,
      freshness_state: state,
      fresh_until: this.timestamp(stored["fresh_until"]),
    };
  }

  private memoryEvidence(input: ParsedContextPersistenceInput, reference: string): ResolvedContextEvidence {
    const binding = input.memory_evidence.find(item => item.memory_ref === reference);
    if (binding === undefined) throw this.error("PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT");
    const evidence = input.context.evidence.filter(item => (
      item.evidence_id === binding.evidence_id
      && item.source_id === binding.source_id
      && item.digest === binding.digest
      && item.observed_at === binding.observed_at
    ));
    if (evidence.length !== 1) throw this.error("PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT");
    const selected = evidence[0];
    if (selected === undefined) throw this.error("PERSONAL_CONTEXT_MEMORY_EVIDENCE_CONFLICT");
    return { evidence: selected, freshness_state: "fresh", fresh_until: binding.fresh_until };
  }

  private requireFresh(
    input: ParsedContextPersistenceInput,
    evidence: readonly ResolvedContextEvidence[],
    now: string,
  ): void {
    if (input.context.freshness.state !== "fresh"
      || Date.parse(input.context.freshness.fresh_until) <= Date.parse(now)) {
      throw this.error("PERSONAL_CONTEXT_FRESHNESS_CONFLICT");
    }
    if (evidence.some(item => item.freshness_state !== "fresh"
      || Date.parse(item.fresh_until) <= Date.parse(now))) {
      throw this.error("PERSONAL_CONTEXT_EVIDENCE_STALE");
    }
  }

  private timestamp(value: unknown): UtcTimestamp {
    const text = persistenceText(value);
    function valid(candidate: string): candidate is UtcTimestamp {
      return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(candidate);
    }
    if (!valid(text)) throw new TypeError("stored timestamp required");
    return text;
  }
}
