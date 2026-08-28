import type Database from "better-sqlite3";
import { PersonalContextStore, type StoredContext } from "./personal-context-store.js";
import { PersonalObservationStore, type StoredObservation } from "./personal-observation-store.js";
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
  StoredContext,
  StoredObservation,
  StoredRecommendation,
};

export class PersonalContextPersistence {
  private readonly contexts: PersonalContextStore;
  private readonly observations: PersonalObservationStore;
  private readonly recommendations: PersonalRecommendationStore;
  private readonly recommendationReader: PersonalRecommendationReader;

  constructor(database: Database.Database, error: PersistenceErrorFactory) {
    this.contexts = new PersonalContextStore(database, error);
    this.observations = new PersonalObservationStore(database, error);
    this.recommendations = new PersonalRecommendationStore(database, error);
    this.recommendationReader = new PersonalRecommendationReader(database);
  }

  persistObservation(value: unknown, now: string): StoredObservation {
    return this.observations.persist(value, now);
  }

  persistContext(value: unknown, now: string): StoredContext {
    return this.contexts.persist(value, now);
  }

  persistRecommendation(value: RecommendationPersistenceInput, now: string): StoredRecommendation {
    return this.recommendations.persist(value, now);
  }

  transitionAction(input: RecommendationActionTransition): void {
    this.recommendations.transition(input);
  }

  getRecommendation(id: RecommendationId): ReconstructedRecommendation | undefined {
    return this.recommendationReader.get(id);
  }
}
