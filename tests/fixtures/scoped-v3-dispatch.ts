import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { memoryDatabase, closeMemoryDatabase, insertMemoryVerification, memoryVerificationPayload } from "./memory-candidate-store.js";
import { verifiedMemoryInput, memoryPolicy, MEMORY_NOW } from "./memory-candidate-fixture.js";
import { execute } from "../../src/cli.js";
import { readMemoryCandidate } from "../../src/memory-candidate-reader.js";
import { resolveSpooledDispatch } from "../../src/memory-outbox-dispatch-request.js";

/** Uses the production CLI to publish both spools, not hand-built review data. */
export async function scopedV3DispatchFixture(at?: Date) {
  const database = await memoryDatabase();
  try {
    const now = at ?? new Date(MEMORY_NOW);
    const statement = "첫 결정\r\n두 번째 결정\n반복\n반복 [^user]";
    const input = { ...verifiedMemoryInput({ statement }), schema_version: 2, body_profile: "plain-text-v1" };
    insertMemoryVerification(database.authority, memoryVerificationPayload(input, {
      issued_at: now.toISOString(), not_before: now.toISOString(), expires_at: new Date(now.getTime() + 86400000).toISOString() }));
    const roots = { review: join(database.root, "candidate-review"), dispatch: join(database.root, "candidate-dispatch") };
    const inputFile = join(database.root, "input.json"), policyFile = join(database.root, "policy.json");
    writeFileSync(inputFile, JSON.stringify(input), { mode: 0o600 });
    writeFileSync(policyFile, JSON.stringify(memoryPolicy()), { mode: 0o600 });
    const result = await execute(["memory", "classify", inputFile, policyFile, "--db", database.path], {
      clock: () => now, memoryOutboxOptions: { candidate_review_spool_root: roots.review, candidate_dispatch_spool_root: roots.dispatch } });
    if (result.ok !== true) throw new Error("fixture CLI classify failed");
    const row = database.authority.db.prepare("SELECT candidate_id,dispatch_spool_digest FROM memory_candidate_dispatch_publications").get() as
      { candidate_id: string; dispatch_spool_digest: string } | undefined;
    if (row === undefined) throw new Error("fixture CLI did not publish dispatch");
    const candidate = readMemoryCandidate(database.authority.db, row.candidate_id);
    if (candidate === undefined) throw new Error("fixture CLI candidate missing");
    const dispatch = { dispatch_spool_digest: row.dispatch_spool_digest, roots };
    const request = resolveSpooledDispatch({ ...dispatch, candidate_id: candidate.candidate_id, now });
    return { database, candidate, now, statement, request, dispatch, cli_published: true as const };
  } catch (error) { closeMemoryDatabase(database); throw error; }
}
