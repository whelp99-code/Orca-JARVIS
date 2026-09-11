import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { candidateTaskProject } from "../../src/memory-candidate-project-scope.js";
import { candidateTaskSource } from "../../src/memory-candidate-task-source.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";

const TASK = "task:project-scope";
const PROJECT = "project:listed";
const NOW = new Date(MEMORY_NOW);
const open: MemoryDatabase[] = [];
afterEach(() => { for (const database of open.splice(0)) closeMemoryDatabase(database); });

/** A task the control plane actually proposed work for, which is what names a project. */
function proposeWorkItem(database: MemoryDatabase, taskId: string, projectId: string): void {
  const at = NOW.toISOString();
  database.authority.db.prepare(
    "INSERT INTO projects(id,target_kind,created_at) VALUES(?,'claude',?)").run(projectId, at);
  database.authority.db.prepare(
    `INSERT INTO census_snapshots(id,project_id,version,digest,baseline,policy_hash,observed_at,
      payload_json) VALUES(?,?,1,?,'baseline','sha256:policy',?,'{}')`)
    .run(`snapshot:${projectId}`, projectId, `sha256:${projectId}`, at);
  database.authority.db.prepare(
    `INSERT INTO work_items(id,snapshot_id,proposal_hash,target_kind,baseline,policy_hash,action,
      scope_json,forbidden_json,budget_json,attempt_id,deadline,lease_id,lease_epoch,fencing_token,
      state,created_at) VALUES(?,?,?,'claude','baseline','sha256:policy','edit','{}','[]','{}',
      'attempt:1',?,'lease:1',1,1,'proposed',?)`)
    .run(taskId, `snapshot:${projectId}`, `sha256:${taskId}`, at, at);
}

async function fixture(scope?: unknown): Promise<{
  readonly database: MemoryDatabase; readonly store: MemoryCandidateStore;
}> {
  const database = await memoryDatabase();
  open.push(database);
  const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(join(database.root, "review"));
  if (scope !== undefined) {
    const path = join(database.root, "memory-project-scope.json");
    writeFileSync(path, JSON.stringify(scope));
    store.attachProjectScope(path);
  }
  return { database, store };
}

const candidates = (database: MemoryDatabase): number => Number(database.authority.db
  .prepare("SELECT COUNT(*) FROM memory_candidates").pluck().get());

it("admits a candidate whose task belongs to a listed project", async () => {
  const f = await fixture({ schema_version: 1, mode: "allow_list", projects: [PROJECT] });
  proposeWorkItem(f.database, TASK, PROJECT);
  expect(candidateTaskProject(f.database.authority, TASK)).toBe(PROJECT);

  const classified = f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK);
  expect(candidateTaskSource(f.database.authority, classified.candidate_id)).toBe(TASK);
}, 60_000);

it("refuses a candidate whose task belongs to a project the owner did not list", async () => {
  const f = await fixture({ schema_version: 1, mode: "allow_list", projects: ["project:other"] });
  proposeWorkItem(f.database, TASK, PROJECT);

  expect(() => f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK))
    .toThrow("MEMORY_CANDIDATE_PROJECT_OUT_OF_SCOPE");
  // Refused rather than admitted and filtered later: the candidate and its binding share one
  // transaction, so neither survives the refusal.
  expect(candidates(f.database)).toBe(0);
}, 60_000);

it("refuses a candidate whose task has no project this database can prove", async () => {
  const f = await fixture({ schema_version: 1, mode: "allow_list", projects: [PROJECT] });
  expect(candidateTaskProject(f.database.authority, TASK)).toBeNull();

  expect(() => f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK))
    .toThrow("MEMORY_CANDIDATE_PROJECT_UNVERIFIED");
  expect(candidates(f.database)).toBe(0);
}, 60_000);

it("does not consider projects at all without the document", async () => {
  const f = await fixture();
  // The same task the scoped run refuses: with no policy there is nothing to refuse it with.
  const classified = f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK);
  expect(candidateTaskSource(f.database.authority, classified.candidate_id)).toBe(TASK);
}, 60_000);

it("refuses a scope document it cannot read exactly", async () => {
  for (const document of [
    { schema_version: 1, mode: "allow_list", projects: [PROJECT], extra: true },
    { schema_version: 2, mode: "allow_list", projects: [PROJECT] },
    { schema_version: 1, mode: "deny_list", projects: [PROJECT] },
    { schema_version: 1, mode: "allow_list", projects: [] },
    { schema_version: 1, mode: "allow_list", projects: [PROJECT, PROJECT] },
    { schema_version: 1, mode: "allow_list" },
  ]) {
    await expect(fixture(document)).rejects.toThrow("MEMORY_PROJECT_SCOPE_CONFIG_INVALID");
  }
}, 60_000);
