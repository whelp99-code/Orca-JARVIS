import { signPortfolioEnvelope } from "../../src/dashboard/portfolio-auth.js";
import type { OrcaTaskObservationInput, PersonalObservationNormalizationInput } from "../../src/index.js";
import { jmReport, localReport } from "./portfolio-report.js";

export const OBSERVATION_CHECKED_AT = "2026-08-28T12:00:00.000Z";
export const OBSERVATION_KEY = Buffer.alloc(32, 7);

export function observationTask(
  environment: "local" | "jm-server" | "mac-client" = "local",
  terminalId = `terminal-${environment}`,
  taskId = `task-${environment}`,
): OrcaTaskObservationInput {
  const observedAt = "2026-08-28T11:59:00.000Z";
  return {
    environment,
    worktree: environment === "local" ? "/home/jm/orca/workspaces/task" : `/orca-env/${environment}/home/jm/task`,
    worktree_id: `worktree-${environment}`,
    terminal_id: terminalId,
    session_id: `session-${environment}`,
    incarnation_id: `incarnation-${environment}`,
    pty_id: `pty-${environment}`,
    cursor: `cursor-${environment}`,
    working: true,
    timeline: {
      schema_version: 1,
      generated_at: OBSERVATION_CHECKED_AT,
      task: { task_id: taskId, title: "not persisted", kind: "work", state: "running", updated_at: observedAt, pending_approval: false, source_ids: [`source-${environment}`] },
      events: [
        { event_id: `decision-${environment}`, task_id: taskId, source: "control", kind: "approval", actor: "operator", title: "not persisted", status: "approve", payload: { fact: "not persisted" }, evidence_refs: [`receipt-${environment}`], created_at: observedAt, sequence: 1 },
        { event_id: `evidence-${environment}`, task_id: taskId, source: "verification", kind: "evidence", actor: "verifier", title: "not persisted", status: "recorded", payload: { fact: "not persisted" }, evidence_refs: [`verify-${environment}`], created_at: observedAt, sequence: 2 },
      ],
      pending_decisions: [], workers: [], evidence: [], truncated: false,
    },
  };
}

export function observationInput(): PersonalObservationNormalizationInput {
  return {
    checked_at: OBSERVATION_CHECKED_AT,
    orca_tasks: [observationTask("local"), observationTask("jm-server")],
    portfolios: [
      { environment: "local", envelope: Buffer.from(JSON.stringify(signPortfolioEnvelope(localReport({ reported_at: "2026-08-28T11:58:00.000Z" }), OBSERVATION_KEY))), received_at: OBSERVATION_CHECKED_AT, key: OBSERVATION_KEY },
      { environment: "jm-server", envelope: Buffer.from(JSON.stringify(signPortfolioEnvelope(jmReport({ reported_at: "2026-08-28T11:58:30.000Z" }), OBSERVATION_KEY))), received_at: OBSERVATION_CHECKED_AT, key: OBSERVATION_KEY },
    ],
  };
}
