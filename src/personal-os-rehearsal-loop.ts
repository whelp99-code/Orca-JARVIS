import { createHash, createPrivateKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlPlane } from "./control-plane.js";
import { signCommandApproval } from "./control-plane-contract.js";
import { AuthorityDb } from "./db.js";
import { createStoredMorningDailyLoop } from "./daily-loop-morning-execution.js";
import { DailyLoopError } from "./daily-loop-types.js";
import { JarvisError } from "./jarvis-error.js";

export type LoopProof = {
  readonly ok: boolean;
  readonly brief: unknown;
  readonly approval: string | null;
  readonly worker: string | null;
  readonly verification: string | null;
  readonly artifact_sha256: string | null;
  readonly closeout_sha256: string | null;
  readonly restarted: boolean;
  readonly mac_required: false;
  readonly code: string | null;
};

function codeOf(error: unknown): string {
  if (error instanceof JarvisError || error instanceof DailyLoopError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return "E_REHEARSAL_GATE";
}

export async function runFixtureLoop(input: {
  readonly dbPath: string;
  readonly artifactDir: string;
  readonly anchorDir: string;
  readonly at: Date;
}): Promise<LoopProof> {
  const failed = (code: string, partial: Partial<LoopProof> = {}): LoopProof => ({
    // The code is the machine-consumed failure. Callers branch on it.
    ok: false,
    brief: partial.brief ?? null,
    approval: partial.approval ?? null,
    worker: partial.worker ?? null,
    verification: partial.verification ?? null,
    artifact_sha256: partial.artifact_sha256 ?? null,
    closeout_sha256: partial.closeout_sha256 ?? null,
    restarted: false,
    mac_required: false,
    code,
  });
  mkdirSync(input.artifactDir, { recursive: true });
  const db = new AuthorityDb(input.dbPath);
  try {
    const loop = createStoredMorningDailyLoop(db, {
      time_zone: "Asia/Seoul",
      owner_id: "rehearsal-owner",
      lease_ms: 300_000,
      deadline_ms: 600_000,
      recovery_window_ms: 600_000,
      recovery_lookback_days: 2,
      refresh_freshness_ms: 600_000,
      budgets: { max_items: 32, max_work: 2, max_bytes: 65_536 },
      clock: () => input.at,
      event_source: { drain: () => [] },
      refresh_reader: { read: () => null },
    });
    const brief = await loop.startup();
    const at = input.at;
    const expires = new Date(at.getTime() + 600_000);
    const control = new ControlPlane(db);
    const staged = control.stage({
      schema_version: 1,
      request_id: "req-rehearsal-loop",
      action: "state.project",
      action_level: 1,
      target: { environment: "local" },
      args: {},
      reversible: true,
      requested_by: "principal:owner",
      requested_at: at.toISOString(),
      expires_at: expires.toISOString(),
      nonce: "nonce-rehearsal-loop",
    }, at);
    const key = createPrivateKey(readFileSync(join(input.anchorDir, "decision.pem")));
    control.decide(signCommandApproval({
      schema_version: 1,
      receipt_id: "receipt:req-rehearsal-loop",
      request_id: staged.request_id,
      decision: "approve",
      command_digest: staged.command_digest,
      signer_principal_id: "principal:owner",
      authenticated_session_id: "rehearsal-virtual",
      key_id: "decision-rehearsal",
      algorithm: "Ed25519",
      issued_at: at.toISOString(),
      not_before: at.toISOString(),
      expires_at: expires.toISOString(),
      nonce: "receipt-nonce-rehearsal-loop",
      max_uses: 1,
      status: "issued",
    }, key), at);
    const claimed = control.claim(staged.request_id, "rehearsal-worker", at);
    const artifact = `${JSON.stringify({
      schema_version: 1,
      kind: "fixture-artifact",
      request_id: claimed.request_id,
      fence: claimed.fence,
      command_digest: claimed.command_digest,
    })}\n`;
    const artifactPath = join(input.artifactDir, "fixture-artifact.json");
    writeFileSync(artifactPath, artifact);
    const artifactSha = createHash("sha256").update(artifact).digest("hex");
    const verified = readFileSync(artifactPath, "utf8") === artifact
      && createHash("sha256").update(readFileSync(artifactPath)).digest("hex") === artifactSha;
    if (!verified) return failed("E_REHEARSAL_GATE", { brief, approval: staged.request_id, worker: claimed.request_id });
    control.settle(claimed.request_id, claimed.fence, {
      state: "completed",
      effect_type: "fixture-artifact",
      payload: { artifact_sha256: artifactSha },
    }, at);
    const closeout = `${JSON.stringify({
      schema_version: 1,
      kind: "fixture-closeout",
      brief_completed: brief.completed_run_ids,
      artifact_sha256: artifactSha,
      mac_required: false,
    })}\n`;
    const closeoutPath = join(input.artifactDir, "closeout.json");
    writeFileSync(closeoutPath, closeout);
    const closeoutSha = createHash("sha256").update(closeout).digest("hex");
    const restarted = new AuthorityDb(input.dbPath, undefined, { readonly: true, fileMustExist: true });
    try {
      const row = restarted.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(staged.request_id) as
        { state: string } | undefined;
      const quick = String(restarted.db.pragma("quick_check", { simple: true }));
      if (row?.state !== "completed" || quick !== "ok") {
        return failed("E_REHEARSAL_GATE", {
          brief, approval: staged.request_id, worker: claimed.request_id,
          verification: "mismatch", artifact_sha256: artifactSha, closeout_sha256: closeoutSha,
        });
      }
      return {
        ok: true,
        brief,
        approval: staged.request_id,
        worker: claimed.request_id,
        verification: "digest-match",
        artifact_sha256: artifactSha,
        closeout_sha256: closeoutSha,
        restarted: true,
        mac_required: false,
        code: null,
      };
    } finally {
      restarted.close();
    }
  } catch (error) {
    return failed(codeOf(error));
  } finally {
    db.close();
  }
}
