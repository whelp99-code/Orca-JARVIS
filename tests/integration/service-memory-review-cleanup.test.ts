import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { execute } from "../../src/cli.js";
import { MemoryCandidateReviewSpool } from "../../src/memory-candidate-review-spool.js";
import { readMemoryCandidate } from "../../src/memory-candidate-reader.js";
import { outboxFixture } from "../fixtures/memory-outbox-fixture.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";

it("cleans expired source files through service once and reports cleanup errors independently", async () => {
  const f = await outboxFixture();
  try {
    const root = `${f.database.root}/candidate-review`;
    const path = new MemoryCandidateReviewSpool(root).paths()[0]!;
    const candidate = readMemoryCandidate(f.database.authority.db, f.request.candidate_id)!;
    const args = ["service", "once", "--db", f.database.path, "--memory-review-cleanup-root", root];
    const now = new Date(candidate.candidate_expires_at);
    const bytes = readFileSync(path);
    writeFileSync(path, "{}");
    expect(await execute(args, { clock: () => now })).toMatchObject({ state: "disconnected",
      memory_review_cleanup: { status: "partial", scanned: 1, failed: 1, removed: 0 } });
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, bytes);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import {execute} from './dist/src/cli.js'; console.log(JSON.stringify(await execute(JSON.parse(process.argv[1]), "
        + "{clock:()=>new Date(process.argv[2])})));", JSON.stringify(args), now.toISOString()],
    { encoding: "utf8", timeout: 10000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ state: "disconnected",
      memory_review_cleanup: { status: "processed", removed: 1, failed: 0 } });
    expect(existsSync(path)).toBe(false);
  } finally { closeMemoryDatabase(f.database); }
});

it("rejects unsupported cleanup configuration without making a spool", async () => {
  const f = await outboxFixture();
  try {
    const root = `${f.database.root}/missing`;
    for (const args of [
      ["service", "status", "--memory-review-cleanup-root", root],
      ["service", "once", "--memory-review-cleanup-limit", "2"],
      ["service", "once", "--memory-review-cleanup-root", root],
    ]) await expect(execute([...args, "--db", f.database.path])).rejects
      .toMatchObject({ code: "MEMORY_REVIEW_CLEANUP_CONFIG_INVALID" });
    expect(existsSync(root)).toBe(false);
    vi.stubEnv("PERSONAL_OS_CONTROL_CHANNEL", `${f.database.root}/channel.sock`);
    await expect(execute(["service", "run", "--once", "--db", f.database.path,
      "--memory-review-cleanup-root", `${f.database.root}/candidate-review`])).rejects
      .toMatchObject({ code: "MEMORY_REVIEW_CLEANUP_CONFIG_INVALID" });
  } finally { vi.unstubAllEnvs(); closeMemoryDatabase(f.database); }
});

it("rejects replacement of a configured root before first scan without repairing it", async () => {
  const f = await outboxFixture();
  try {
    const { inspectPrivateSpoolRoot } = await import("../../src/memory-private-spool-files.js");
    const { MemoryReviewCleanupScanner } = await import("../../src/memory-review-cleanup-scanner.js");
    const { renameSync, mkdirSync, statSync } = await import("node:fs");
    const root = `${f.database.root}/candidate-review`;
    const scanner = new MemoryReviewCleanupScanner(f.database.authority, root, inspectPrivateSpoolRoot(root));
    try {
      renameSync(root, `${root}-original`);
      expect(() => scanner.cycle(f.clock.now)).toThrow();
      expect(existsSync(root)).toBe(false);
      mkdirSync(root, { mode: 0o755 });
      expect(() => scanner.cycle(f.clock.now)).toThrow("MEMORY_SPOOL_ROOT_CHANGED");
      expect(statSync(root).mode & 0o777).toBe(0o755);
    } finally { scanner.close(); }
  } finally { closeMemoryDatabase(f.database); }
});

it("resumes cleanup batches in service run and closes the scanner when the loop returns", async () => {
  const f = await outboxFixture();
  const { GjcRuntimeService } = await import("../../src/service.js");
  const { MemoryReviewCleanupScanner } = await import("../../src/memory-review-cleanup-scanner.js");
  const batches: unknown[] = [];
  const cycle = vi.spyOn(MemoryReviewCleanupScanner.prototype, "cycle");
  const close = vi.spyOn(MemoryReviewCleanupScanner.prototype, "close");
  const run = vi.spyOn(GjcRuntimeService.prototype, "run").mockImplementation(async (_interval, _stop, tick) => {
    if (!tick) throw new Error("missing service callback");
    batches.push(await tick(), await tick());
  });
  try {
    const root = `${f.database.root}/candidate-review`;
    for (let i = 0; i < 4; i++) writeFileSync(`${root}/${i}.txt`, "ignored");
    await execute(["service", "run", "--db", f.database.path,
      "--memory-review-cleanup-root", root, "--memory-review-cleanup-limit", "2"], { clock: () => f.clock.now });
    expect(batches).toHaveLength(2);
    for (const batch of batches) expect(batch).toMatchObject({ state: "disconnected",
      memory_review_cleanup: { scanned: 2, failed: 0, removed: 0, scan_complete: false } });
    expect(close).toHaveBeenCalledTimes(1);
    const scanner = cycle.mock.contexts[0] as InstanceType<typeof MemoryReviewCleanupScanner>;
    expect(() => scanner.cycle(f.clock.now)).toThrow("MEMORY_REVIEW_CLEANUP_CLOSED");
  } finally { run.mockRestore(); cycle.mockRestore(); close.mockRestore(); closeMemoryDatabase(f.database); }
});
