import { realpathSync } from "node:fs";

export type TaskTimelineSource =
  | "work"
  | "control"
  | "workflow"
  | "gjc"
  | "verification"
  | "progress";
export type TaskTimelineKind =
  | "status"
  | "command"
  | "approval"
  | "workflow"
  | "agent"
  | "verification"
  | "evidence"
  | "system";

export interface TaskTimelineEvent {
  event_id: string;
  task_id: string;
  source: TaskTimelineSource;
  kind: TaskTimelineKind;
  actor: string;
  title: string;
  status: string | null;
  payload: unknown;
  evidence_refs: string[];
  created_at: string;
  sequence: number;
}

export interface TaskTimelineSummary {
  task_id: string;
  title: string;
  kind: "work" | "command" | "workflow" | "agent";
  state: string;
  updated_at: string;
  pending_approval: boolean;
  source_ids: string[];
}

export interface TaskTimelineContext {
  schema_version: 1;
  generated_at: string;
  task: TaskTimelineSummary;
  events: TaskTimelineEvent[];
  pending_decisions: unknown[];
  workers: unknown[];
  evidence: unknown[];
  truncated: boolean;
}

export type Row = Record<string, unknown>;
export type MutableEvent = Omit<TaskTimelineEvent, "sequence">;
export type TimelineEventSink = (event: MutableEvent) => void;

export interface TimelineGraph {
  ids: Set<string>;
  workIds: Set<string>;
  continuationIds: Set<string>;
  controlIds: Set<string>;
  runIds: Set<string>;
  intentIds: Set<string>;
  questionIds: Set<string>;
  projectIds: Set<string>;
  worktreeIds: Set<string>;
  canonicalPaths: Set<string>;
  bindings: Map<string, Row>;
  sourceIds: Set<string>;
}

export const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};
export const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const rowJson = (value: unknown): Row => {
  const parsed = parse(value);
  return isRow(parsed) ? parsed : {};
};
export const string = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);
export const optional = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
export const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));
export const evidence = (...items: unknown[]): string[] => [
  ...new Set(items.flatMap(item => Array.isArray(item) ? item : [item]).filter(nonempty)),
];
export const latest = (...items: unknown[]): string =>
  items.map(optional).filter(nonempty).sort().at(-1) ?? "";
export const values = (set: Iterable<string>): string[] =>
  [...new Set([...set].filter(nonempty))];
export const bindingKey = (row: Row): string =>
  `${string(row.canonical_path)}\0${string(row.provider)}\0${string(row.terminal_id)}`;
export const canonicalPath = (value: unknown): string => {
  const path = optional(value);
  if (!path || !path.startsWith("/")) return path ?? "";
  try { return realpathSync(path); } catch { return path; }
};
export const stateRank = (state: string): number => {
  if (["failed", "uncertain", "blocked"].includes(state)) return 100;
  if (["rejected", "cancelled"].includes(state)) return 90;
  if (["pending", "awaiting_decision", "waiting_approval", "approval_required", "needs_input"]
    .includes(state)) return 80;
  if (["approved", "claimed", "running", "accepted", "verifying", "recovering", "continued",
    "awaiting_verification"].includes(state)) return 70;
  if (["completed", "shadow_completed", "stopped"].includes(state)) return 20;
  return 40;
};
export const pendingApproval = (state: string): boolean =>
  ["pending", "awaiting_decision", "waiting_approval", "approval_required", "needs_input"]
    .includes(state);
export const graphIds = (graph: TimelineGraph): Set<string> => new Set([
  ...graph.ids,
  ...graph.workIds,
  ...graph.continuationIds,
  ...graph.controlIds,
  ...graph.runIds,
  ...graph.intentIds,
  ...graph.questionIds,
  ...graph.projectIds,
]);
