import type { AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { parseDailyLoopClaim, parseDailyLoopInstant, parseDailyLoopRunId } from "./daily-loop-input.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { DailyLoopStore } from "./daily-loop-store.js";
import { verifyEveningCloseoutArtifact } from "./evening-closeout-artifact.js";
import type { EveningCloseoutArtifact, TrustedCloseoutKey } from "./evening-closeout-types.js";
import { EveningCloseoutError } from "./evening-closeout-types.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";

type Settlement = { readonly claim: unknown; readonly artifact: EveningCloseoutArtifact; readonly at: unknown };
type StoreOptions = { readonly after_artifact_persisted?: () => void };
export class EveningCloseoutStore {
  private readonly loop: DailyLoopStore;
  constructor(
    private readonly authority: AuthorityDb,
    private readonly verifier: TrustedCloseoutKey,
    private readonly options: StoreOptions = {},
  ) {
    this.loop = new DailyLoopStore(authority);
  }
  settle(input: Settlement): boolean {
    const claim = parseDailyLoopClaim(input.claim);
    const at = parseDailyLoopInstant(input.at);
    const artifact = verifyEveningCloseoutArtifact(input.artifact, this.verifier);
    assertDailyLoopIntegrity(this.authority, claim.run_id);
    const rowValue = this.authority.db.prepare(
      "SELECT r.loop_date,r.correlation_id,r.phase,r.state AS run_state,s.state,s.detail_json " +
      "FROM daily_loop_runs r JOIN daily_loop_steps s ON s.run_id=r.run_id WHERE r.run_id=? AND s.step_key='evening_summary'",
    ).get(claim.run_id);
    if (rowValue === undefined) throw new EveningCloseoutError("EVENING_CLOSEOUT_IDENTITY_CONFLICT");
    const row = persistenceRow(rowValue);
    if (row["loop_date"] !== artifact.local_date || row["correlation_id"] !== artifact.correlation_id || row["phase"] !== "evening"
      || artifact.run_id !== claim.run_id) throw new EveningCloseoutError("EVENING_CLOSEOUT_IDENTITY_CONFLICT");
    const step = this.loop.steps(claim.run_id).find(value => value.step_key === "evening_summary");
    if (step === undefined || step.sequence !== 1) throw new EveningCloseoutError("EVENING_CLOSEOUT_IDENTITY_CONFLICT");
    const bytes = canonicalize(artifact);
    if (row["state"] === "completed") {
      if (persistenceText(row["detail_json"]) !== bytes) throw new EveningCloseoutError("EVENING_CLOSEOUT_IDENTITY_CONFLICT");
      if (row["run_state"] === "completed") return false;
    } else {
      this.loop.completeStep({ claim, step, detail: artifact, at });
      this.options.after_artifact_persisted?.();
    }
    this.loop.complete(claim, at); return true;
  }
  read(runIdValue: unknown): EveningCloseoutArtifact {
    const runId = parseDailyLoopRunId(runIdValue); assertDailyLoopIntegrity(this.authority, runId);
    const value = this.authority.db.prepare(
      "SELECT detail_json FROM daily_loop_steps WHERE run_id=? AND step_key='evening_summary' AND state='completed'",
    ).get(runId);
    if (value === undefined) throw new EveningCloseoutError("EVENING_CLOSEOUT_IDENTITY_CONFLICT");
    const parsed: unknown = JSON.parse(persistenceText(persistenceRow(value)["detail_json"]));
    return verifyEveningCloseoutArtifact(parsed, this.verifier);
  }
}
