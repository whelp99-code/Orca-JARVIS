import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChannelBridge, CHANNELS, MemoryAuthorityIngress, type InboundEnvelope } from "../../shells/cli-jaw/src/jarvis/channel-bridge.js";

function envelope(channel: InboundEnvelope["channel"], overrides: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    channel,
    account: "acct-1",
    sender: "user-1",
    thread: "thread-1",
    message: "msg-1",
    generation: "gen-1",
    content: `please create worktree via ${channel}`,
    ...overrides,
  };
}

describe("channel bridge contract", () => {
  it("keeps one authority request per channel across crash redelivery", () => {
    const authority = new MemoryAuthorityIngress();
    const bridge = new ChannelBridge(authority, CHANNELS.map(channel => ({ channel, operations: ["file"] })));
    const receipts = [];
    for (const channel of CHANNELS) {
      bridge.setShellPersist(false);
      const first = bridge.ingest(envelope(channel));
      expect(first.acked).toBe(false);
      const replay = bridge.redeliver(envelope(channel));
      receipts.push({ channel, requestId: replay.requestId, replayed: replay.replayed, first: first.requestId });
      expect(replay.requestId).toBe(first.requestId);
    }
    expect(authority.size).toBe(3);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/09/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/09/happy/receipts.json"), `${JSON.stringify({ liveAccounts: false, receipts }, null, 2)}\n`);
  });

  it("rejects undeclared ops, mutated callbacks, and inventories legacy claims", () => {
    const authority = new MemoryAuthorityIngress();
    const bridge = new ChannelBridge(authority, [{ channel: "telegram", operations: ["file"] }]);
    const first = bridge.ingest(envelope("telegram"));
    expect(bridge.invoke("telegram", "interactive").code).toBe("unsupported");
    expect(bridge.invoke("telegram", "file").code).toBe("ok");
    const mutations = ["account", "sender", "thread", "message", "generation"] as const;
    const rejected = mutations.map(field => bridge.resolveCallback(envelope("telegram"), envelope("telegram", { [field]: "mutated" })));
    expect(rejected.every(item => item.ok === false && item.jarvisCalled === false)).toBe(true);
    expect(authority.size).toBe(1);
    const legacy = bridge.inventoryLegacy([
      { claimId: "legacy-1", state: "pending", mappedRequestId: first.requestId },
      { claimId: "legacy-2", state: "inflight" },
    ]);
    expect(legacy).toEqual([
      { claimId: "legacy-1", result: "mapped" },
      { claimId: "legacy-2", result: "blocked" },
    ]);
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/09"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/09/failure.json"), `${JSON.stringify({
      authorityRequests: authority.size,
      rejected,
      legacy,
    }, null, 2)}\n`);
  });
});
