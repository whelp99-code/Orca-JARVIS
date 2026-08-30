export type ResourceQuality = "ready" | "degraded" | "no_data" | "offline" | "stale";
export type DailyRun = Readonly<Record<string, string | null>>;
export type TodayAction = Readonly<{
  recommendation_id: string;
  rank: number;
  title: string;
  confidence_class: string;
  expires_at: string;
  deep_link: string;
}>;
export type VerifiedCloseout = Readonly<{
  artifact_id: string;
  run_id: string;
  local_date: string;
  generated_at: string;
  canonical_digest: string;
  verified_completion_count: number;
  source_readiness: string;
}>;
export type TodayResponse = Readonly<{
  schema_version: 1;
  resource: "today";
  generated_at: string;
  state: ResourceQuality;
  brief: Readonly<{ state: string; brief_id: string | null; generated_at: string | null; item_count: number }>;
  active_decision_count: number;
  notification_summary: Readonly<{ total: number; states: readonly Readonly<{ state: string; count: number }>[] }>;
  current_daily_run: DailyRun | null;
  last_daily_run: DailyRun | null;
  latest_verified_closeout: VerifiedCloseout | null;
  next_actions: readonly TodayAction[];
  conflicts: readonly string[];
  omissions: readonly string[];
  freshness: Readonly<{ state: string; checked_at: string | null; fresh_until: string | null }>;
  deep_links: Readonly<{ decisions: string; daily_runs: string; notifications: string; source_health: string }>;
}>;
export type Citation = Readonly<{
  context_evidence_id: string | null;
  digest: string;
  kind: string;
  ref: string;
}>;
export type DecisionItem = Readonly<{
  recommendation_id: string;
  context_id: string;
  rank: number;
  title: string;
  state: string;
  confidence_class: string;
  occurred_at: string;
  expires_at: string;
  citations: readonly Citation[];
  deep_link: string;
}>;
export type NotificationItem = Readonly<{
  intent_id: string;
  urgency: string;
  channel: string;
  preview: string;
  deep_link: string;
  state: string;
  expires_at: string;
  updated_at: string;
}>;
export type HealthItem = Readonly<{
  kind: "source" | "capability";
  identity: string;
  state: string;
  checked_at: string;
}>;
export type PersonalPage<T> = Readonly<{
  schema_version: 1;
  generated_at: string;
  state: ResourceQuality;
  items: readonly T[];
}>;
export type EvidenceItem = Readonly<{
  evidence_id: string;
  source_id: string;
  kind: string;
  digest: string;
  observed_at: string;
  fresh_until: string | null;
}>;
export type RecommendationDetail = Readonly<{
  schema_version: 1;
  recommendation_id: string;
  context_id: string;
  confidence_class: string;
  lifecycle_state: string;
  expires_at: string;
  state: ResourceQuality;
  evidence: readonly EvidenceItem[];
  conflicts: readonly string[];
  omissions: readonly string[];
  context_evidence_link: string;
}>;
export type ContextEvidence = Readonly<{
  schema_version: 1;
  context_id: string;
  recommendation_id: string;
  state: ResourceQuality;
  evidence: readonly EvidenceItem[];
  conflicts: readonly string[];
  omissions: readonly string[];
}>;
export type AcceptedAction = Readonly<{
  schema_version: 1;
  recommendation_id: string;
  action_rank: number;
  request_id: string;
  action: "workflow.start";
  state: "pending";
}>;
export type PersonalClient = Readonly<{
  today: () => Promise<TodayResponse>;
  decisions: () => Promise<PersonalPage<DecisionItem>>;
  notifications: () => Promise<PersonalPage<NotificationItem>>;
  health: () => Promise<PersonalPage<HealthItem>>;
  recommendation: (id: string) => Promise<RecommendationDetail>;
  evidence: (link: string) => Promise<ContextEvidence>;
  accept: (id: string, rank: number) => Promise<AcceptedAction>;
}>;
