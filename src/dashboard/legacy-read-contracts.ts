import type { ActionLevel } from "../control-plane.js";
import type { TaskTimelineEvent, TaskTimelineSummary } from "../recommendation-timeline.js";
import type { SecondBrainReadinessReportV1 } from "../second-brain-readiness.js";
import type { PortfolioOverview } from "./portfolio-contracts.js";

export type OverviewCard = {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly detail: string;
};
export type OverviewTask = {
  readonly task_id: string;
  readonly title: string;
  readonly kind: TaskTimelineSummary["kind"];
  readonly state: string;
  readonly updated_at: string;
  readonly pending_approval: boolean;
  readonly source_ids: readonly string[];
};
export type OverviewApproval = {
  readonly task_id?: string;
  readonly request_id: string;
  readonly action: string;
  readonly action_level: ActionLevel;
  readonly requested_at: string;
  readonly requested_by: string;
  readonly summary: string;
  readonly state: string;
  readonly retry_status?: "allowed" | "replan_required" | "not_allowed";
};
export type OverviewRisk = { readonly id: string; readonly severity: string; readonly message: string };
export type OverviewAgent = {
  readonly agent_id: string;
  readonly provider: string;
  readonly terminal_id: string;
  readonly incarnation_id: string;
  readonly canonical_path: string;
  readonly status: string;
  readonly observed_at?: string | null;
};
export type OverviewResponse = {
  readonly schema_version: 1;
  readonly generated_at: string | null;
  readonly cards: readonly OverviewCard[];
  readonly recent_tasks: readonly OverviewTask[];
  readonly pending_approvals: readonly OverviewApproval[];
  readonly risks: readonly OverviewRisk[];
  readonly agents: readonly OverviewAgent[];
  readonly portfolio: PortfolioOverview;
  readonly second_brain?: SecondBrainReadinessReportV1;
};
export type TaskListResponse = { readonly schema_version: 1; readonly items: readonly OverviewTask[] };
export type TaskDetailEvent = Omit<TaskTimelineEvent, "evidence_refs"> & { readonly evidence_refs: readonly string[] };
export type TaskDetailResponse = {
  readonly schema_version: 1;
  readonly context: { readonly task: OverviewTask; readonly events: readonly TaskDetailEvent[] };
};
export type AgentListResponse = { readonly schema_version: 1; readonly items: readonly OverviewAgent[] };
export type AgentDetailResponse = { readonly schema_version: 1; readonly agent: OverviewAgent };
export type ControlRequestListResponse = { readonly schema_version: 1; readonly items: readonly OverviewApproval[] };
export type DashboardLookup<T> = { readonly kind: "found"; readonly value: T } | { readonly kind: "not_found" };
