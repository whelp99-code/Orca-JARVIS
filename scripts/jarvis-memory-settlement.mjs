#!/usr/bin/env node
import { AuthorityDb } from "../dist/src/db.js";
import { MemorySettlementService, SecondBrainProviderClient } from "../dist/src/second-brain-provider.js";

const dbPath = process.env.JARVIS_DB;
const outboxId = process.argv[2];
if (!dbPath || !outboxId) { process.stderr.write(`${!dbPath ? "JARVIS_DB_REQUIRED" : "MEMORY_OUTBOX_ID_REQUIRED"}\n`); process.exitCode = 2; }
else {
  const db = new AuthorityDb(dbPath); const provider = new SecondBrainProviderClient({ configPath: process.env.SECOND_BRAIN_PROVIDER_CONFIG, launcherPath: process.env.SECOND_BRAIN_PROVIDER_BIN });
  try {
    await db.migrate();
    await db.assertMigrationsReady();
    const service = new MemorySettlementService({
      source: db.db,
      provider,
      owner: process.env.JARVIS_WORKER_ID ?? `memory-settlement:${process.pid}`,
    });
    process.stdout.write(`${JSON.stringify(await service.settle(outboxId))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "MEMORY_SETTLEMENT_FAILED";
    const code = /^[A-Z][A-Z0-9_]+$/u.test(message) ? message : "MEMORY_SETTLEMENT_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  } finally {
    await provider.close().catch(() => undefined);
    db.close();
  }
}
