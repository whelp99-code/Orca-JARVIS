import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RemoteDispatch, logicalEffectKey } from "../../src/remote-dispatch.js";
import { EnvironmentRegistry, environmentFingerprint } from "../../src/remote-environment.js";

function env(id: "local" | "jm-server", available = true, extras: { generation?: string; hostId?: string; capabilities?: string[] } = {}) {
  return {
    id,
    hostId: extras.hostId ?? `${id}-host`,
    os: "darwin",
    arch: "arm64",
    runtimeVersion: "24.19.0",
    workspaceRoot: id === "local" ? "/Volumes/DevSpace/Orca-JARVIS" : "/home/jm/orca-jarvis",
    orcaInstance: `${id}-orca`,
    capabilities: extras.capabilities ?? ["worktree"],
    credentialPolicy: "local-only",
    generation: extras.generation ?? "gen-1",
    available,
  };
}

describe("fenced remote dispatch", () => {
  it("binds one lease owner per environment for reversible fixture work", async () => {
    const registry = new EnvironmentRegistry();
    const local = registry.register(env("local"));
    const jm = registry.register(env("jm-server", true, { capabilities: ["worktree", "jm-only"] }));
    const calls: string[][] = [];
    const dispatch = new RemoteDispatch(registry, async args => {
      calls.push([...args]);
      return JSON.stringify({ ok: true });
    });
    const localReq = { effectId: "fx-local", action: "worktree.create", target: { name: "a" }, environment: "local" as const, generation: "gen-1", fingerprint: local.fingerprint };
    const jmReq = { effectId: "fx-jm", action: "worktree.create", target: { name: "b" }, environment: "jm-server" as const, generation: "gen-1", fingerprint: jm.fingerprint };
    const localDone = await dispatch.dispatch(localReq);
    const jmDone = await dispatch.dispatch(jmReq);
    expect(localDone).toMatchObject({ owner: "local", state: "completed", invocations: 1 });
    expect(jmDone).toMatchObject({ owner: "jm-server", state: "completed", invocations: 1 });
    expect(calls.every(args => args.includes("--environment") && !args.join(" ").includes("ssh"))).toBe(true);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/11/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/11/happy/receipts.json"), `${JSON.stringify({ local: localDone, jm: jmDone, calls }, null, 2)}\n`);
  });

  it("turns post-invoke lease loss into terminal uncertain and refuses transfer/stale settle", async () => {
    const registry = new EnvironmentRegistry();
    const local = registry.register(env("local"));
    const jm = registry.register(env("jm-server", false, { capabilities: ["jm-only"] }));
    const dispatch = new RemoteDispatch(registry, async () => JSON.stringify({ ok: true }));
    const req = { effectId: "fx-part", action: "worktree.create", target: { name: "c" }, environment: "local" as const, generation: "gen-1", fingerprint: local.fingerprint };
    const invoked = await dispatch.dispatch(req, "after-invoke");
    expect(invoked.state).toBe("invoked");
    const lost = dispatch.loseLease(invoked.effectKey);
    expect(lost.state).toBe("uncertain");
    expect(lost.invocations).toBe(1);
    expect(() => dispatch.transfer(invoked.effectKey, "jm-server")).toThrow("REMOTE_TRANSFER_DISABLED");
    expect(() => dispatch.settle(invoked.effectKey, "gen-2", "late")).toThrow("ENVIRONMENT_STALE_GENERATION");
    const waiting = await dispatch.dispatch({
      effectId: "fx-wait",
      action: "worktree.create",
      target: { name: "d" },
      environment: "jm-server",
      generation: "gen-1",
      fingerprint: jm.fingerprint,
      exclusiveCapability: "jm-only",
    });
    expect(waiting.state).toBe("waiting_environment");
    const changed = env("local", true, { hostId: "local-host-2" });
    expect(() => registry.require("local", environmentFingerprint(changed), "gen-1")).toThrow("ENVIRONMENT_FINGERPRINT_MISMATCH");
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/11"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/11/partition.json"), `${JSON.stringify({
      invocations: lost.invocations,
      state: lost.state,
      waiting: waiting.state,
      effectKeyOmitsFence: !logicalEffectKey(req).includes("fence"),
    }, null, 2)}\n`);
  });
});
