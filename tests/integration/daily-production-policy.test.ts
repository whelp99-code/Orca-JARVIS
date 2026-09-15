// The morning policy's provider endpoint, over the same production chain the compiled `daily
// morning` and configured-service regressions produce from.
//
// The endpoint is derived the way every other consumer derives it - the configured deployment
// roots, which JARVIS_SECOND_BRAIN_LAUNCHER/CONFIG override - so the installed unit reaches the
// provider it ships with instead of withholding every day by construction. "This deployment names
// no provider" is still an answer the policy gives, but it is now the answer to a launcher that is
// not installed rather than to an unset environment variable.
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dailyProductionPolicy } from "../../src/daily-production-policy.js";
import { AuthorityDb } from "../../src/db.js";
import { CLI_AT, installProviderUnderRoots, prepareDailyProductionChain } from "../fixtures/daily-production-chain.js";
import { closeMemoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";

const chains: MemoryDatabase[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const database of chains.splice(0)) closeMemoryDatabase(database);
});

/** The shipped default endpoint, installed where unset roots look and named by no variable. */
async function deployedProvider() {
  const chain = await prepareDailyProductionChain({ ownerDecision: "confirm", ownerAuthorization: true });
  chains.push(chain.database);
  const installed = installProviderUnderRoots(dirname(chain.path), chain.providerConfig);
  vi.stubEnv("JARVIS_SECOND_BRAIN_LAUNCHER", undefined);
  vi.stubEnv("JARVIS_SECOND_BRAIN_CONFIG", undefined);
  for (const [name, value] of Object.entries(installed.environment)) vi.stubEnv(name, value);
  return { ...chain, launcher: installed.launcher };
}

const policyOf = async (path: string) => {
  const db = new AuthorityDb(path);
  try { return await dailyProductionPolicy(db, () => new Date(CLI_AT)); } finally { db.close(); }
};

it("carries a memory reference from the deployed endpoint when the environment names no launcher", async () => {
  const f = await deployedProvider();

  const policy = await policyOf(f.path);

  expect(policy?.policy_decision_ref).toMatch(/^policy:linux:[a-z0-9-]+:daily-morning$/);
  expect(policy?.memory_reference).toBeDefined();
}, 120_000);

// The same deployment, with nothing installed at the resolved path: producing is what stops.
it("withholds the memory when the resolved launcher is not installed", async () => {
  const f = await deployedProvider();
  rmSync(f.launcher);

  const policy = await policyOf(f.path);

  expect(policy?.policy_decision_ref).toMatch(/^policy:linux:[a-z0-9-]+:daily-morning$/);
  expect(policy?.memory_reference).toBeUndefined();
}, 120_000);
