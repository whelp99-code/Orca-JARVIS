import type Database from "better-sqlite3";
import { assemblePersonalContext } from "./context-assembler.js";
import { prepareModelTransport, RecordingModelTransport, type ModelTransportCapture } from "./context-model-transport.js";
import { PersonalContextStore, type ContextMemoryEvidenceBinding, type ContextPersistenceInput, type StoredContext } from "./personal-context-store.js";
import { PersonalObservationStore, type StoredObservation } from "./personal-observation-store.js";
import { PersonalRecommendationActionStore } from "./personal-recommendation-action-store.js";
import { PersonalRecommendationReader } from "./personal-recommendation-reader.js";
import { PersonalRecommendationStore } from "./personal-recommendation-store.js";
import type {
  ReconstructedRecommendation,
  RecommendationActionTransition,
  RecommendationPersistenceInput,
  StoredRecommendation,
} from "./personal-recommendation-types.js";
import type { RecommendationId } from "./personal-contracts.js";
import type { PersistenceErrorFactory } from "./personal-persistence-values.js";

export type {
  ReconstructedRecommendation,
  RecommendationActionTransition,
  RecommendationPersistenceInput,
  ContextMemoryEvidenceBinding,
  ContextPersistenceInput,
  StoredContext,
  StoredObservation,
  StoredRecommendation,
};

export class PersonalContextPersistence {
  private readonly contexts: PersonalContextStore;
  private readonly observations: PersonalObservationStore;
  private readonly recommendations: PersonalRecommendationStore;
  private readonly recommendationActions: PersonalRecommendationActionStore;
  private readonly recommendationReader: PersonalRecommendationReader;
  readonly modelTransport: RecordingModelTransport;
  lastCapture: ModelTransportCapture | undefined;

  constructor(database: Database.Database, error: PersistenceErrorFactory, modelTransport = new RecordingModelTransport()) {
    this.contexts = new PersonalContextStore(database, error);
    this.observations = new PersonalObservationStore(database, error);
    this.recommendations = new PersonalRecommendationStore(database, error);
    this.recommendationActions = new PersonalRecommendationActionStore(database, error);
    this.recommendationReader = new PersonalRecommendationReader(database);
    this.modelTransport = modelTransport;
  }

  persistObservation(value: unknown, now: string): StoredObservation {
    return this.observations.persist(value, now);
  }

  persistContext(value: ContextPersistenceInput, now: string): StoredContext {
    return this.contexts.persist(value, now);
  }

  persistAssembledContext(input: unknown, evidence: ContextPersistenceInput["memory_evidence"], now: string): StoredContext {
    const snapshot = assemblePersonalContext(input);
    const stored = this.contexts.persist({ context: snapshot, memory_evidence: evidence }, now);
    const capture = prepareModelTransport(input, `session:${now}`);
    this.lastCapture = capture;
    void this.modelTransport.send(capture);
    return stored;
  }

  persistRecommendation(value: RecommendationPersistenceInput, now: string): StoredRecommendation {
    return this.recommendations.persist(value, now);
  }

  transitionAction(input: RecommendationActionTransition): void {
    this.recommendationActions.transition(input);
  }

  getRecommendation(id: RecommendationId): ReconstructedRecommendation | undefined {
    return this.recommendationReader.get(id);
  }
}
