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
import { planTeamProposal } from "../team-proposal.js";
import { defaultRunner } from "../orca.js";
import { bindDashboardMemoryDependencies } from "./memory-production.js";
import { composeRemoteApproval } from "../remote-approval-compose.js";
import { createDashboardServer } from "./server.js";
import { MemoryOutboxTick } from "../memory-outbox-tick.js";
import { parseTrustedCloseoutKey } from "../evening-closeout-crypto.js";
import type { TrustedCloseoutKey } from "../evening-closeout-types.js";
import { parseNativeEveningSourceConfig, type NativeEveningSourceConfig } from "../evening-native-source.js";
import { createPriceFinanceRuntime } from "../integration/price-finance-production.js";

const LOOPBACK = "127.0.0.1";

export type DashboardCliOptions = {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly staticRoot: string;
  readonly policyPath?: string;
  readonly trustedCloseoutKey?: TrustedCloseoutKey;
  readonly nativeCloseoutSource?: NativeEveningSourceConfig;
  readonly priceReadCredentialPath?: string;
};

function configuredCloseoutKey(value: unknown): TrustedCloseoutKey | undefined {
  if (value === undefined) return undefined;
  try { return parseTrustedCloseoutKey(value); }
  catch { throw new JarvisError("VALIDATION_ERROR"); }
}

function configuredNativeSource(value: unknown, key?: TrustedCloseoutKey): NativeEveningSourceConfig | undefined {
  if (value === undefined) return undefined;
  try {
    if (key === undefined) throw new Error("closeout key required");
    return parseNativeEveningSourceConfig(value);
  } catch { throw new JarvisError("VALIDATION_ERROR"); }
}

export type DashboardMemoryDependencies = {
  readonly memoryReadFenceConfig?: import("../memory-read-fence-production.js").MemoryReadFenceProductionConfig;
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
      policy: { type: "string" },
      "closeout-key-id": { type: "string" },
      "closeout-public-key-spki": { type: "string" },
      "native-closeout-source": { type: "string" },
      "price-read-credential": { type: "string" },
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
  if (values.policy !== undefined && values.policy.length === 0) throw new JarvisError("VALIDATION_ERROR");
  const trustedCloseoutKey = configuredCloseoutKey(
    values["closeout-key-id"] === undefined && values["closeout-public-key-spki"] === undefined
      ? undefined : { key_id: values["closeout-key-id"], public_key_spki: values["closeout-public-key-spki"] });
  let source: unknown;
  if (values["native-closeout-source"] !== undefined) {
    try {
      if (Buffer.byteLength(values["native-closeout-source"]) > 8192) throw new Error("config too large");
      source = JSON.parse(values["native-closeout-source"]);
    } catch { throw new JarvisError("VALIDATION_ERROR"); }
  }
  const nativeCloseoutSource = configuredNativeSource(source, trustedCloseoutKey);
  return { host: LOOPBACK, port, dbPath: resolve(values.db), staticRoot: resolve(values["static-root"]),
    ...(values["price-read-credential"] === undefined ? {} : { priceReadCredentialPath: values["price-read-credential"] }),
    ...(trustedCloseoutKey === undefined ? {} : { trustedCloseoutKey }),
    ...(nativeCloseoutSource === undefined ? {} : { nativeCloseoutSource }),
    ...(values.policy === undefined ? {} : { policyPath: resolve(values.policy) }) };
}

export function startDashboardCli(options: DashboardCliOptions, write: (line: string) => void = line => {
  process.stdout.write(`${line}\n`);
}, memoryLifecycle?: Pick<MemoryLifecycleService, "execute">,
  dependencies: DashboardMemoryDependencies = {}): { close: () => Promise<void> } {
  const trustedCloseoutKey = configuredCloseoutKey(options.trustedCloseoutKey);
  const nativeCloseoutSource = configuredNativeSource(options.nativeCloseoutSource, trustedCloseoutKey);
  const priceFinance = options.priceReadCredentialPath === undefined ? undefined
    : createPriceFinanceRuntime(options.priceReadCredentialPath);
  const db = new AuthorityDb(options.dbPath);
  const remoteApproval = (() => {
    try { return composeRemoteApproval(db, { policyPath: options.policyPath }); }
    catch (error) { db.close(); throw error; }
  })();
  const bound = (() => {
    try { return bindDashboardMemoryDependencies(db, dependencies); }
    catch (error) { db.close(); throw error; }
  })();
  const outbox = bound.outboxFor(db);
  const tick = outbox === undefined ? undefined : new MemoryOutboxTick(
    () => outbox.runOnce("dashboard-memory-outbox", 1),
    code => process.stderr.write(`${JSON.stringify({ component: "memory.outbox", error_code: code })}\n`),
    () => server.publish(["memory.effects.v1", "memory.records.v1", "memory.candidates.v1", "approvals", "overview"]));
  const server = createDashboardServer({
    db,
    priceFinance,
    trustedCloseoutKey,
    nativeCloseoutSource,
    staticRoot: options.staticRoot,
    host: options.host,
    port: options.port,
    orcaRunner: defaultRunner,
    capabilityProbe: runtimeCapabilityProbe(),
    planner: planTeamProposal,
    memoryLifecycle,
    memoryAdapter: bound.memoryAdapter,
    memoryProjectionKey: bound.memoryProjectionKey,
    memoryEffectSpoolRoot: bound.memoryEffectSpoolRoot,
    memoryCandidateReviewSpoolRoot: bound.memoryCandidateReviewSpoolRoot,
    memoryCandidateDispatchSpoolRoot: bound.memoryCandidateDispatchSpoolRoot,
    executorFactory: bound.executorFactory,
    clock: dependencies.memoryAdapterOptions?.clock,
    memoryReconcileTick: tick === undefined ? undefined : () => tick.tick(),
    remoteApproval,
  });
  write(`http://${server.address.host}:${String(server.address.port)}`);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    server.close();
    closing = (async () => {
      await Promise.all([tick?.close(), server.drain()]);
      await priceFinance?.close();
      if (bound.ownedProviderTransport !== undefined) await bound.ownedProviderTransport.close();
      db.close();
    })();
    return closing;
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
      void runtime.close().then(() => process.exit(0), () => process.exit(2));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    const code = error instanceof JarvisError ? error.code : "INTERNAL_ERROR";
    process.stderr.write(`${code}\n`);
    process.exit(2);
  }
}
