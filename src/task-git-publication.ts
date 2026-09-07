import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { ControlEffectAttempts } from "./control-effect-attempts.js";
import { TaskPublicationJournal } from "./task-publication-journal.js";
import { TaskPublicationGit } from "./task-publication-git.js";
import { buildTaskPublicationCommit } from "./task-publication-tree.js";

/** Publish verified bytes to the exact new Git ref authorized by a v2 plan, preserving existing refs and working files. */
export async function publishTaskGitCandidate(input: { authority: AuthorityDb; command: ClaimedControlCommand;
  verification_id: string; clock?: () => Date }) {
  const command = structuredClone(input.command); const clock = input.clock ?? (() => new Date());
  const journal = new TaskPublicationJournal(input.authority);
  const initial = journal.begin(command, input.verification_id, clock);
  const id = initial.row.publication_id;
  let git: TaskPublicationGit | undefined;
  try {
    const check = () => journal.current(command, id, ["building", "prepared"], clock).remaining_ms;
    git = await TaskPublicationGit.open(initial.plan.repository.root, check, initial.row.created_at, false, initial.binding.repository_identity);
    const built = await buildTaskPublicationCommit(git, initial.plan, initial.artifact, initial.binding.proof_digest);
    journal.prepared(command, id, built, clock);
    // no-deref prevents a symbolic ref from redirecting the approved name; create is absent-only CAS.
    await git.run(["update-ref", "--no-deref", "--stdin"], Buffer.from(`create ${initial.plan.publication.ref} ${built.commit}\n`));
    const observed = await git.readRef(initial.plan.publication.ref);
    if (observed?.oid !== built.commit || observed.symbolic !== "") throw new JarvisError("TASK_PUBLICATION_REF_CONFLICT");
    const published = journal.published(command, id, built.commit, clock);
    return { state: "candidate_published" as const, published: true as const, publication_id: id,
      artifact_id: initial.artifact.artifact_id, verification_id: input.verification_id,
      ref: initial.plan.publication.ref, baseline_commit: initial.plan.repository.baseline_commit,
      commit: built.commit, tree: built.tree, published_at: published.row.published_at! };
  } catch (error) {
    journal.uncertain(command, id);
    new ControlEffectAttempts(input.authority).markTaskUncertain(command, clock());
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("TASK_PUBLICATION_FAILED");
  } finally { await git?.close(); }
}

/** Observe crash outcomes without resetting the journal, granting a new lease, or recreating a missing ref. */
export async function inspectTaskGitPublication(authority: AuthorityDb, requestId: string) {
  const stored = new TaskPublicationJournal(authority).read(requestId);
  if (!stored) return null;
  const deadline = performance.now() + 5000;
  const git = await TaskPublicationGit.open(stored.binding.root, () => Math.floor(deadline - performance.now()),
    stored.created_at, true, stored.binding.repository_identity);
  try {
    const observed = await git.readRef(stored.binding.ref);
    return { publication_id: stored.publication_id, state: stored.state, ref: stored.binding.ref,
      expected_commit: stored.commit_oid, observed_commit: observed?.oid ?? null,
      observation: observed === null ? "ref_absent" as const : observed.oid === stored.commit_oid && observed.symbolic === ""
        ? "ref_matches" as const : "ref_conflict" as const };
  } finally { await git.close(); }
}
