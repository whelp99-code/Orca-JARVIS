import { readFile, writeFile, chmod, mkdir, rename, symlink, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publishTaskGitCandidate, inspectTaskGitPublication } from "../../src/task-git-publication.js";
import { taskPublicationFixture } from "../fixtures/task-publication-fixture.js";
import { candidateHash } from "../../src/task-candidate-artifact-codec.js";
import { TaskPublicationGit } from "../../src/task-publication-git.js";
import { PinnedDirectory } from "../../src/task-workspace-directory.js";
import { openPublicationWriteDirectories } from "../../src/task-publication-sandbox.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() { const f = await taskPublicationFixture(); cleanups.push(f.cleanup); return f; }

it("anchors host-side directory preparation when the checked Git path is swapped", async () => {
  const f = await fixture(); const other = await fixture();
  const common = await PinnedDirectory.open(join(f.root, ".git"));
  const check = common.check.bind(common); let swapped = false;
  common.check = async () => {
    await check();
    if (!swapped) {
      swapped = true;
      await rename(join(f.root, ".git"), join(f.root, ".git-original"));
      await symlink(join(other.root, ".git"), join(f.root, ".git"));
    }
  };
  try {
    await expect(openPublicationWriteDirectories(common)).rejects.toThrow();
    expect(await readdir(join(other.root, ".git/refs/heads"))).not.toContain("codex");
  } finally { await common.handle.close(); }
});

it("rejects a Git repository redirected after certification before the first publication open", async () => {
  const f = await fixture(); const other = await fixture(); const input = await f.certify();
  other.git(["fetch", f.root, f.plan.repository.baseline_commit]);
  other.git(["update-ref", "HEAD", f.plan.repository.baseline_commit]);
  await rename(join(f.root, ".git"), join(f.root, ".git-original"));
  await writeFile(join(f.root, ".git"), `gitdir: ${join(other.root, ".git")}\n`);
  await expect(publishTaskGitCandidate(input)).rejects.toThrow();
  expect(() => other.git(["rev-parse", "--verify", f.plan.publication.ref])).toThrow();
});

it("does not publish through a filesystem symlink in the Git ref parents", async () => {
  const f = await fixture(); const other = await fixture(); const input = await f.certify();
  await symlink(join(other.root, ".git/refs/heads"), join(f.root, ".git/refs/heads/codex"));
  await expect(publishTaskGitCandidate(input)).rejects.toThrow();
  expect(() => other.git(["rev-parse", "--verify", "refs/heads/fixture-result"])).toThrow();
});

it("blocks writes outside the Git mounts through an object fanout symlink", async () => {
  const f = await fixture(); const other = await fixture(); const input = await f.certify();
  const foreign = join(other.root, "foreign-objects"); await mkdir(foreign);
  const blob = f.git(["hash-object", "--stdin"], "export const answer = 42;\n");
  const fanout = join(f.root, ".git/objects", blob.slice(0, 2));
  await rename(fanout, `${fanout}-original`).catch(error => { if (error.code !== "ENOENT") throw error; });
  await symlink(foreign, fanout);
  await expect(publishTaskGitCandidate(input)).rejects.toThrow();
  expect(await readdir(foreign)).toEqual([]);
  expect(() => f.git(["rev-parse", "--verify", f.plan.publication.ref])).toThrow();
});

it("does not report a matching ref from a substituted repository during recovery", async () => {
  const f = await fixture(); const other = await fixture(); const input = await f.certify();
  const result = await publishTaskGitCandidate(input);
  other.git(["fetch", f.root, result.commit]); other.git(["update-ref", result.ref, result.commit]);
  await rename(join(f.root, ".git"), join(f.root, ".git-original"));
  await writeFile(join(f.root, ".git"), `gitdir: ${join(other.root, ".git")}\n`);
  await expect(inspectTaskGitPublication(f.db, "execute")).rejects.toThrow("TASK_PUBLICATION_GIT_IDENTITY_CHANGED");
});

