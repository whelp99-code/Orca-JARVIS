import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { MemoryExportSaga } from "../../src/memory-export-saga.js";
import { signCommandApproval } from "../../src/control-plane.js";
import { correctionPreparedFixture } from "../fixtures/memory-correction-control.js";
import { deletionPreparedFixture } from "../fixtures/memory-deletion-recovery.js";
import { localKey } from "../helpers.js";

const outcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claimed"), fence: z.number() }),
  z.object({ kind: z.literal("no_effect"), code: z.enum(["CONTROL_CLAIM_RACE", "CONTROL_APPROVAL_REQUIRED"]) }),
]);

describe("32-process production control claim", () => {
  it.each(["correction", "deletion", "export"] as const)("has one winner and typed losers for %s", async lane => {
    // Given: one signed approval and 32 real independently opened connections behind an event barrier.
    const f = await (lane === "deletion" ? deletionPreparedFixture() : correctionPreparedFixture());
    const action = lane === "export" ? await new MemoryExportSaga(f.runtime).prepare({
      export_id: "memexp:v1:race", correlation_id: "correlation:race", provider_instance_id: f.target.provider_instance_id,
      targets: [f.target], scope: { ...f.scope, format: "json" }, requested_at: f.runtime.clock(),
      expires_at: new Date(f.action.expires_at), nonce: "nonce:export-race",
    }) : f.action;
    const input = { ...action, request_id: `race:${lane}`, nonce: `race:${lane}` };
    const staged = f.control.stage(input, f.runtime.clock());
    f.control.decide(signCommandApproval({ schema_version: 1, receipt_id: `approval:race:${lane}`,
      request_id: input.request_id, decision: "approve", command_digest: staged.command_digest,
      signer_principal_id: "principal:owner", authenticated_session_id: "race", key_id: "decision-test",
      algorithm: "Ed25519", issued_at: f.runtime.clock().toISOString(), not_before: f.runtime.clock().toISOString(),
      expires_at: input.expires_at, nonce: `approval:race:${lane}`, max_uses: 1, status: "issued",
    }, localKey(f.db)), f.runtime.clock());
    const workers = Array.from({ length: 32 }, (_, index) => {
      const child = spawn(process.execPath, [resolve("tests/fixtures/memory-control-race-worker.mjs"),
        f.db.filename, input.request_id, f.runtime.clock().toISOString(), `worker:${index}`]);
      const lines = createInterface({ input: child.stdout });
      const ready = once(lines, "line", { signal: AbortSignal.timeout(15_000) });
      const exited = once(child, "exit", { signal: AbortSignal.timeout(20_000) });
      child.stdin.write("ARM\n");
      return { child, lines, ready, exited };
    });
    try {
      expect((await Promise.all(workers.map(worker => worker.ready))).every(([line]) => line === "READY")).toBe(true);
      // When: all claimants cross the same release barrier.
      const results = workers.map(worker => once(worker.lines, "line", { signal: AbortSignal.timeout(15_000) }));
      workers.forEach(worker => worker.child.stdin.end("GO\n"));
      const frames = (await Promise.all(results)).map(([line]) => String(line));
      expect(frames.every(line => outcome.safeParse(JSON.parse(line)).success), frames.join("\n")).toBe(true);
      const rows = frames.map(line => outcome.parse(JSON.parse(line)));
      await Promise.all(workers.map(worker => worker.exited));
      // Then: exactly one fence/redemption, only typed no-effect losers, no duplicate authority effect.
      expect(rows.filter(row => row.kind === "claimed")).toEqual([{ kind: "claimed", fence: 1 }]);
      expect(rows.filter(row => row.kind === "no_effect")).toHaveLength(31);
      expect(f.db.db.prepare("SELECT count(*) AS count FROM control_command_redemptions WHERE request_id=?")
        .get(input.request_id)).toEqual({ count: 1 });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM control_command_effects WHERE request_id=?")
        .get(input.request_id)).toEqual({ count: 0 });
    } finally {
      for (const worker of workers) {
        worker.lines.close();
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
      }
      await Promise.all(workers.map(worker => worker.exited));
      await f.close();
    }
  }, 30_000);
});
