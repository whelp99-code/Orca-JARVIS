import { execFileSync } from "node:child_process";
import { writeFile, symlink, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { TaskCandidateCertifications } from "../../src/task-candidate-certifications.js";
import { taskCandidateArtifactFixture } from "../fixtures/task-candidate-artifact-fixture.js";
import { untrustedKey, verifierKey } from "../helpers.js";

it.each(["readable", "symlink", "wrong_key", "extra_input"])("actual verifier entry rejects %s before any sandbox measurement", async scenario => {
  const f = await taskCandidateArtifactFixture();
  try {
    f.store.save(f.command, f.input, () => f.now);
    const request = new TaskCandidateCertifications(f.db).prepare(f.command, "verifier-test", () => f.now);
    const keyPath = join(dirname(f.db.filename), "verifier.pem");
    const key = scenario === "wrong_key" ? untrustedKey() : verifierKey(f.db);
    await writeFile(keyPath, key.export({ type: "pkcs8", format: "pem" }), { mode: scenario === "readable" ? 0o644 : 0o600 });
    let selected = keyPath;
    if (scenario === "symlink") { selected = keyPath + ".link"; await symlink(keyPath, selected); }
    const input = { command: f.command, verification_id: request.verification_id,
      ...(scenario === "extra_input" ? { injected: true } : {}) };
    let outcome: { status: number; code: string } | undefined;
    try {
      execFileSync(process.execPath, ["dist/src/task-verifier-main.js", f.db.filename, selected], {
        input: JSON.stringify(input), encoding: "utf8", timeout: 10000, maxBuffer: 4096,
        env: {}, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const failed = error as { status: number; stderr: string; stdout: string };
      expect(failed.stdout).toBe("");
      outcome = { status: failed.status, code: JSON.parse(failed.stderr).error };
    }
    expect(outcome).toEqual({ status: 1,
      code: scenario === "extra_input" ? "TASK_VERIFIER_INPUT_INVALID" : "TASK_CERTIFICATION_KEY_INVALID" });
    expect(f.db.db.prepare("SELECT state,proof_json FROM task_candidate_certifications").get())
      .toEqual({ state: scenario === "wrong_key" ? "uncertain" : "reserved", proof_json: null });
  } finally { f.db.close(); await rm(dirname(f.db.filename), { recursive: true, force: true }); }
}, 15_000);
