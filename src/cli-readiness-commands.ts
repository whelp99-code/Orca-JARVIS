import { buildCapabilityMatrix, type CapabilityProbe } from "./capabilities.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { runtimeCapabilityProbe, runDoctor } from "./doctor.js";
import { LiveSupervisor } from "./live-supervisor.js";
import { buildSecondBrainReadiness, type SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import { configuredRefreshReceiptPath } from "./second-brain-readiness-refresh.js";
import { runtimeSecondBrainReadinessProbe } from "./second-brain-readiness-runtime.js";

export type CliReadinessCommandInput = {
  readonly db: AuthorityDb;
  readonly command: string | undefined;
  readonly json: boolean | undefined;
  readonly clock: (() => Date) | undefined;
  readonly capabilityProbe: CapabilityProbe | undefined;
  readonly secondBrainProbe: SecondBrainReadinessProbe | undefined;
};

export async function tryExecuteReadinessCommand(
  input: CliReadinessCommandInput,
): Promise<Record<string, unknown> | undefined> {
  const now = input.clock?.() ?? new Date();
  if (input.command === "doctor") {
    const report = await runDoctor(
      input.db,
      now,
      input.capabilityProbe,
      input.secondBrainProbe ?? runtimeSecondBrainReadinessProbe(),
    );
    return { ok: report.ok, command: "doctor", report };
  }
  if (input.command !== "capabilities" || input.json !== true) return undefined;
  const supervisor = new LiveSupervisor(input.db);
  const liveResume = supervisor.liveResumeConfigured();
  const gjcEnabled = input.db.gjcOperational();
  const matrix = await buildCapabilityMatrix(
    input.db,
    input.capabilityProbe ?? runtimeCapabilityProbe(),
    now,
  );
  const secondBrain = await buildSecondBrainReadiness(
    input.secondBrainProbe ?? runtimeSecondBrainReadinessProbe(),
    now,
  );
  return {
    ok: true,
    second_brain: secondBrain,
    supported_targets: ["codex", "claude"],
    providers: ["codex", "claude"],
    orca_read: true,
    codex_observe: true,
    claude_observe: true,
    pre_gjc_shadow: true,
    pre_gjc_signed_signals: true,
    pre_gjc_durable_state: true,
    pre_gjc_authority_resume: true,
    authority_resume_intents: true,
    live_resume: liveResume,
    pre_gjc_completion_promotion: true,
    pre_gjc_proposal_only: true,
    gjc: gjcEnabled,
    live_seed: false,
    live_dispatch: gjcEnabled,
    control_commands_require_human_receipt: true,
    all_cli_mutations_require_control_receipt: false,
    task_timeline: true,
    collaboration_workspace: false,
    buzz_bridge: false,
    policy_resume_intents: true,
    policy_resume_auto_delivery: true,
    service_run_deployable: true,
    service_run_delivers_resume: false,
    runtime_batch_deployable: false,
    policy_auto_execute: false,
    arbitrary_verify_execution: false,
    self_modify: false,
    shadow_only: !liveResume && !gjcEnabled,
    matrix,
  };
}

export type CliSecondBrainReadinessInput = {
  readonly positionals: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly clock: (() => Date) | undefined;
  readonly secondBrainProbe: SecondBrainReadinessProbe | undefined;
};

/**
 * `second-brain readiness`: the capability probe, with no authority database involved.
 *
 * Readiness observes the provider endpoint and nothing else, so this answers before any database
 * path is resolved. It used to have no command at all, and the invocation fell through to the
 * database-backed dispatch, where an omitted `--db` resolves to the cwd-relative default
 * `jarvis-authority.sqlite` (src/authority-db-base.ts) -- an empty file created next to whatever
 * directory the operator happened to run from, whose zero applied migrations were then reported as
 * MIGRATIONS_PENDING. A probe that reads no authority state now creates none.
 */
/**
 * `--refresh-receipt PATH`: the receipt the provider publishes, for this probe only.
 *
 * Bounded the same way the daily loop bounds the path in its own configuration, so an operator
 * cannot hand readiness something the loop would refuse to read.
 */
function receiptOption(value: unknown): string | undefined {
  if (value === undefined) return configuredRefreshReceiptPath();
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 512
    || value.includes("\0")) throw new JarvisError("SECOND_BRAIN_READINESS_INPUT_INVALID");
  return value;
}

export async function tryExecuteSecondBrainReadinessCommand(
  input: CliSecondBrainReadinessInput,
): Promise<Record<string, unknown> | undefined> {
  if (input.positionals[0] !== "second-brain") return undefined;
  if (input.positionals[1] !== "readiness" || input.positionals.length !== 2
    || Object.keys(input.values).some(key => key !== "json" && key !== "refresh-receipt")) {
    throw new JarvisError("SECOND_BRAIN_READINESS_INPUT_INVALID");
  }
  // Validated whatever probe answers, so a malformed path is refused rather than ignored.
  const receipt = receiptOption(input.values["refresh-receipt"]);
  const second_brain = await buildSecondBrainReadiness(
    input.secondBrainProbe ?? runtimeSecondBrainReadinessProbe(undefined, receipt),
    input.clock?.() ?? new Date(),
  );
  return { ok: true, command: "second-brain.readiness", second_brain };
}
