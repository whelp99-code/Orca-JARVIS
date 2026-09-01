import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AuthorityDb, JarvisError } from "../db.js";
import type { SecondBrainAdapterOptions, SecondBrainReadAdapter } from "../second-brain-adapter-types.js";
import type { SecondBrainTransport, SecondBrainTransportOptions } from "../second-brain-transport.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service-types.js";
import type { DashboardExecutorFactory } from "./authority-service.js";
import { runtimeCapabilityProbe } from "../doctor.js";
import { defaultRunner } from "../orca.js";
import { bindDashboardMemoryDependencies } from "./memory-production.js";
import { composeRemoteApproval } from "../remote-approval-compose.js";
import { createDashboardServer } from "./server.js";

const LOOPBACK = "127.0.0.1";

export type DashboardCliOptions = {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly staticRoot: string;
};

export type DashboardMemoryDependencies = {
  readonly memoryAdapter?: SecondBrainReadAdapter;
  readonly memoryProjectionKey?: Buffer;
  readonly memoryEffectSpoolRoot?: string;
  readonly memoryCandidateReviewSpoolRoot?: string;
  readonly memoryCandidateDispatchSpoolRoot?: string;
  readonly providerTransport?: SecondBrainTransport;
  readonly providerTransportOptions?: SecondBrainTransportOptions;
  readonly memoryAdapterOptions?: Omit<SecondBrainAdapterOptions, "transport">;
  readonly executorFactory?: DashboardExecutorFactory;
};

export function parseDashboardCli(argv: readonly string[]): DashboardCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      host: { type: "string" },
      port: { type: "string" },
      db: { type: "string" },
      "static-root": { type: "string" },
    },
    strict: true,
  });
  if (values.host !== LOOPBACK) throw new JarvisError("LOCAL_SESSION_REQUIRED");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new JarvisError("VALIDATION_ERROR");
  if (typeof values.db !== "string" || values.db.length === 0) throw new JarvisError("VALIDATION_ERROR");
  if (typeof values["static-root"] !== "string" || values["static-root"].length === 0) {
    throw new JarvisError("VALIDATION_ERROR");
  }
  return { host: LOOPBACK, port, dbPath: resolve(values.db), staticRoot: resolve(values["static-root"]) };
}

export function startDashboardCli(options: DashboardCliOptions, write: (line: string) => void = line => {
  process.stdout.write(`${line}\n`);
}, memoryLifecycle?: Pick<MemoryLifecycleService, "execute">,
  dependencies: DashboardMemoryDependencies = {}): { close: () => void } {
  const db = new AuthorityDb(options.dbPath);
  const bound = bindDashboardMemoryDependencies(options.dbPath, dependencies);
  const server = createDashboardServer({
    db,
    staticRoot: options.staticRoot,
    host: options.host,
    port: options.port,
    orcaRunner: defaultRunner,
    capabilityProbe: runtimeCapabilityProbe(),
    memoryLifecycle,
    memoryAdapter: bound.memoryAdapter,
    memoryProjectionKey: bound.memoryProjectionKey,
    memoryEffectSpoolRoot: bound.memoryEffectSpoolRoot,
    memoryCandidateReviewSpoolRoot: bound.memoryCandidateReviewSpoolRoot,
    memoryCandidateDispatchSpoolRoot: bound.memoryCandidateDispatchSpoolRoot,
    executorFactory: bound.executorFactory,
    remoteApproval: composeRemoteApproval(db),
  });
  write(`http://${server.address.host}:${String(server.address.port)}`);
  const close = (): void => {
    server.close();
    if (bound.ownedProviderTransport !== undefined) void bound.ownedProviderTransport.close();
    db.close();
  };
  return { close };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  try {
    const runtime = startDashboardCli(parseDashboardCli(process.argv.slice(2)));
    const shutdown = (): void => {
      runtime.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    const code = error instanceof JarvisError ? error.code : "INTERNAL_ERROR";
    process.stderr.write(`${code}\n`);
    process.exit(2);
  }
}
