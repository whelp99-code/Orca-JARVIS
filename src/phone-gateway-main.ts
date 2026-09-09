import { PHONE_PROVIDER_CLI_FIELDS, parsePhoneMemoryProviderCli, openPhoneMemoryProviderCli, type PhoneMemoryProviderCliOptions } from "./phone-memory-provider-cli.js";
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PHONE_MEMORY_CLI_FIELDS, parsePhoneMemoryContextCli } from "./phone-memory-context-cli.js";
import type { PhoneMemoryContextOptions } from "./phone-memory-context.js";
import { PHONE_RECONCILE_CLI_FIELDS, parsePhoneMemoryReconcileCli } from "./phone-memory-reconcile-cli.js";
import type { PhoneMemoryReconcileOptions } from "./phone-memory-reconcile.js";
import {
  createPhoneGatewayServer,
  PHONE_GATEWAY_PORT,
  parsePhoneGatewayConfig,
  PhoneGatewayError,
  PHONE_ERROR_CODES,
  type PhoneGatewayServer,
} from "./phone-gateway.js";

const LOOPBACK = "127.0.0.1" as const;
const UPSTREAM = "http://127.0.0.1:4173" as const;

export type PhoneGatewayCliOptions = {
  readonly host: string;
  readonly port: number;
  readonly upstream: string;
  readonly staticRoot: string;
  readonly envFile: string;
  readonly memoryContext?: PhoneMemoryContextOptions;
  readonly memoryReconcile?: PhoneMemoryReconcileOptions;
  readonly memoryProvider?: PhoneMemoryProviderCliOptions;
};

export function parsePhoneGatewayCli(argv: readonly string[]): PhoneGatewayCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      ...Object.fromEntries(PHONE_MEMORY_CLI_FIELDS.map(name => [name, { type: "string" as const }])),
      ...Object.fromEntries(PHONE_RECONCILE_CLI_FIELDS.map(name => [name, { type: "string" as const }])),
      ...Object.fromEntries(PHONE_PROVIDER_CLI_FIELDS.map(name => [name, { type: "string" as const }])),
      host: { type: "string" },
      port: { type: "string" },
      upstream: { type: "string" },
      "static-root": { type: "string" },
      "env-file": { type: "string" },
    },
    strict: true,
  });
  if (values.host !== LOOPBACK) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  if (values.port !== String(PHONE_GATEWAY_PORT)) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  if (values.upstream !== UPSTREAM) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  if (typeof values["static-root"] !== "string" || values["static-root"].length === 0) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  if (typeof values["env-file"] !== "string" || values["env-file"].length === 0) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const memoryContext = parsePhoneMemoryContextCli(values);
  const memoryReconcile = parsePhoneMemoryReconcileCli(values);
  const memoryProvider = parsePhoneMemoryProviderCli(values);
  return {
    host: LOOPBACK,
    port: PHONE_GATEWAY_PORT,
    upstream: UPSTREAM,
    staticRoot: resolve(values["static-root"]),
    envFile: resolve(values["env-file"]),
    ...(memoryContext === undefined ? {} : { memoryContext }),
    ...(memoryReconcile === undefined ? {} : { memoryReconcile }),
    ...(memoryProvider === undefined ? {} : { memoryProvider }),
  };
}

export async function startPhoneGatewayCli(
  options: PhoneGatewayCliOptions,
  write: (line: string) => void = line => { process.stdout.write(`${line}\n`); },
): Promise<{ close: () => void }> {
  const getuid = process.getuid;
  const home = process.env.HOME;
  if (getuid === undefined || home === undefined || home.length === 0) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const uid = getuid();
  const config = parsePhoneGatewayConfig({ home, envFile: options.envFile, uid });
  const provider = options.memoryProvider === undefined ? undefined : await openPhoneMemoryProviderCli(options.memoryProvider);
  let server: PhoneGatewayServer;
  try {
    server = createPhoneGatewayServer({
      host: options.host,
      port: options.port,
      upstream: options.upstream,
      staticRoot: options.staticRoot,
      config,
      memoryContext: options.memoryContext,
      memoryReconcile: options.memoryReconcile,
      memoryProviderVerifier: provider?.options,
    });
  } catch (error) { provider?.close(); throw error; }
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { server.close(); } finally { provider?.close(); } };
  try { write(`http://${server.address.host}:${String(server.address.port)}`); }
  catch (error) { close(); throw error; }
  return { close };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

if (isDirectRun()) {
  try {
    const runtime = await startPhoneGatewayCli(parsePhoneGatewayCli(process.argv.slice(2)));
    const shutdown = (): void => {
      runtime.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (error) {
    const code = error instanceof PhoneGatewayError ? error.code : "PHONE_NOT_READY";
    process.stderr.write(`${code}\n`);
    process.exit(2);
  }
}
