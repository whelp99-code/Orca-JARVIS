import type Database from "better-sqlite3";
import type { MemorySuppressionIdentity } from "./memory-suppression.js";

export interface MemoryProjectionDatabase {
  readonly db: Database.Database;
}

export const MEMORY_PROJECTION_KINDS = [
  "context",
  "recommendation",
  "recommendation_action",
  "daily_run",
  "daily_step",
  "morning_brief",
  "evening_closeout",
  "notification_intent",
  "notification_delivery",
  "task_timeline",
  "dashboard_projection",
  "state_generation",
  "control_payload",
  "observation",
] as const;

export type MemoryProjectionKind = (typeof MEMORY_PROJECTION_KINDS)[number];

export type MemoryProjectionRef = {
  readonly kind: MemoryProjectionKind;
  readonly id: string;
  readonly component_id: string;
};

export type MemoryProjectionDependency = MemorySuppressionIdentity & {
  readonly source_context_id?: string;
};

export type MemorySuppressionActivation = {
  readonly sequence: number;
  readonly projection_count: number;
  readonly event_digest: string;
  readonly created_at: string;
};

export type MemorySuppressionEvent = MemorySuppressionActivation & {
  readonly published_at: string | null;
};
