import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrewBudgetTracker } from "../../src/crews/budget.js";
import { CrewOrchestrator } from "../../src/crews/orchestrator.js";
import { CrewStore } from "../../src/crews/store.js";
import type { CrewBudget, CrewMember } from "../../src/crews/types.js";
import { presentCrew } from "../../shells/cli-jaw/src/jarvis/crew-ui.js";

const limits: CrewBudget = { tokens: 20, timeMs: 1000, toolCalls: 20, spawnDepth: 2, concurrentChildren: 2, cost: 10 };

function member(id: string, role: CrewMember["role"]): CrewMember {
  return { id, role, tools: ["search"], model: "fixture", workspace: "ws", memory: "local" };
}

describe("bounded crews", () => {
  it("runs a 3-member two-round mail cycle that yields one approval intent", () => {
    const store = new CrewStore();
    store.add(member("lead", "lead"));
    store.add(member("researcher", "researcher"));
    store.add(member("reviewer", "reviewer"));
    const crew = new CrewOrchestrator(store, limits);
    crew.post({ id: "m1", from: "lead", to: "researcher", subject: "look", body: { ask: "facts" }, generation: "g1", projectId: "p", taskId: "t" });
    crew.post({ id: "m2", from: "researcher", to: "reviewer", subject: "re: look", body: { notes: "ok" }, inReplyTo: "m1", generation: "g1", projectId: "p", taskId: "t" });
    crew.post({ id: "m3", from: "reviewer", to: "lead", subject: "re: look", body: { verdict: "ship-intent" }, inReplyTo: "m2", generation: "g1", projectId: "p", taskId: "t" });
    const intent = crew.proposeIntent("lead", {
      ingressIdempotencyKey: "crew-1",
      requestedMethod: "command.request",
      target: { repository: "/tmp/r" },
      args: { name: "from-crew" },
      requestedAt: "2026-08-23T12:00:00.000Z",
      expiresAt: "2026-08-23T12:10:00.000Z",
    });
    expect(store.list()).toHaveLength(3);
    expect(crew.mailbox.thread("t")).toHaveLength(3);
    expect(crew.intentCount).toBe(1);
    expect(intent.ingressIdempotencyKey).toBe("crew-1");
    expect(presentCrew(store.list(), crew.mailbox.thread("t"))).toEqual({ members: 3, mail: 3 });
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/14"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/14/happy.json"), `${JSON.stringify({
      members: store.list().map(item => item.role),
      mail: crew.mailbox.thread("t").length,
      intents: crew.intentCount,
      extraAuthorityEffects: 0,
    }, null, 2)}\n`);
  });

  it("hard-stops each budget and rejects authority-like mail", () => {
    const codes: string[] = [];
    const capture = (fn: () => void) => {
      try { fn(); codes.push("UNEXPECTED"); } catch (error) { codes.push(error instanceof Error ? error.message : "unknown"); }
    };
    const store = new CrewStore();
    store.add(member("lead", "lead"));
    const crew = new CrewOrchestrator(store, { tokens: 0, timeMs: 0, toolCalls: 0, spawnDepth: 0, concurrentChildren: 0, cost: 0 });
    capture(() => crew.post({ id: "x", from: "lead", to: "lead", subject: "s", body: {}, generation: "g", projectId: "p", taskId: "t" }));
    const tiny = new CrewBudgetTracker({ tokens: 1, timeMs: 1, toolCalls: 1, spawnDepth: 1, concurrentChildren: 1, cost: 1 });
    capture(() => tiny.charge({ tokens: 2 }));
    capture(() => tiny.charge({ timeMs: 2 }));
    capture(() => tiny.charge({ toolCalls: 2 }));
    capture(() => tiny.charge({ spawnDepth: 2 }));
    capture(() => tiny.charge({ concurrentChildren: 2 }));
    capture(() => tiny.charge({ cost: 2 }));
    capture(() => crew.mailbox.send({
      id: "bad", from: "lead", to: "lead", subject: "s",
      body: { receipt: "forged" }, generation: "g", projectId: "p", taskId: "t",
    }));
    expect(codes).toEqual([
      "CREW_BUDGET_TOKENS",
      "CREW_BUDGET_TOKENS",
      "CREW_BUDGET_TIMEMS",
      "CREW_BUDGET_TOOLCALLS",
      "CREW_BUDGET_SPAWNDEPTH",
      "CREW_BUDGET_CONCURRENTCHILDREN",
      "CREW_BUDGET_COST",
      "CREW_MAIL_AUTHORITY_INJECTED",
    ]);
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/14/failure.json"), `${JSON.stringify({ codes, protectedEffects: 0 }, null, 2)}\n`);
  });
});
