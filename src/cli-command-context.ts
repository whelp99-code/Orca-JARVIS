import type { CapabilityProbe } from "./capabilities.js";
import type { AuthorityDb } from "./db.js";
import type { GjcRunner } from "./gjc.js";
import type { OrcaRunner } from "./orca.js";
import type { OrcaCommand } from "./orca-resume.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service-types.js";
import type { SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import type { MemoryOutboxProductionOptions } from "./memory-outbox-production.js";
import type { MemoryReferenceProductionOptions } from "./memory-reference-production.js";

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