it("publishes the approved code change while preserving HEAD, index and concurrent working changes", async () => {
  const f = await fixture(); const input = await f.certify();
  const indexBefore = await readFile(join(f.root, ".git/index"));
  await writeFile(join(f.root, "unrelated.txt"), "concurrent edit\n");
  const result = await publishTaskGitCandidate(input);
  expect(result.state).toBe("candidate_published"); expect(result.ref).toBe(f.plan.publication.ref);
  expect(f.git(["rev-parse", result.ref])).toBe(result.commit);
  expect(f.git(["rev-parse", "HEAD"])).toBe(f.plan.repository.baseline_commit);
  expect(await readFile(join(f.root, ".git/index"))).toEqual(indexBefore);
  expect(await readFile(join(f.root, "answer.mjs"), "utf8")).toBe(f.source);
  expect(await readFile(join(f.root, "unrelated.txt"), "utf8")).toBe("concurrent edit\n");
  expect(f.git(["show", `${result.commit}:answer.mjs`])).toBe("export const answer = 42;");
  expect(f.git(["show", `${result.commit}:unrelated.txt`])).toBe("keep baseline");
  expect(f.git(["diff", "--name-only", f.plan.repository.baseline_commit, result.commit])).toBe("answer.mjs");
  expect(f.db.db.prepare("SELECT state,commit_oid FROM task_git_publications").get()).toEqual({ state: "published", commit_oid: result.commit });
  const journalBefore = f.db.db.prepare("SELECT * FROM task_git_publications").get();
  expect(() => f.db.db.exec("UPDATE task_git_publications SET binding_json='{}'")).toThrow();
  expect(() => f.db.db.exec("DELETE FROM task_git_publications")).toThrow("immutable task publication");
  expect(() => f.db.db.exec("INSERT OR REPLACE INTO task_git_publications SELECT * FROM task_git_publications"))
    .toThrow();
  expect(() => f.db.db.exec("UPDATE task_git_publications SET state='building',published_at=NULL"))
    .toThrow("invalid task publication transition");
  expect(f.db.db.prepare("SELECT * FROM task_git_publications").get()).toEqual(journalBefore);
  await expect(publishTaskGitCandidate(input)).rejects.toThrow("TASK_PUBLICATION_ALREADY_BOUND");
});

it.each(["existing", "symbolic", "dangling_symbolic"])("does not replace an %s ref or follow its target", async scenario => {
  const f = await fixture(); const input = await f.certify(); const target = "refs/heads/unapproved-target";
  if (scenario === "existing") f.git(["update-ref", f.plan.publication.ref, f.plan.repository.baseline_commit]);
  else {
    if (scenario === "symbolic") f.git(["update-ref", target, f.plan.repository.baseline_commit]);
    f.git(["symbolic-ref", f.plan.publication.ref, target]);
  }
  await expect(publishTaskGitCandidate(input)).rejects.toThrow();
  if (scenario !== "existing") expect(f.git(["symbolic-ref", f.plan.publication.ref])).toBe(target);
  if (scenario !== "dangling_symbolic") expect(f.git(["rev-parse", f.plan.publication.ref])).toBe(f.plan.repository.baseline_commit);
  else expect(() => f.git(["rev-parse", "--verify", target])).toThrow();
  expect(f.db.db.prepare("SELECT state FROM task_git_publications").get()).toEqual({ state: "uncertain" });
  expect(await inspectTaskGitPublication(f.db, "execute")).toMatchObject({ state: "uncertain", observation: "ref_conflict" });
});

it.each(["candidate_only", "failed_checks"])("rejects %s before creating a publication reservation", async scenario => {
  const f = await fixture(); const { publication: omitted, ...base } = f.plan; void omitted;
  const plan = scenario === "candidate_only" ? { ...base, schema_version: 1 as const, mode: "isolated_candidate" as const } : f.plan;
  const input = await f.certify(plan, scenario === "failed_checks");
  await expect(publishTaskGitCandidate(input)).rejects.toThrow("TASK_PUBLICATION_AUTHORITY_INVALID");
  expect(f.db.db.prepare("SELECT count(*) AS n FROM task_git_publications").get()).toEqual({ n: 0 });
});

