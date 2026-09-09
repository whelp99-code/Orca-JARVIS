import { expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { readMemoryScopedSettlementAuthority } from "../../src/memory-scoped-settlement-authority.js";
import { completionObservationFixture } from "../fixtures/scoped-completion-observation.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";

it.each(["valid", "uncertain", "source", "review", "dispatch", "key", "digest", "suppressed"])(
  "checks spent scoped authority against current withdrawal: %s", async mode => {
    const f = await completionObservationFixture();
    try {
      const db = f.database.authority.db;
      const at = new Date(f.at.getTime() + 60000);
      const roots = { candidate_dispatch_spool_root: f.options.dispatch.roots.dispatch,
        candidate_review_spool_root: f.options.dispatch.roots.review };
      const check = () => readMemoryScopedSettlementAuthority(f.options, f.dispatch.outbox_id, at, roots);
      if (mode === "uncertain") {
        const control = new ControlPlane(f.database.authority);
        control.recoverExpired(at);
        expect(control.get(f.claimed.request_id)?.state).toBe("uncertain");
      }
      expect(check().kind).toBe("spent_authority_currently_unrevoked");
      if (mode === "valid" || mode === "uncertain") {
        expect(check().control_request_id).toBe(f.claimed.request_id);
        expect(db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "reconciling" });
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        return;
      }
      if (mode === "review" || mode === "dispatch") new ControlPlane(f.database.authority).cancel({
        request_id: mode === "review" ? f.review.request_id : f.claimed.request_id,
        reason: "withdrawal", actor: "principal:owner", revoked_at: at.toISOString() }, at);
      else if (mode === "suppressed") db.exec("CREATE TEMP VIEW memory_projection_suppressions AS SELECT 'memory_candidate' AS projection_kind,'" + f.candidate.candidate_id + "' AS projection_id");
      else db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)").run(
        mode === "source" ? f.candidate.source.verification_evidence_id : mode === "key" ? "decision-test" : f.claimed.command_digest,
        "withdrawal", at.toISOString());
      expect(check).toThrow("SCOPED_SETTLEMENT_AUTHORITY_INVALID");
    } finally { closeMemoryDatabase(f.database); }
  });
