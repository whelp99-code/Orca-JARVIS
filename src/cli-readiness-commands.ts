import { buildCapabilityMatrix, type CapabilityProbe } from "./capabilities.js";
import type { AuthorityDb } from "./db.js";
import { runtimeCapabilityProbe, runDoctor } from "./doctor.js";
import { LiveSupervisor } from "./live-supervisor.js";
import { buildSecondBrainReadiness, type SecondBrainReadinessProbe } from "./second-brain-readiness.js";
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
