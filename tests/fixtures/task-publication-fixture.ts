import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { taskExecutionFixture } from "./task-execution-fixture.js";
import { verifierKey } from "../helpers.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import type { TaskExecutionPlanV2 } from "../../src/task-execution-plan.js";
import { readTaskExecutionInputs } from "../../src/task-execution-workspace.js";
import { candidateHash } from "../../src/task-candidate-artifact-codec.js";
import { TaskCandidateArtifacts } from "../../src/task-candidate-artifacts.js";
import { ControlEffectAttempts } from "../../src/control-effect-attempts.js";
import { TaskCandidateCertifications } from "../../src/task-candidate-certifications.js";
import { signTaskCertification } from "../../src/task-certification-proof.js";
import { verifyTaskCandidate } from "../../src/task-candidate-verification.js";
import { inspectTaskPublicationIdentity } from "../../src/task-publication-git.js";

export async function taskPublicationFixture() {
  const f = await taskExecutionFixture();
  const root = await mkdtemp(join(tmpdir(), "jarvis-publication-fixture-"));
  const git = (args: string[], input?: string) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    encoding: "utf8", input, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd();
  git(["-c", "init.templateDir=", "init", "-q"]);
  const source = "export const answer = 41;\n";
  const check = "import {answer} from './answer.mjs'; if (answer !== 42) process.exit(1);\n";
  await writeFile(join(root, "answer.mjs"), source); await writeFile(join(root, "check.mjs"), check);
  await writeFile(join(root, "unrelated.txt"), "keep baseline\n");
  git(["add", "answer.mjs", "check.mjs", "unrelated.txt"]); git(["-c", "commit.gpgsign=false", "commit", "-qm", "baseline"]);
  const plan: TaskExecutionPlanV2 = { ...f.plan, schema_version: 2, mode: "verified_git_commit",
    publication: { ref: "refs/heads/codex/fixture-result", repository_identity: await inspectTaskPublicationIdentity(root) },
    repository: { root, baseline_commit: git(["rev-parse", "HEAD"]) },
    files: [{ path: "answer.mjs", access: "write", before_digest: candidateHash(source) },
      { path: "check.mjs", access: "read", before_digest: candidateHash(check) }],
    verification: [{ id: "answer", argv: ["node", "check.mjs"], cwd: ".", expected_exit: 0 }] };
  async function certify(value: TaskExecutionPlanV2 | typeof f.plan = plan, failed = false) {
    f.approve(stageTaskExecution(f.db, { ...f.request, plan: value }, f.now));
    const command = f.control.claim("execute", "publication-fixture", f.now);
    const source = await readTaskExecutionInputs(value);
    const effects = new ControlEffectAttempts(f.db); effects.prepareTask(command, () => f.now); effects.beginTaskInvocation(command, () => f.now);
    const files = source.files.map(file => ({ path: file.path, content: file.access === "write"
      ? Buffer.from("export const answer = 42;\n") : file.content! }));
    const store = new TaskCandidateArtifacts(f.db);
    store.save(command, { files, repository: source.check, provider_output_bytes: 0 }, () => f.now);
    const measurement = await verifyTaskCandidate(value, files, async () => ({ exit_code: failed ? 1 : 0,
      stdout_bytes: 0, stderr_bytes: 0, stdout_digest: candidateHash(""), stderr_digest: candidateHash("") }));
    store.recordVerification(command, measurement, () => f.now);
    const certs = new TaskCandidateCertifications(f.db); const request = certs.prepare(command, "verifier-test", () => f.now);
    const invocation = certs.begin(command, request.verification_id, () => f.now);
    certs.record(command, request.verification_id, invocation.invocation_id, signTaskCertification({ schema_version: 1,
      request, invocation_id: invocation.invocation_id, measurement, principal_id: "independent-verifier", algorithm: "Ed25519",
      issued_at: f.now.toISOString() }, verifierKey(f.db)), () => f.now);
    return { authority: f.db, command, verification_id: request.verification_id, clock: () => f.now };
  }
  const cleanup = async () => { f.db.close(); await rm(root, { recursive: true, force: true });
    await rm(dirname(f.db.filename), { recursive: true, force: true }); };
  return { ...f, root, git, plan, source, check, certify, cleanup };
}
