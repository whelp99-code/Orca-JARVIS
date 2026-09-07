import { JarvisError } from "./db.js";
import type { TaskExecutionPlanV2 } from "./task-execution-plan.js";
import type { TaskCandidateArtifacts } from "./task-candidate-artifacts.js";
import { candidateHash } from "./task-candidate-artifact-codec.js";
import { TaskPublicationGit } from "./task-publication-git.js";

type Artifact = NonNullable<ReturnType<TaskCandidateArtifacts["read"]>>;
const invalid = (): never => { throw new JarvisError("TASK_PUBLICATION_TREE_INVALID"); };
export function taskGitOid(value: Buffer, length: number): string {
  const oid = value.toString("utf8").trimEnd();
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(oid)) return invalid();
  return oid;
}

async function entries(git: TaskPublicationGit, revision: string, paths: readonly string[]) {
  const raw = await git.run(["ls-tree", "-z", revision, "--", ...paths]);
  const result = new Map<string, { mode: string; oid: string }>();
  for (const entry of raw.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(entry);
    if (!match || !paths.includes(match[3]!) || result.has(match[3]!)) return invalid();
    result.set(match[3]!, { mode: match[1]!, oid: match[2]! });
  }
  return result;
}

/** Build a commit object from the verified bytes using an isolated index. Does not create or update any ref. */
export async function buildTaskPublicationCommit(git: TaskPublicationGit, plan: TaskExecutionPlanV2,
  artifact: Artifact, proofDigest: string): Promise<{ tree: string; commit: string }> {
  const baseline = plan.repository.baseline_commit; const length = baseline.length;
  if (taskGitOid(await git.run(["rev-parse", "--verify", "HEAD"]), length) !== baseline) return invalid();
  const originals = await entries(git, baseline, plan.files.map(file => file.path));
  for (const [index, file] of plan.files.entries()) {
    const original = originals.get(file.path); const captured = artifact.repository.files[index]!;
    if (file.before_digest === null) { if (original) return invalid(); }
    else {
      if (!original || (original.mode === "100755") !== captured.executable) return invalid();
      const bytes = await git.run(["cat-file", "blob", original.oid], undefined, 4 * 1024 * 1024);
      if (bytes.length !== captured.bytes || candidateHash(bytes) !== file.before_digest) return invalid();
    }
  }
  await git.run(["read-tree", baseline]);
  const changes: string[] = [];
  for (const [index, file] of plan.files.entries()) if (file.access === "write") {
    const oid = taskGitOid(await git.run(["hash-object", "-w", "--no-filters", "--stdin"], artifact.files[index]!.content), length);
    changes.push(`${originals.get(file.path)?.mode ?? "100644"} ${oid}\t${file.path}\0`);
  }
  await git.run(["update-index", "-z", "--index-info"], Buffer.from(changes.join("")));
  const tree = taskGitOid(await git.run(["write-tree"]), length);
  const final = await entries(git, tree, plan.files.map(file => file.path));
  for (const [index, file] of plan.files.entries()) {
    const entry = final.get(file.path);
    if (!entry || entry.mode !== (originals.get(file.path)?.mode ?? "100644")) return invalid();
    const bytes = await git.run(["cat-file", "blob", entry.oid], undefined, 4 * 1024 * 1024);
    if (!bytes.equals(artifact.files[index]!.content)) return invalid();
  }
  const diff = (await git.run(["diff-tree", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-r", "-z", baseline, tree]))
    .toString("utf8").split("\0").filter(Boolean);
  const writes = plan.files.filter(file => file.access === "write").map(file => file.path);
  if (diff.length === 0 || diff.some(path => !writes.includes(path))) return invalid();
  const message = `JARVIS verified task ${plan.task_id}\n\nCandidate: ${artifact.candidate_digest}\nVerification: ${proofDigest}\n`;
  const commit = taskGitOid(await git.run(["commit-tree", tree, "-p", baseline], Buffer.from(message)), length);
  const headers = (await git.run(["cat-file", "commit", commit])).toString("utf8").split("\n\n")[0]!.split("\n");
  if (headers.filter(line => line.startsWith("tree ")).join("\n") !== `tree ${tree}`
    || headers.filter(line => line.startsWith("parent ")).join("\n") !== `parent ${baseline}`) return invalid();
  return { tree, commit };
}
