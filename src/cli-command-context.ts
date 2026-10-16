import type { CapabilityProbe } from "./capabilities.js";
import type { AuthorityDb } from "./db.js";
import type { GjcRunner } from "./gjc.js";
import type { OrcaRunner } from "./orca.js";
import type { OrcaCommand } from "./orca-resume.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service-types.js";
import type { SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import type { MemoryOutboxProductionOptions } from "./memory-outbox-production.js";
import type { MemoryReferenceProductionOptions } from "./memory-reference-production.js";
import type { ScopedMemoryProductionOptions } from "./memory-scoped-production.js";
import type { ScopedReconcileProductionOptions } from "./memory-scoped-reconcile-production.js";
import type { MemoryWithdrawalProductionOptions } from "./memory-withdrawal-production.js";

export type CliDependencies = {
  readonly orcaRunner?: OrcaRunner;
  readonly liveOrcaCommand?: OrcaCommand;
  readonly gjcRunner?: GjcRunner;
  readonly clock?: () => Date;
  readonly liveReportOutput?: (value: object) => void;
  readonly capabilityProbe?: CapabilityProbe;
  readonly secondBrainProbe?: SecondBrainReadinessProbe;
  readonly readStdin?: () => Promise<Buffer>;
  readonly memoryLifecycle?: MemoryLifecycleService;
  readonly memoryOutboxOptions?: MemoryOutboxProductionOptions;
  readonly memoryReferenceOptions?: MemoryReferenceProductionOptions;
  /** Host-authenticated session and explicit policy; never derived from CLI claims. */
  readonly scopedMemoryReferenceOptions?: ScopedMemoryProductionOptions;
  readonly scopedMemoryReconcileOptions?: ScopedReconcileProductionOptions;
  /** Provider identity and read-fence key for resolving what a hidden task still has stored. */
  readonly memoryWithdrawalOptions?: MemoryWithdrawalProductionOptions;
};

export type CliValues = {
  readonly db?: string;
  readonly decision_public?: string;
  readonly decision_key_id?: string;
  readonly decision_principal?: string;
  readonly verifier_public?: string;
  readonly verifier_key_id?: string;
  readonly verifier_principal?: string;
  readonly json?: boolean;
  readonly once?: boolean;
  readonly crash?: string;
  readonly worktree?: string;
  readonly bindings?: string;
  readonly limit?: string;
  readonly cursor?: string;
  readonly all?: boolean;
  readonly max_pages?: string;
  readonly max_bytes?: string;
  readonly interval_ms?: string;
  readonly "interval-ms"?: string;
  readonly environments?: string;
  readonly live_resume?: boolean;
  readonly session_id?: string;
  readonly input?: string;
  readonly idempotency_key?: string;
  readonly allow_mutation?: boolean;
  readonly worker?: string;
  readonly source?: string;
  readonly "key-file"?: string;
  readonly "memory-review-cleanup-root"?: string;
  readonly "memory-review-cleanup-limit"?: string;
  readonly "remote-audit-retention-limit"?: string;
  readonly "local-timeline-refresh"?: boolean;
  readonly "local-retention-config"?: string;
  readonly "dashboard-url"?: string;
  readonly to?: string;
  readonly "release-root"?: string;
  readonly "dry-run"?: boolean;
  readonly rehearse?: string;
  readonly phase?: string;
  readonly "rehearsal-receipt"?: string;
  readonly "production-root"?: boolean;
  readonly "restore-backup"?: string;
  readonly "refresh-receipt"?: string;
  readonly spool?: string;
  readonly "company-config"?: string;
  readonly "company-completion-config"?: string;
  readonly "company-freshness-config"?: string;
};

export type CliCommandContext = {
  readonly args: readonly string[];
  readonly values: CliValues;
  readonly positionals: readonly string[];
  readonly command: string | undefined;
  readonly subcommand: string | undefined;
  readonly argument: string | undefined;
  readonly fourth: string | undefined;
  readonly fifth: string | undefined;
  readonly sixth: string | undefined;
  readonly db: AuthorityDb;
  readonly dependencies: CliDependencies;
};

export function normalizeCliValues(
  value: Readonly<Record<string, string | boolean | undefined>>,
): CliValues {
  return {
    "company-config": stringValue(value["company-config"]),
    "company-completion-config": stringValue(value["company-completion-config"]),
    "company-freshness-config": stringValue(value["company-freshness-config"]),
    db: stringValue(value.db),
    decision_public: stringValue(value.decision_public),
    decision_key_id: stringValue(value.decision_key_id),
    decision_principal: stringValue(value.decision_principal),
    verifier_public: stringValue(value.verifier_public),
    verifier_key_id: stringValue(value.verifier_key_id),
    verifier_principal: stringValue(value.verifier_principal),
    json: booleanValue(value.json),
    once: booleanValue(value.once),
    crash: stringValue(value.crash),
    worktree: stringValue(value.worktree),
    bindings: stringValue(value.bindings),
    limit: stringValue(value.limit),
    cursor: stringValue(value.cursor),
    all: booleanValue(value.all),
    max_pages: stringValue(value.max_pages),
    max_bytes: stringValue(value.max_bytes),
    interval_ms: stringValue(value.interval_ms),
    "interval-ms": stringValue(value["interval-ms"]),
    environments: stringValue(value.environments),
    live_resume: booleanValue(value.live_resume),
    session_id: stringValue(value.session_id),
    input: stringValue(value.input),
    idempotency_key: stringValue(value.idempotency_key),
    allow_mutation: booleanValue(value.allow_mutation),
    worker: stringValue(value.worker),
    source: stringValue(value.source),
    "key-file": stringValue(value["key-file"]),
    "memory-review-cleanup-root": stringValue(value["memory-review-cleanup-root"]),
    "memory-review-cleanup-limit": stringValue(value["memory-review-cleanup-limit"]),
    "remote-audit-retention-limit": stringValue(value["remote-audit-retention-limit"]),
    "local-timeline-refresh": booleanValue(value["local-timeline-refresh"]),
    "local-retention-config": stringValue(value["local-retention-config"]),
    "dashboard-url": stringValue(value["dashboard-url"]),
    to: stringValue(value.to),
    "release-root": stringValue(value["release-root"]),
    "dry-run": booleanValue(value["dry-run"]),
    rehearse: stringValue(value.rehearse),
    phase: stringValue(value.phase),
    "rehearsal-receipt": stringValue(value["rehearsal-receipt"]),
    "production-root": booleanValue(value["production-root"]),
    "restore-backup": stringValue(value["restore-backup"]),
    "refresh-receipt": stringValue(value["refresh-receipt"]),
    spool: stringValue(value.spool),
  };
}

function stringValue(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: string | boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export type CliCommandHandler = (
  context: CliCommandContext,
) => Promise<Record<string, unknown> | undefined>;

export function commandNow(context: CliCommandContext): Date {
  return context.dependencies.clock?.() ?? new Date();
}
