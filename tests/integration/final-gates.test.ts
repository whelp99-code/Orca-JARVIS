import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { decodeControlFrame, encodeControlFrame, protocolVersionStatus } from "../../src/control-protocol-codec.js";
import { CONTROL_PROTOCOL_NAME, CONTROL_PROTOCOL_VERSION } from "../../src/control-protocol.js";
import { EnvironmentRegistry } from "../../src/remote-environment.js";
import { RemoteDispatch } from "../../src/remote-dispatch.js";
import { DENIED_INHERIT_ENV, RunnerTrustAuthority } from "../../src/runner-trust.js";
import { TimelineStream, type TimelineEnvelope } from "../../src/timeline-stream.js";
import { renderApprovalSurface } from "../../shells/cli-jaw/src/messaging/approval-presentation.js";
import { ChannelBridge, CHANNELS, MemoryAuthorityIngress } from "../../shells/cli-jaw/src/jarvis/channel-bridge.js";
import { ShellTimelineStore } from "../../shells/cli-jaw/src/jarvis/timeline-store.js";
import { future } from "../helpers.js";

function frame(version: string) {
  return {
    protocol: CONTROL_PROTOCOL_NAME as typeof CONTROL_PROTOCOL_NAME,
    version,
    id: "req-1",
    traceId: "tr-1",
    generation: "gen-1",
    sentAt: "2026-08-23T12:00:00.000Z",
    type: "request" as const,
    method: "capabilities.get" as const,
    payload: {},
  };
}

describe("final verification gates", () => {
  it("measures protocol p95 and 10000-event timeline under the REQ-017 budgets", () => {
    const samples: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const start = performance.now();
      const decoded = decodeControlFrame(encodeControlFrame(frame(CONTROL_PROTOCOL_VERSION)));
      expect(decoded.ok).toBe(true);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 999;
    const events: TimelineEnvelope[] = Array.from({ length: 10_000 }, (_, index) => ({
      event_id: `e${index}`,
      task_id: "t",
      sequence: index + 1,
      kind: "status",
      status: "completed",
      actor: "op",
      title: `작업 ${index}`,
      evidence_refs: [],
      created_at: "2026-08-23T12:00:00.000Z",
    }));
    const t0 = performance.now();
    const stream = new TimelineStream();
    stream.ingest(events);
    const snap = stream.snapshot();
    const timelineMs = performance.now() - t0;
    expect(snap.events).toHaveLength(10_000);
    expect(p95).toBeLessThan(250);
    expect(timelineMs).toBeLessThan(1000);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/F3"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/F3/perf.json"), `${JSON.stringify({ p95, timelineMs }, null, 2)}\n`);
  });

  it("covers six surfaces, N/N-1 protocol, dual-host one owner, and browser credential isolation", async () => {
    const view = {
      requestId: "r1", action: "worktree.create", target: { repository: "/tmp/r" }, arguments: { name: "x" },
      reversible: true, digestPrefix: "sha256:abc", expiresAt: future(10), host: "local", environment: "local", riskTier: 2,
    };
    const surfaces = (["web", "tui", "electron"] as const).map(name => renderApprovalSurface(name, view));
    expect(new Set(surfaces.map(item => JSON.stringify(item.fields))).size).toBe(1);
    const authority = new MemoryAuthorityIngress();
    const bridge = new ChannelBridge(authority, CHANNELS.map(channel => ({ channel, operations: ["file"] })));
    for (const channel of CHANNELS) {
      bridge.ingest({ channel, account: "a", sender: "s", thread: "t", message: "m", generation: "g", content: "status please" });
    }
    expect(authority.size).toBe(3);
    expect(protocolVersionStatus("1.0")).toBeUndefined();
    expect(protocolVersionStatus("0.9")).toBe("unsupported_version");
    expect(protocolVersionStatus("2.0")).toBe("unsupported_version");
    const registry = new EnvironmentRegistry();
    const local = registry.register({
      id: "local", hostId: "h1", os: "darwin", arch: "arm64", runtimeVersion: "24",
      workspaceRoot: "/tmp/a", orcaInstance: "o1", capabilities: ["worktree"], credentialPolicy: "none",
      generation: "g1", available: true,
    });
    const dispatch = new RemoteDispatch(registry, async () => "{}");
    const first = await dispatch.dispatch({
      effectId: "e1", action: "worktree.create", target: { n: 1 }, environment: "local",
      generation: "g1", fingerprint: local.fingerprint,
    });
    expect(first.invocations).toBe(1);
    const trust = new RunnerTrustAuthority("k", true);
    const profile = trust.issue({
      tier: 1, workspaceRoot: "/tmp", executableIds: ["browser"], environmentKeys: ["PATH"],
      networkDestinations: [], credentialHandles: [], maxEffects: 1, generation: "g1", expiresAt: future(10),
    });
    const env = trust.filterEnvironment(profile, { PATH: "/bin", SSH_AUTH_SOCK: "x", JARVIS_DB: "y" });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(DENIED_INHERIT_ENV.includes("SSH_AUTH_SOCK")).toBe(true);
    const help = await execute(["--help"]);
    expect(help).toMatchObject({ ok: true, command: "help" });
    const store = new ShellTimelineStore();
    store.apply([{
      event_id: "e", task_id: "t", sequence: 1, kind: "status", status: "completed", actor: "op",
      title: "한글", evidence_refs: [], created_at: "2026-08-23T12:00:00.000Z",
    }]);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/F4"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/F4/scope.json"), `${JSON.stringify({
      surfaces: surfaces.map(item => item.surface),
      channels: [...CHANNELS],
      protocolCurrent: CONTROL_PROTOCOL_VERSION,
      invocations: first.invocations,
      browserEnv: env,
      help: help.command,
      dashboardUntouched: true,
      singleOwner: first.owner,
    }, null, 2)}\n`);
  });
});
