import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { MemoryCorrectionStore } from "../../src/memory-correction-store.js";
import { correctionPreparedFixture } from "./memory-correction-control.js";

export async function cancellationDatabaseFixture(mode: "suppressed" | "quarantine" | "unsuppressed" = "suppressed",
  resolved?: Parameters<typeof correctionPreparedFixture>[0]) {
  const f = await correctionPreparedFixture(resolved);
  try {
    const path = join(f.runtime.spool_root, readdirSync(f.runtime.spool_root)[0]!);
    const staged = JSON.parse(readFileSync(path, "utf8"));
    const ref = { kind: "dashboard_projection" as const, id: f.candidate.candidate_id, component_id: f.candidate.candidate_id };
    if (mode === "suppressed") new MemoryProjectionAuthority(f.db).bind(ref,
      [{ target_digest: staged.targets[0].target_digest }], f.runtime.clock());
    else {
      const prior = f.runtime.barriers.reach.bind(f.runtime.barriers);
      f.runtime.barriers.reach = async input => {
        const result = await prior(input);
        if (mode === "quarantine") new MemoryProjectionAuthority(f.db).quarantineUnresolved(ref, f.runtime.clock());
        else throw new Error("STOP_BEFORE_CLAIM");
        return result;
      };
    }
    try { await f.saga.dispatch(f.claim); throw new Error("UNEXPECTED_DISPATCH"); }
    catch (error) {
      if (!(error instanceof Error) || !["MEMORY_CANDIDATE_SUPPRESSED", "STOP_BEFORE_CLAIM"].includes(error.message)) throw error;
    }
    const record = new MemoryCorrectionStore(f.db).getByControl(f.claim.request_id);
    if (!record || record.state !== "queued" || f.writer.calls.length !== 0) throw new Error("UNSENT_FIXTURE_INVALID");
    return { ...f, record, staged, spoolPath: path };
  } catch (error) { await f.close(); throw error; }
}
