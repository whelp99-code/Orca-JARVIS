import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runPersonalOsProcessStress } from "../../src/personal-os-process-stress.js";
import { personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) removeScratch(root);
});

describe("personal-OS staged-execstart process stress", () => {
  it("completes 10000 event-driven cycles on a real process with one SIGKILL restart", async () => {
    // Given
    const root = personalOsScratch("jarvis-task36-stress-");
    scratchRoots.push(root);

    // When
    const receipt = await runPersonalOsProcessStress({
      isolatedRoot: root,
      worktree: process.cwd(),
      cycleCount: 10_000,
      crashAfterDispatchId: 5_000,
    });

    // Then
    expect(receipt.cycles_requested).toBe(10_000);
    expect(receipt.cycles_completed).toBe(10_000);
    expect(receipt.logical_duplicates).toBe(0);
    expect(receipt.restart_count).toBe(1);
    expect(receipt.runtime_crash_count).toBe(1);
    expect(receipt.active_handles_at_exit).toBe(0);
    expect(receipt.owned_listeners_at_exit).toBe(0);
    expect(receipt.owned_processes_at_exit).toBe(0);
    expect(receipt.runtime_surface).toBe("staged-execstart");
    expect(receipt.child_pids.length).toBeGreaterThanOrEqual(2);
    expect(receipt.child_pids[0]).not.toBe(receipt.child_pids[1]);
    expect(existsSync(receipt.socket_path)).toBe(false);
    const db = new Database(receipt.db_path, { readonly: true, fileMustExist: true });
    const cursor = db.prepare("SELECT last_completed FROM personal_os_cycle_cursor WHERE k=1").get() as {
      readonly last_completed: number;
    };
    db.close();
    expect(cursor.last_completed).toBe(10_000);
  }, 120_000);
});
