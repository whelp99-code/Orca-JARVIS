import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VerificationExecutor } from "../../src/verification-executor.js";
import { WorkerLifecycle } from "../../src/worker-lifecycle.js";
import { completionSignal } from "../../shells/cli-jaw/src/jarvis/worker-signals.js";

const identity = { workerId: "w1", sessionId: "s1", generation: "g1", taskId: "t1" };

describe("worker lifecycle and verification", () => {
  it("walks legal states and settles only after allowlisted verification", () => {
    const life = new WorkerLifecycle();
    life.register(identity);
    for (const state of ["starting", "running", "waiting_input", "running", "verifying"] as const) life.transition("w1", state);
    life.signal({ ...identity, sequence: 1, kind: "progress" });
    const idle = life.signal({ ...identity, sequence: 2, kind: "idle" });
    expect(idle.state).toBe("verifying");
    const fixture = join(process.cwd(), "scripts/jarvis-control-handshake.mjs");
    const verifier = new VerificationExecutor([{
      commandId: "node-check",
      executable: process.execPath,
      argvPrefix: ["--check"],
      cwdRoot: process.cwd(),
      envAllow: ["PATH"],
    }]);
    const evidence = verifier.run({
      commandId: "node-check",
      argv: [process.execPath, "--check", fixture],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin" },
      timeoutMs: 10_000,
    });
    life.signal(completionSignal(identity, 3));
    const settled = life.settle("w1", evidence.evidence);
    expect(settled.state).toBe("completed");
    expect(settled.completionEvidence).toBe(evidence.evidence);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/10/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/10/happy/chain.json"), `${JSON.stringify({ states: ["registered", "starting", "running", "waiting_input", "running", "verifying", "completed"], evidence }, null, 2)}\n`);
  });

  it("refuses idle completion, forged identity, bad argv/cwd/env, and illegal transitions", () => {
    const life = new WorkerLifecycle();
    life.register(identity);
    const codes: string[] = [];
    const capture = (fn: () => void) => {
      try { fn(); codes.push("UNEXPECTED"); } catch (error) { codes.push(error instanceof Error ? error.message : "unknown"); }
    };
    capture(() => life.signal({ ...identity, sequence: 1, kind: "completion" }));
    life.transition("w1", "starting");
    life.transition("w1", "running");
    capture(() => life.transition("w1", "completed"));
    capture(() => life.signal({ ...identity, sessionId: "forged", sequence: 1, kind: "progress" }));
    life.signal({ ...identity, sequence: 1, kind: "progress" });
    capture(() => life.signal({ ...identity, sequence: 1, kind: "progress" }));
    capture(() => life.signal({ ...identity, sequence: 3, kind: "progress" }));
    const verifier = new VerificationExecutor([{
      commandId: "node-check",
      executable: process.execPath,
      argvPrefix: ["--check"],
      cwdRoot: process.cwd(),
      envAllow: ["PATH"],
    }]);
    capture(() => verifier.run({ commandId: "nope", argv: [process.execPath], cwd: process.cwd(), env: {}, timeoutMs: 10 }));
    capture(() => verifier.run({ commandId: "node-check", argv: [process.execPath, "--check", "a;rm"], cwd: process.cwd(), env: {}, timeoutMs: 10 }));
    capture(() => verifier.run({ commandId: "node-check", argv: [process.execPath, "--check", "x"], cwd: "/tmp", env: {}, timeoutMs: 10 }));
    capture(() => verifier.run({ commandId: "node-check", argv: [process.execPath, "--check", "x"], cwd: process.cwd(), env: { SSH_AUTH_SOCK: "leak" }, timeoutMs: 10 }));
    expect(codes).toEqual([
      "WORKER_COMPLETION_WITHOUT_VERIFIER",
      "WORKER_TRANSITION_ILLEGAL",
      "WORKER_IDENTITY_FORGED",
      "WORKER_SEQUENCE_DUPLICATE",
      "WORKER_SEQUENCE_GAP",
      "VERIFY_COMMAND_UNREGISTERED",
      "VERIFY_ARGV_INJECTION",
      "VERIFY_CWD_ESCAPE",
      "VERIFY_ENV_LEAK",
    ]);
    expect(life.get("w1")?.state).toBe("running");
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/10"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/10/failure.json"), `${JSON.stringify({ codes, final: life.get("w1")?.state }, null, 2)}\n`);
  });
});
