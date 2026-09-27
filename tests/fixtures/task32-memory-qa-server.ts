import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "undici";
import { AuthorityDb } from "../../src/db.js";
import { createSecondBrainReadAdapter } from "../../src/second-brain-adapter.js";
import { createSecondBrainTransport, type SecondBrainTransport } from "../../src/second-brain-transport.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { writeSecondBrainFixtureLauncher } from "./second-brain-transport-harness.js";
import { seedForgottenRemovals, seedTask32QaRows } from "./task32-memory-qa-seed.js";

/**
 * Boots the real built dashboard against a run-owned stdio provider child so
 * browser and curl QA observe production seams rather than route interception.
 */
export type Task32QaScenario = "schema4" | "conflicts" | "no-data" | "offline" | "schema3"
  | "pending-approval" | "applying" | "complete" | "forgotten-removal";

export type Task32QaServer = {
  readonly url: string;
  readonly root: string;
  readonly db: AuthorityDb;
  close(): Promise<void>;
};

const BUDGETS = { max_hits: 8, max_excerpt_bytes: 1_024, max_total_bytes: 65_536,
  max_page_bytes: 1_048_576 } as const;

function providerRoot(root: string, scenario: Task32QaScenario): {
  readonly launcher: string; readonly config: string;
} {
  const target = resolve("tests/fixtures/second-brain-mcp-child.mjs");
  const launcher = join(root, "second-brain-mcp");
  const config = join(root, "provider-config.json");
  const control = join(root, "provider-control");
  const receipt = join(root, "provider-receipt");
  closeSync(openSync(control, "w"));
  closeSync(openSync(receipt, "w"));
  writeSecondBrainFixtureLauncher(launcher, target);
  writeFileSync(config, JSON.stringify({ control, receipt,
    adapterScenario: scenario === "no-data" ? "no-data" : "schema4",
    schema4Conflicts: scenario === "conflicts" }));
  return { launcher, config };
}

function readAdapter(transport: SecondBrainTransport, scenario: Task32QaScenario, clock: () => Date) {
  return createSecondBrainReadAdapter({ transport, budgets: BUDGETS, clock,
    max_age_ms: 7 * 86_400_000, expiry_ms: 30 * 86_400_000,
    contract_profile: scenario === "schema3" ? "schema3-read-only" : "schema4" });
}

function spool(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

async function stageExport(url: string, db: AuthorityDb, attempt?: "reconciling" | "completed"): Promise<void> {
  const session = await request(`${url}/api/v1/session`);
  const parsed: unknown = JSON.parse(await session.body.text());
  const token = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "csrf_token") : undefined;
  if (typeof token !== "string") throw new TypeError("session token required");
  const headers = { "X-JARVIS-CSRF": token, "Content-Type": "application/json", Origin: url };
  const search = await request(`${url}/api/v1/memory/search`, { method: "POST", headers,
    body: JSON.stringify({ schema_version: 1, query: "evidence", limit: 20 }) });
  const body: unknown = JSON.parse(await search.body.text());
  const items = typeof body === "object" && body !== null ? Reflect.get(body, "items") : undefined;
  const first = Array.isArray(items) ? items[0] : undefined;
  if (typeof first !== "object" || first === null) throw new TypeError("search record required");
  const recordToken = Reflect.get(first, "record_token");
  const recordRevision = Reflect.get(first, "record_revision");
  if (typeof recordToken !== "string" || typeof recordRevision !== "string") {
    throw new TypeError("search token required");
  }
  const staged = await request(`${url}/api/v1/memory/records/actions/export`, { method: "POST", headers,
    body: JSON.stringify({ schema_version: 1, intent_id: `memui:intent:v1:${"c".repeat(64)}`,
      record_token: recordToken, record_revision: recordRevision, payload: { format: "json" } }) });
  if (staged.statusCode !== 202) throw new Error(`TASK32_QA_EXPORT_STAGE:${String(staged.statusCode)}`);
  if (attempt !== undefined) {
    db.db.prepare("UPDATE memory_surface_effect_attempts SET state=?,updated_at=?")
      .run(attempt, new Date().toISOString());
  }
}

export async function startTask32QaServer(
  scenario: Task32QaScenario,
  port = 0,
): Promise<Task32QaServer> {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "task32-v7-qa-"));
  const effectRoot = spool(root, "effect-spool");
  const reviewRoot = spool(root, "review-spool");
  const dispatchRoot = spool(root, "dispatch-spool");
  const provider = providerRoot(root, scenario);
  const db = new AuthorityDb(join(root, "authority.db"), resolve("dist/migrations"));
  await db.migrate();
  if (scenario !== "no-data" && scenario !== "offline") seedTask32QaRows(db, reviewRoot);
  const clock = (): Date => new Date();
  const transport = createSecondBrainTransport({
    launcherPath: provider.launcher, configPath: provider.config,
    contractPath: resolve("contracts/second-brain-mcp-v1.json"),
  });
  const memoryAdapter = scenario === "offline" ? undefined : readAdapter(transport, scenario, clock);
  if (scenario === "forgotten-removal" && memoryAdapter !== undefined) {
    await seedForgottenRemovals(db, memoryAdapter);
  }
  const server = createDashboardServer({
    db, staticRoot: resolve("dist/dashboard"), host: "127.0.0.1", port,
    memoryAdapter, memoryProjectionKey: randomBytes(32), memoryEffectSpoolRoot: effectRoot,
    memoryCandidateReviewSpoolRoot: reviewRoot, memoryCandidateDispatchSpoolRoot: dispatchRoot, clock,
  });
  const url = `http://${server.address.host}:${String(server.address.port)}`;
  if (scenario === "pending-approval") await stageExport(url, db);
  if (scenario === "applying") await stageExport(url, db, "reconciling");
  if (scenario === "complete") await stageExport(url, db, "completed");
  return {
    url, root, db,
    async close(): Promise<void> {
      server.close();
      await transport.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
