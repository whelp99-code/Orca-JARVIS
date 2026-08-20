import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { planTeamProposal } from "../../src/team-proposal.js";
import { passiveCapabilityProbe } from "../../src/doctor.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { createFixtureEnv, type FixtureEnv } from "./dashboard-fixture-env.js";
import { seedRichOverview } from "./dashboard-fixture-seed.js";
import { createFixtureOrcaRunner } from "./dashboard-orca-runner.js";
import {
  FIXTURE_HOST,
  type FixtureMetadata,
} from "./dashboard-fixture-ids.js";

export type StartedFixture = {
  readonly env: FixtureEnv;
  readonly server: DashboardServer;
  readonly metadata: FixtureMetadata;
  close(): void;
};

export type StartFixtureInput = {
  readonly host: string;
  readonly port: number;
  readonly staticRoot: string;
  readonly metadataPath: string;
  readonly seed: boolean;
};

function writeMetadata(path: string, metadata: FixtureMetadata): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    url: metadata.url,
    host: metadata.host,
    port: metadata.port,
    dbPath: metadata.dbPath,
    decisionKeyPath: metadata.decisionKeyPath,
    tempRoot: metadata.tempRoot,
    staticRoot: metadata.staticRoot,
    agentId: metadata.agentId,
  }, null, 2)}\n`, { mode: 0o600 });
}

export async function startDashboardFixture(input: StartFixtureInput): Promise<StartedFixture> {
  const env = await createFixtureEnv(input.staticRoot);
  const now = new Date();
  const agentId = input.seed ? await seedRichOverview(env, now) : undefined;
  const server = createDashboardServer({
    db: env.db,
    staticRoot: env.staticRoot,
    host: input.host,
    port: input.port,
    orcaRunner: createFixtureOrcaRunner(env.worktree),
    capabilityProbe: passiveCapabilityProbe(),
    planner: planTeamProposal,
  });
  const metadata: FixtureMetadata = {
    url: `http://${FIXTURE_HOST}:${String(server.address.port)}`,
    host: server.address.host,
    port: server.address.port,
    dbPath: env.dbPath,
    decisionKeyPath: env.decisionKeyPath,
    tempRoot: env.tempRoot,
    staticRoot: env.staticRoot,
    agentId,
  };
  writeMetadata(resolve(input.metadataPath), metadata);
  return {
    env,
    server,
    metadata,
    close(): void {
      server.close();
      env.db.close();
    },
  };
}
