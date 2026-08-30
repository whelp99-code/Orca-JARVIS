export const PERSONAL_SCHEMA_VERSION = 1 as const;
export const PERSONAL_PAGE_DEFAULT = 20;
export const PERSONAL_PAGE_MAX = 100;
export const PERSONAL_RESPONSE_MAX_BYTES = 64 * 1024;

export const PERSONAL_TOPICS = {
  today: "personal.today.v1",
  recommendations: "personal.recommendations.v1",
  evidence: "personal.context-evidence.v1",
  dailyRuns: "personal.daily-runs.v1",
  decisions: "personal.decision-inbox.v1",
  notifications: "personal.notification-intents.v1",
  health: "personal.source-health.v1",
} as const;

export type PersonalTopic = (typeof PERSONAL_TOPICS)[keyof typeof PERSONAL_TOPICS];
export type ResourceState = "ready" | "degraded" | "no_data" | "offline" | "stale";
export type PersonalListResource = "daily-runs" | "decision-inbox" | "notification-intents" | "source-health";

export type PersonalPage<T> = {
  readonly schema_version: 1;
  readonly resource: PersonalListResource;
  readonly generated_at: string;
  readonly state: ResourceState;
  readonly items: readonly T[];
  readonly page: {
    readonly limit: number;
    readonly returned: number;
    readonly total: number;
    readonly has_more: boolean;
    readonly next_cursor: string | null;
  };
};

export type RecommendationEvidenceProjection = {
  readonly evidence_id: string;
  readonly source_id: string;
  readonly kind: string;
  readonly digest: string;
  readonly observed_at: string;
  readonly fresh_until: string | null;
};

export type RecommendationDetailProjection = {
  readonly schema_version: 1;
  readonly resource: "recommendation";
  readonly recommendation_id: string;
  readonly context_id: string;
  readonly canonical_digest: string;
  readonly evidence_digest: string;
  readonly approval_requirement: string;
  readonly confidence_class: string;
  readonly lifecycle_state: string;
  readonly expires_at: string;
  readonly state: ResourceState;
  readonly actions: readonly Readonly<Record<string, unknown>>[];
  readonly evidence: readonly RecommendationEvidenceProjection[];
  readonly conflicts: readonly string[];
  readonly omissions: readonly string[];
  readonly deep_links: { readonly context_evidence: string };
};

export type ContextEvidenceProjection = {
  readonly schema_version: 1;
  readonly resource: "context-evidence";
  readonly context_id: string;
  readonly recommendation_id: string;
  readonly state: ResourceState;
  readonly freshness: { readonly state: string; readonly fresh_until: string };
  readonly evidence: readonly RecommendationEvidenceProjection[];
  readonly conflicts: readonly string[];
  readonly omissions: readonly string[];
};

export const PERSONAL_EVENT_TOPICS = {
  recommendation: [PERSONAL_TOPICS.recommendations, PERSONAL_TOPICS.today],
  decision: [PERSONAL_TOPICS.decisions, PERSONAL_TOPICS.today],
  daily_run: [PERSONAL_TOPICS.dailyRuns, PERSONAL_TOPICS.today],
  closeout: [PERSONAL_TOPICS.dailyRuns, PERSONAL_TOPICS.today],
  notification: [PERSONAL_TOPICS.notifications, PERSONAL_TOPICS.today],
  capability: [PERSONAL_TOPICS.health, PERSONAL_TOPICS.today],
  context: [PERSONAL_TOPICS.evidence, PERSONAL_TOPICS.health, PERSONAL_TOPICS.today],
} as const satisfies Readonly<Record<string, readonly PersonalTopic[]>>;

export type PersonalEventKind = keyof typeof PERSONAL_EVENT_TOPICS;
