import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { LOCAL_RETENTION_INTERVAL_MS } from "../../src/cli-local-retention.js";
import { PERSONAL_OS_CONTROL_CHANNEL_ENV } from "../../src/personal-os-cycle-channel.js";
import { outboxFixture } from "../fixtures/memory-outbox-fixture.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";

const registryOf = (database: string): string => join(dirname(database), "authority-registry");

it("claims one window per configured interval and reports the lane through service once", async () => {
  const f = await outboxFixture();
  try {
    const config = `${f.database.root}/retention.json`;
    writeFileSync(config, JSON.stringify({ schema_version: 1, retain_ms: 2_592_000_000 }));
    const args = ["service", "once", "--db", f.database.path, "--local-retention-config", config];
    const now = new Date("2026-09-17T00:00:00.000Z");
    const first = await execute(args, { clock: () => now }) as { local_retention: { status: string } };
    // Whatever the environment answers about exclusion, the lane ran and reported itself.
    expect(["processed", "unprovable", "blocked", "failed"]).toContain(first.local_retention.status);
    // The second ask inside the same window is fenced, which is the only thing that proves the
    // service was built with this entry point's interval rather than some default of its own.
    expect(await execute(args, { clock: () => now })).toMatchObject({
      local_retention: { status: "deferred",
        next_at: new Date(now.getTime() + LOCAL_RETENTION_INTERVAL_MS).toISOString() },
    });
  } finally { closeMemoryDatabase(f.database); }
});

it("refuses an unusable configuration before any runtime registers this process", async () => {
  const f = await outboxFixture();
  try {
    const config = `${f.database.root}/retention.json`;
    writeFileSync(config, JSON.stringify({ schema_version: 1, retain_ms: 2_592_000_000 }));
    for (const args of [
      ["service", "status", "--local-retention-config", config],
      ["gjc", "run", "--local-retention-config", config],
      ["service", "once", "--local-retention-config", "relative/retention.json"],
    ]) await expect(execute([...args, "--db", f.database.path])).rejects
      .toMatchObject({ code: "LOCAL_RETENTION_CONFIG_INVALID" });
    process.env[PERSONAL_OS_CONTROL_CHANNEL_ENV] = "cycle";
    try {
      await expect(execute(["service", "once", "--db", f.database.path,
        "--local-retention-config", config])).rejects
        .toMatchObject({ code: "LOCAL_RETENTION_CONFIG_INVALID" });
    } finally { delete process.env[PERSONAL_OS_CONTROL_CHANNEL_ENV]; }
    expect(existsSync(registryOf(f.database.path))).toBe(false);
  } finally { closeMemoryDatabase(f.database); }
});

it("is off when unconfigured: no lane is reported and no registry is made", async () => {
  const f = await outboxFixture();
  try {
    const result = await execute(["service", "once", "--db", f.database.path]);
    expect(result).not.toHaveProperty("local_retention");
    expect(existsSync(registryOf(f.database.path))).toBe(false);
  } finally { closeMemoryDatabase(f.database); }
});