it("rejects a read input that differs from the Git baseline used by the result commit", async () => {
  const f = await fixture(); const changed = f.check + "// uncommitted dependency\n";
  await writeFile(join(f.root, "check.mjs"), changed);
  const input = await f.certify({ ...f.plan, files: f.plan.files.map(file => file.access === "read"
    ? { ...file, before_digest: candidateHash(changed) } : file) });
  await expect(publishTaskGitCandidate(input)).rejects.toThrow("TASK_PUBLICATION_TREE_INVALID");
  expect(() => f.git(["rev-parse", "--verify", f.plan.publication.ref])).toThrow();
});

it("disables the repository reference-transaction hook when publishing", async () => {
  const f = await fixture(); const input = await f.certify();
  const hook = join(f.root, ".git/hooks/reference-transaction");
  await mkdir(join(f.root, ".git/hooks"));
  await writeFile(hook, "#!/bin/sh\nexit 91\n"); await chmod(hook, 0o700);
  const result = await publishTaskGitCandidate(input);
  expect(f.git(["rev-parse", result.ref])).toBe(result.commit);
});

it("retains the expected commit for read-only recovery when ref creation succeeds but SQL completion fails", async () => {
  const f = await fixture(); const input = await f.certify();
  f.db.db.exec(`CREATE TRIGGER fixture_fail_published BEFORE UPDATE ON task_git_publications
    WHEN NEW.state='published' BEGIN SELECT RAISE(ABORT,'fixture completion failure'); END`);
  await expect(publishTaskGitCandidate(input)).rejects.toThrow("TASK_PUBLICATION_FAILED");
  const before = f.db.db.prepare("SELECT total_changes() AS n").get();
  const observed = await inspectTaskGitPublication(f.db, "execute");
  expect(observed).toMatchObject({ state: "uncertain", observation: "ref_matches", observed_commit: observed!.expected_commit });
  expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  await expect(publishTaskGitCandidate(input)).rejects.toThrow();
});

it("rolls back the prepared publication when authority expires before the ref effect", async () => {
  const f = await fixture(); const input = await f.certify(); let now = f.now;
  f.db.db.function("expire_publication_fixture", () => { now = new Date(input.command.lease_expires_at); return 1; });
  f.db.db.exec(`CREATE TRIGGER fixture_expire_prepared AFTER UPDATE ON task_git_publications
    WHEN NEW.state='prepared' BEGIN SELECT expire_publication_fixture(); END`);
  await expect(publishTaskGitCandidate({ ...input, clock: () => now })).rejects.toThrow();
  expect(await inspectTaskGitPublication(f.db, "execute")).toMatchObject({ state: "uncertain", observation: "ref_absent", expected_commit: null });
});

it("rejects replacement of the Git directory before a plumbing mutation", async () => {
  const f = await fixture(); const other = await fixture();
  const git = await TaskPublicationGit.open(f.root, () => 10000, f.now.toISOString());
  try {
    await rename(join(f.root, ".git"), join(f.root, ".git-original"));
    await writeFile(join(f.root, ".git"), `gitdir: ${join(other.root, ".git")}\n`);
    await expect(git.run(["hash-object", "-w", "--stdin"], Buffer.from("unexpected foreign write"))).rejects.toThrow();
  } finally { await git.close(); }
});

it("rejects a new file below a baseline symlink without publishing an out-of-scope parent change", async () => {
  const f = await fixture();
  await symlink("unrelated.txt", join(f.root, "nested")); f.git(["add", "nested"]); f.git(["commit", "-qm", "symlink baseline"]);
  const baseline = f.git(["rev-parse", "HEAD"]);
  await unlink(join(f.root, "nested")); await mkdir(join(f.root, "nested"));
  const input = await f.certify({ ...f.plan, repository: { ...f.plan.repository, baseline_commit: baseline },
    files: [...f.plan.files, { path: "nested/new.mjs", access: "write", before_digest: null }] });
  await expect(publishTaskGitCandidate(input)).rejects.toThrow();
  expect(() => f.git(["rev-parse", "--verify", f.plan.publication.ref])).toThrow();
});
