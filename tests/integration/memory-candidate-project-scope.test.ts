import { join } from "node:path";
import { readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { readCandidateReview } from "../../src/dashboard/memory-candidate-review.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import {
  candidateTaskProject, memoryProjectScopePath,
} from "../../src/memory-candidate-project-scope.js";
import {
  candidateTaskSource, candidateTaskSourceClosed, recordCandidateTaskSource,
} from "../../src/memory-candidate-task-source.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";

const TASK = "task:project-scope";
const PROJECT = "project:listed";
const NOW = new Date(MEMORY_NOW);
const open: MemoryDatabase[] = [];
afterEach(() => { for (const database of open.splice(0)) closeMemoryDatabase(database); });

type Fixture = {
  readonly database: MemoryDatabase;
  readonly store: MemoryCandidateStore;
  readonly reviewRoot: string;
  readonly scopePath: string;
  readonly write: (document: unknown) => void;
};

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

/** The alias that can reach a work item: a continuation the control plane accepted for it. */
function acceptContinuation(database: MemoryDatabase, aliasId: string, taskId: string): void {
  database.authority.db.prepare(
    `INSERT INTO continuation_acceptances(id,work_id,proposal_hash,authorization_kind,
      authorization_id,lease_epoch,fencing_token,created_at) VALUES(?,?,?,'receipt','receipt:1',1,1,?)`)
    .run(aliasId, taskId, `sha256:${aliasId}`, NOW.toISOString());
}

const spoolFiles = (root: string): number => {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).length;
  } catch { return 0; }
};

async function fixture(): Promise<Fixture> {
  const database = await memoryDatabase();
  open.push(database);
  const reviewRoot = join(database.root, "review");
  const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => NOW);
  store.attachReviewSpool(reviewRoot);
  const scopePath = memoryProjectScopePath(database.authority.filename);
  return { database, store, reviewRoot, scopePath,
    write: document => { writeFileSync(scopePath, JSON.stringify(document)); } };
}

const allow = (...projects: string[]): unknown =>
  ({ schema_version: 1, mode: "allow_list", projects });
const candidates = (database: MemoryDatabase): number => Number(database.authority.db
  .prepare("SELECT COUNT(*) FROM memory_candidates").pluck().get());

it("admits a candidate whose task belongs to a listed project", async () => {
  const f = await fixture();
  proposeWorkItem(f.database, TASK, PROJECT);
  f.write(allow(PROJECT));
  expect(candidateTaskProject(f.database.authority, TASK)).toBe(PROJECT);

  const classified = f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK);
  expect(candidateTaskSource(f.database.authority, classified.candidate_id)).toBe(TASK);
  expect(candidateTaskSourceClosed(f.database.authority, classified.candidate_id)).toBe(false);
}, 60_000);

it("follows an accepted continuation to the work item that names the project", async () => {
  const f = await fixture();
  proposeWorkItem(f.database, TASK, PROJECT);
  acceptContinuation(f.database, "continuation:alias", TASK);
  f.write(allow(PROJECT));
  expect(candidateTaskProject(f.database.authority, "continuation:alias")).toBe(PROJECT);

  const classified = f.store.classify(inferredMemoryInput({ sensitivity: "personal" }),
    "continuation:alias");
  expect(candidateTaskSource(f.database.authority, classified.candidate_id))
    .toBe("continuation:alias");
}, 60_000);

it("refuses a candidate whose task belongs to a project the owner did not list", async () => {
  const f = await fixture();
  proposeWorkItem(f.database, TASK, PROJECT);
  f.write(allow("project:other"));

  expect(() => f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK))
    .toThrow("MEMORY_CANDIDATE_PROJECT_OUT_OF_SCOPE");
  // Refused rather than admitted and filtered later: no row, and no private text left in the
  // review spool the store writes outside the database.
  expect(candidates(f.database)).toBe(0);
  expect(spoolFiles(f.reviewRoot)).toBe(0);
}, 60_000);

it("refuses a candidate whose task has no project this database can prove", async () => {
  const f = await fixture();
  f.write(allow(PROJECT));
  expect(candidateTaskProject(f.database.authority, TASK)).toBeNull();

  expect(() => f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK))
    .toThrow("MEMORY_CANDIDATE_PROJECT_UNVERIFIED");
  expect(candidates(f.database)).toBe(0);
  expect(spoolFiles(f.reviewRoot)).toBe(0);
}, 60_000);

it("refuses a task binding recorded after the candidate already exists", async () => {
  const f = await fixture();
  proposeWorkItem(f.database, TASK, PROJECT);
  const classified = f.store.classify(inferredMemoryInput({ sensitivity: "personal" }));
  f.write(allow("project:other"));

  // The later binding is the same gate as admission: one chokepoint, not one caller.
  expect(() => recordCandidateTaskSource(f.database.authority, classified.candidate_id, TASK, NOW))
    .toThrow("MEMORY_CANDIDATE_PROJECT_OUT_OF_SCOPE");
  expect(candidateTaskSource(f.database.authority, classified.candidate_id)).toBeNull();
}, 60_000);

it("closes a candidate the owner puts out of scope after it was admitted", async () => {
  const f = await fixture();
  proposeWorkItem(f.database, TASK, PROJECT);
  const classified = f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK);
  expect(readCandidateReview(f.database.authority, f.reviewRoot, classified.candidate_id, NOW))
    .toBeDefined();

  // Written after admission, which is exactly the case admission alone cannot cover.
  f.write(allow("project:other"));
  expect(candidateTaskSourceClosed(f.database.authority, classified.candidate_id)).toBe(true);
  expect(readCandidateReview(f.database.authority, f.reviewRoot, classified.candidate_id, NOW))
    .toBeUndefined();
}, 60_000);

it("does not consider projects at all without the document", async () => {
  const f = await fixture();
  // The same task the scoped runs refuse: with no document there is nothing to refuse it with.
  const classified = f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK);
  expect(candidateTaskSource(f.database.authority, classified.candidate_id)).toBe(TASK);
  expect(candidateTaskSourceClosed(f.database.authority, classified.candidate_id)).toBe(false);
}, 60_000);

it("refuses a document it cannot read exactly, including one reached through a link", async () => {
  const f = await fixture();
  proposeWorkItem(f.database, TASK, PROJECT);
  for (const document of [
    { schema_version: 1, mode: "allow_list", projects: [PROJECT], extra: true },
    { schema_version: 2, mode: "allow_list", projects: [PROJECT] },
    { schema_version: 1, mode: "deny_list", projects: [PROJECT] },
    { schema_version: 1, mode: "allow_list", projects: [] },
    { schema_version: 1, mode: "allow_list", projects: [PROJECT, PROJECT] },
    { schema_version: 1, mode: "allow_list" },
  ]) {
    f.write(document);
    expect(() => f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK))
      .toThrow("MEMORY_PROJECT_SCOPE_CONFIG_INVALID");
  }

  const elsewhere = join(f.database.root, "elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify(allow(PROJECT)));
  rmSync(f.scopePath, { force: true });
  symlinkSync(elsewhere, f.scopePath);
  // A policy this process cannot prove it read is not a policy it may act on.
  expect(() => f.store.classify(inferredMemoryInput({ sensitivity: "personal" }), TASK))
    .toThrow("MEMORY_PROJECT_SCOPE_CONFIG_INVALID");
}, 60_000);
