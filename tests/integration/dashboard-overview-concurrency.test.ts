import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardReadModel } from "../../src/dashboard/read-model.js";
import { ControlPlane } from "../../src/control-plane.js";
import { TaskTimeline } from "../../src/recommendation-timeline.js";
import type { AuthorityDb } from "../../src/db.js";
import type { SecondBrainReadinessObservation } from "../../src/second-brain-readiness.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";
import { MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });
const now = new Date(MEMORY_NOW);
const observation: SecondBrainReadinessObservation = { executable: "missing", configuration: "missing",
  contract_digest: null, protocol_version: null, tools: null, schemas_compatible: false,
  status: "unavailable", doctor: "unavailable", handshake: "unavailable", read_authorization: "unauthorized",
  write_authorization: "disabled", data_state: "unavailable", refresh: { kind: "missing" } };
function stage(authority: AuthorityDb) {
  return new ControlPlane(authority).stage({ schema_version: 1, request_id: "overview-concurrent-command",
    action: "runbook.execute", action_level: 3, target: { environment: "local", runbook_id: "daemon-dead" },
    args: { runbook_id: "daemon-dead", args: { dry_run: true } }, reversible: true, requested_by: "principal:owner",
    requested_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString(),
    nonce: "overview-concurrent-nonce" }, now);
}
describe("overview while a memory UI command commits", () => {
  it("allows another request to stage during a health probe and includes the new pending command", async () => {
    const database = await memoryDatabase();
    let signal!: () => void; let release!: (value: SecondBrainReadinessObservation) => void;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const pending = new Promise<SecondBrainReadinessObservation>(resolve => { release = resolve; });
    const inspect = vi.fn(() => { signal(); return pending; });
    try {
      const overview = new DashboardReadModel(database.authority, { inspect }).overview(now);
      await entered; const command = stage(database.authority); release(observation);
      const result = await overview;
      expect(result.pending_approvals).toEqual(expect.arrayContaining([expect.objectContaining({ request_id: command.request_id })]));
      expect(inspect).toHaveBeenCalledOnce();
    } finally { release(observation); closeMemoryDatabase(database); }
  });
  it("still detects writes inside the synchronous projection", async () => {
    const database = await memoryDatabase();
    try {
      const original = TaskTimeline.prototype.overview;
      vi.spyOn(TaskTimeline.prototype, "overview").mockImplementationOnce(function(this: TaskTimeline, limit?: number) {
        stage(database.authority); return original.call(this, limit);
      });
      await expect(new DashboardReadModel(database.authority, { inspect: async () => observation }).overview(now))
        .rejects.toThrow("DASHBOARD_READ_MUTATED");
      expect(database.authority.db.prepare("SELECT request_id FROM control_command_requests WHERE request_id='overview-concurrent-command'").get())
        .toBeUndefined();
    } finally { closeMemoryDatabase(database); }
  });
  it("computes only one bounded timeline while retaining current pending counts", async () => {
    const database = await memoryDatabase();
    const timeline = vi.spyOn(TaskTimeline.prototype, "overview");
    try {
      stage(database.authority);
      const result = await new DashboardReadModel(database.authority, { inspect: async () => observation }).overview(now);
      expect(timeline.mock.calls).toEqual([[20]]);
      expect(result.cards.find(card => card.id === "pending-approvals")?.value).toBe(1);
      expect(result.generated_at).toBe(now.toISOString());
    } finally { closeMemoryDatabase(database); }
  });
});
