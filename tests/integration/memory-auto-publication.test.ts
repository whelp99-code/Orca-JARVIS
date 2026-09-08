import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { execute } from "../../src/cli.js";
import { publishAutomaticMemoryCandidate } from "../../src/memory-auto-publication.js";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { resolveSpooledDispatch } from "../../src/memory-outbox-dispatch-request.js";
import { hasSecondBrainWriteAuthority } from "../../src/second-brain-write-authority.js";
import { prepareMemoryRememberDispatch } from "../../src/memory-remember-dispatch.js";
import { memoryDatabase, closeMemoryDatabase, seedMemoryAuthority, memoryCandidateStore, memoryTableCounts } from "../fixtures/memory-candidate-store.js";
import { verifiedMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";

it.each([1, 2])("CLI publishes approved schema %i candidates and replays without extra rows", async version => {
  const f = await memoryDatabase();
  try {
    const now = new Date(MEMORY_NOW); const statement = version === 2 ? "첫 줄\r\n둘째 줄" : "verified outcome";
    const input = { ...verifiedMemoryInput({ statement }), schema_version: version,
      ...(version === 2 ? { body_profile: "plain-text-v1" } : {}) };
    seedMemoryAuthority(f.authority, input);
    const roots = { candidate_review_spool_root: join(f.root, "review"), candidate_dispatch_spool_root: join(f.root, "dispatch") };
    const path = join(f.root, "input.json"), policy = join(f.root, "policy.json");
    writeFileSync(path, JSON.stringify(input)); writeFileSync(policy, JSON.stringify(memoryPolicy()));
    const run = () => execute(["memory", "classify", path, policy, "--db", f.path], { clock: () => now, memoryOutboxOptions: roots });
    const result = await run(); expect(result.ok).toBe(true);
    const row = f.authority.db.prepare("SELECT candidate_id,dispatch_spool_digest FROM memory_candidate_dispatch_publications").get() as
      { candidate_id: string; dispatch_spool_digest: string };
    expect(row).toBeDefined();
    const request = resolveSpooledDispatch({ ...row, roots: { review: roots.candidate_review_spool_root,
      dispatch: roots.candidate_dispatch_spool_root }, now });
    expect(request.schema_version).toBe(version === 2 ? 3 : 1); expect(request.payload.content).toBe(statement);
    expect(hasSecondBrainWriteAuthority(f.authority, request, now)).toBe(true);
    expect(prepareMemoryRememberDispatch(f.authority, row.candidate_id, now, roots).action).toBe("memory.outbox.dispatch");
    const counts = memoryTableCounts(f.authority);
    expect(await run()).toEqual(result); expect(memoryTableCounts(f.authority)).toEqual(counts);
    expect(counts.memory_outbox).toBe(0);
  } finally { closeMemoryDatabase(f); }
});

it("adopts exact files after a publication failure without regenerating candidate bytes", async () => {
  const f = await memoryDatabase();
  try {
    const now = new Date(MEMORY_NOW); const input = verifiedMemoryInput(); seedMemoryAuthority(f.authority, input);
    const candidate = memoryCandidateStore(f.authority).classify(input);
    const roots = { candidate_review_spool_root: join(f.root, "review"), candidate_dispatch_spool_root: join(f.root, "dispatch") };
    const original = MemoryCandidateDispatchSpool.prototype.publish;
    const spy = vi.spyOn(MemoryCandidateDispatchSpool.prototype, "publish").mockImplementation(function (this: MemoryCandidateDispatchSpool, ...args) {
      original.apply(this, args); throw new Error("after-file-before-ledger");
    });
    const before = memoryTableCounts(f.authority);
    expect(() => publishAutomaticMemoryCandidate(f.authority, input, memoryPolicy(), roots, () => now)).toThrow("after-file-before-ledger");
    spy.mockRestore(); expect(memoryTableCounts(f.authority)).toEqual(before);
    const spool = new MemoryCandidateDispatchSpool(roots.candidate_dispatch_spool_root);
    const bytes = readFileSync(spool.pathFor(candidate.candidate_id));
    expect(publishAutomaticMemoryCandidate(f.authority, input, memoryPolicy(), roots, () => new Date(now.getTime() + 1))).toBeDefined();
    expect(readFileSync(spool.pathFor(candidate.candidate_id))).toEqual(bytes);
  } finally { vi.restoreAllMocks(); closeMemoryDatabase(f); }
});
