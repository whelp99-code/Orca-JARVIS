import type { AuthorityDb } from "./db.js";
import type { OrcaProvider, ProgressState } from "./types.js";
import type { PreGjcShadow } from "./pre-gjc-shadow.js";
import { liveWorktreePath, registerLiveBinding, listLiveBindings } from "./live-supervisor-bindings.js";
import { acknowledgeLiveReport, liveSupervisorStatus } from "./live-supervisor-reports.js";
import { configureLiveResume, liveResumeConfigured, pendingLiveResumeIntents, drainLiveStructured } from "./live-supervisor-resume.js";
import { cycleLiveObservations } from "./live-supervisor-observations.js";
export interface LiveBinding {
  canonical_path: string;
  provider: OrcaProvider;
  terminal_id: string;
  session_id: string;
  incarnation_id: string;
  cursor: string | null;
  pty_id?: string;
  worktree_id?: string;
  project_id?: string;
}
export interface LiveObservation {
  observation_attempt_id?: string;
  provider: OrcaProvider;
  terminal_id: string;
  session_id: string;
  incarnation_id: string;
  cursor: string | null;
  state: ProgressState;
  connected?: boolean;
  safe_reversible_in_scope?: boolean;
  unsafe?: boolean;
}
export type LiveObservationReader = (binding: LiveBinding) => readonly LiveObservation[] | Promise<readonly LiveObservation[]>;
export interface LiveSupervisorCycle {
  report: { report_id: string; payload_json: string; payload_digest: string } | null;
  authority_items: string[];
  resume_candidates: string[];
  recovered_report: { report_id: string; payload_json: string; payload_digest: string } | null;
}
/** Durable, local-only supervisor. It observes through an injected adapter and never sends or mutates terminals. */
export class LiveSupervisor {
  constructor(private readonly authority: AuthorityDb) {}
  register(input: Omit<LiveBinding, "canonical_path" | "cursor"> & { worktree: string }, now = new Date().toISOString()): LiveBinding {
    return registerLiveBinding(this.authority, input, now);
  }
  list(): LiveBinding[] {
    return listLiveBindings(this.authority);
  }
  acknowledgeReport(report_id: string, delivered_at = new Date().toISOString()): void {
    return acknowledgeLiveReport(this.authority, report_id, delivered_at);
  }
  async cycle(worktree: string, observe: LiveObservationReader, now = new Date().toISOString()): Promise<LiveSupervisorCycle> {
    liveWorktreePath(worktree);
    return this.cycleAll(observe, now);
  }
  status(): Record<string, unknown> {
    return liveSupervisorStatus(this.authority);
  }
  configureLiveResume(projectId: string, enabled: boolean, now = new Date()): void {
    return configureLiveResume(this.authority, projectId, enabled, now);
  }
  liveResumeConfigured(): boolean {
    return liveResumeConfigured(this.authority);
  }
  pendingLiveResumeIntents(): string[] {
    return pendingLiveResumeIntents(this.authority);
  }
  drainStructured(shadow: PreGjcShadow, now = new Date()): void {
    return drainLiveStructured(this.authority, shadow, now);
  }
  async cycleWithShadow(
    shadow: PreGjcShadow,
    observe: LiveObservationReader,
    now = new Date().toISOString(),
  ): Promise<LiveSupervisorCycle> {
    // An unacknowledged output must be replayed before staging more input.  This
    // keeps the internal source receipt and its live output in one durable unit.
    if (
      !this.authority.db
        .prepare(
          `SELECT 1 FROM live_supervisor_reports r LEFT JOIN live_supervisor_report_receipts d ON d.report_id=r.report_id
            WHERE d.report_id IS NULL LIMIT 1`,
        )
        .get()
    )
      this.drainStructured(shadow, new Date(now));
    return this.cycleAll(observe, now);
  }
  async cycleAll(observe: LiveObservationReader, now = new Date().toISOString()): Promise<LiveSupervisorCycle> {
    return cycleLiveObservations(this.authority, observe, now);
  }
}
