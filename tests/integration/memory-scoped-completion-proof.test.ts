import { expect, it } from "vitest";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { completionObservationFixture } from "../fixtures/scoped-completion-observation.js";
import { readMemoryScopedCompletionProof } from "../../src/memory-scoped-completion-proof.js";
import { canonicalize } from "../../src/canonical.js";
import { memoryHash } from "../../src/memory-candidate-values.js";

it("reconstructs immutable history after authority expiry without granting settlement", async () => {
  const f = await completionObservationFixture();
  try {
    const result = readMemoryScopedCompletionProof(f.options, f.recorded.observation_id, new Date(f.at.getTime() + 60000));
    expect(result.kind).toBe("completion_evidence_consistent");
    expect(Object.isFrozen(result.evidence.artifact.record_ids)).toBe(true);
    expect(result.evidence.status.state).toBe("proved");
    expect(f.database.authority.db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "reconciling" });
    expect(f.database.authority.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => readMemoryScopedCompletionProof(f.options, f.recorded.observation_id, new Date(f.at.getTime() - 1))).toThrow();
  } finally { closeMemoryDatabase(f.database); }
});

it.each(["digest", "provider", "scope", "proof", "generation", "records", "acceptance", "event", "time", "fence", "attempt_time"])(
  "rejects inconsistent historical evidence: %s", async mode => {
    const f = await completionObservationFixture();
    try {
      const db = f.database.authority.db;
      let id = f.recorded.observation_id;
      if (mode === "provider") {
        expect(() => readMemoryScopedCompletionProof({ ...f.options, providerInstanceId: "provider:other" }, id, f.at)).toThrow();
        return;
      }
      db.exec("DROP TRIGGER scoped_completion_update");
      if (mode === "time") db.prepare("UPDATE memory_scoped_completion_observations SET observed_at=?").run(new Date(f.at.getTime() + 1).toISOString());
      else if (mode === "fence") db.prepare("UPDATE memory_scoped_completion_observations SET reconcile_fence=99").run();
      else if (mode === "attempt_time") {
        const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_outbox_attempts'").all() as { name: string }[];
        for (const row of triggers) db.exec('DROP TRIGGER "' + row.name.replaceAll('"', '""') + '"');
        db.prepare("UPDATE memory_outbox_attempts SET completed_at=?").run(new Date(f.now.getTime() - 1).toISOString());
      } else if (mode === "event") {
        const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_reconciliation_events'").all() as { name: string }[];
        for (const row of triggers) db.exec('DROP TRIGGER "' + row.name.replaceAll('"', '""') + '"');
        db.prepare("DELETE FROM memory_reconciliation_events WHERE event_type='provider_accepted'").run();
      } else {
        const row = db.prepare("SELECT evidence_json FROM memory_scoped_completion_observations").get() as { evidence_json: string };
        const e = JSON.parse(row.evidence_json);
        if (mode === "digest") e.schema_version = 2;
        if (mode === "scope") e.artifact.access.sources[0].classification.projects = ["project:other"];
        if (mode === "proof") e.status.proof.content_digest = "sha256:" + "d".repeat(64);
        if (mode === "generation") e.artifact.generation.generation_id = "sbgen:v1:" + "d".repeat(64);
        if (mode === "records") e.artifact.record_ids = ["invalid"];
        if (mode === "acceptance") e.status.acceptance.accepted_at = f.at.toISOString();
        const digest = memoryHash("orca-jarvis/memory-scoped-completion-observation/v1\0", e);
        id = "memobs:scoped:v1:" + digest.slice(7);
        db.prepare("UPDATE memory_scoped_completion_observations SET evidence_json=?,evidence_digest=?,observation_id=?")
          .run(canonicalize(e), mode === "digest" ? "sha256:" + "e".repeat(64) : digest, id);
      }
      expect(() => readMemoryScopedCompletionProof(f.options, id, f.at)).toThrow("SCOPED_COMPLETION_EVIDENCE_INVALID");
    } finally { closeMemoryDatabase(f.database); }
  });
