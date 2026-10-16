import { execFile, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { parseCompanyJson, parseCompanyJsonBytes } from "./company-candidate-json.js";
import { companyBrokerAuthoritySchema as authoritySchema } from "./company-broker-authority.js";
import { parseCompanyFreshnessEnvelope } from "./company-freshness-envelope.js";
import { companyReportArgumentsSchema } from "./company-internal-envelope.js";

const MAX_BYTES = 1_048_576;
const TIMEOUT_MS = 10_000;
const MAX_CLIENTS = 8;
const REFUSED = "{\"error\":\"COMPANY_CANDIDATE_BROKER_REFUSED\"}";

const brokerConfigSchema = z.object({
  schema_version: z.literal(1),
  role: z.enum(["handoff", "processor"]),
  socket: z.string().min(1).max(107),
  sb_company_bin: z.string().min(1).max(4096),
  sb_config_file: z.string().min(1).max(4096),
  freshness_config_file: z.string().min(1).max(4096).startsWith("/").optional(),
  auto_config_file: z.string().min(1).max(4096).startsWith("/").optional(),
  report_config_file: z.string().min(1).max(4096).startsWith("/").optional(),
  caller_group_id: z.int().min(0).max(2_147_483_647).optional(),
}).strict().refine(config => config.role === "processor"
  ? config.report_config_file === undefined
  : config.freshness_config_file === undefined && config.auto_config_file === undefined);

type BrokerConfig = Readonly<z.infer<typeof brokerConfigSchema>>;
type BrokerRole = BrokerConfig["role"];

export class CompanyCandidateBrokerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export type CompanyCandidateBroker = Readonly<{
  close(): Promise<void>;
}>;

function fail(code: string): never {
  throw new CompanyCandidateBrokerError(code);
}

function assertTrustedParents(path: string): void {
  const uid = process.getuid?.();
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || (directory.uid !== uid && directory.uid !== 0)
      || ((directory.mode & 0o022) !== 0 && (directory.mode & 0o1000) === 0)) {
      fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
    }
    if (parent === "/") break;
  }
}

/** Apply the credential ownership/mode gate before spawning the pinned SB executable. */
function readSecureConfig(path: string): string {
  try {
    if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
    assertTrustedParents(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600
        || info.size === 0 || info.size > 65_536) {
        fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
      }
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof CompanyCandidateBrokerError) throw error;
    fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  }
}

function assertPinnedExecutable(path: string): void {
  if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) {
    fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  }
  const info = lstatSync(path);
  const uid = process.getuid?.();
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== uid || (info.mode & 0o022) !== 0
    || (info.mode & 0o111) === 0) {
    fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  }
  assertTrustedParents(path);
}

function loadBrokerConfig(configPath: string): BrokerConfig {
  let raw: unknown;
  try {
    raw = parseCompanyJson(readSecureConfig(configPath));
  } catch (error) {
    if (error instanceof CompanyCandidateBrokerError) throw error;
    fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  }
  const parsed = brokerConfigSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.socket.startsWith("/")
    || !parsed.data.sb_company_bin.startsWith("/")
    || !parsed.data.sb_config_file.startsWith("/")) {
    fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  }
  assertPinnedExecutable(parsed.data.sb_company_bin);
  readSecureConfig(parsed.data.sb_config_file);
  if (parsed.data.freshness_config_file !== undefined) readSecureConfig(parsed.data.freshness_config_file);
  if (parsed.data.auto_config_file !== undefined) readSecureConfig(parsed.data.auto_config_file);
  if (parsed.data.report_config_file !== undefined) readSecureConfig(parsed.data.report_config_file);
  // Default is private0700/0600. Cross-account transport requires an explicitly
  // pinned caller group and a dedicated0710 directory, never a company.db grant.
  const parent = dirname(parsed.data.socket);
  const parentInfo = lstatSync(parent);
  const uid = process.getuid?.();
  const group = parsed.data.caller_group_id;
  const expectedMode = group === undefined ? 0o700 : 0o710;
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || parentInfo.uid !== uid
    || (parentInfo.mode & 0o777) !== expectedMode || realpathSync(parent) !== parent
    || (group !== undefined && parentInfo.gid !== group)) {
    fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  }
  assertTrustedParents(parsed.data.socket);
  try {
    lstatSync(parsed.data.socket);
    fail("COMPANY_CANDIDATE_BROKER_SOCKET_EXISTS");
  } catch (error) {
    if (error instanceof CompanyCandidateBrokerError) throw error;
  }
  return parsed.data;
}

const envelopeSchema = z.object({
  authority: authoritySchema,
  arguments: z.record(z.string(), z.unknown()),
}).strict();

function pinnedAction(role: BrokerRole, operation: z.infer<typeof authoritySchema>["operation"]): "handoff" | "process" {
  if (role === "handoff") return operation === "handoff" ? "handoff" : fail("COMPANY_CANDIDATE_BROKER_REFUSED");
  if (operation === "accept" || operation === "reject" || operation === "mark_processed"
    || operation === "read_transition_receipt") return "process";
  return fail("COMPANY_CANDIDATE_BROKER_REFUSED");
}

function childEnv(): NodeJS.ProcessEnv {
  const home = userInfo().homedir;
  if (!home.startsWith("/")) fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  return { PATH: "/usr/bin:/bin", HOME: home };
}

function runPinned(
  config: BrokerConfig, action: "handoff" | "process" | "freshness" | "auto-internal" | "auto-report", stdin: Buffer,
  children: Map<ChildProcess, Promise<void>>,
): Promise<string> {
  assertPinnedExecutable(config.sb_company_bin);
  const configFile = action === "freshness" ? config.freshness_config_file
    : action === "auto-internal" ? config.auto_config_file
      : action === "auto-report" ? config.report_config_file : config.sb_config_file;
  if (configFile === undefined) fail("COMPANY_CANDIDATE_BROKER_REFUSED");
  readSecureConfig(configFile);
  return new Promise((resolve, reject) => {
    const child = execFile(config.sb_company_bin, [action, "--config", configFile], {
      shell: false,
      timeout: TIMEOUT_MS,
      // A pinned child can ignore SIGTERM. The 10s bound is a hard kill, not a request.
      killSignal: "SIGKILL",
      maxBuffer: MAX_BYTES,
      encoding: "buffer",
      env: childEnv(),
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error || stderr.length > 0 || stdout.length === 0 || stdout.length > MAX_BYTES) {
        reject(new CompanyCandidateBrokerError("COMPANY_CANDIDATE_BROKER_REFUSED"));
        return;
      }
      let raw: unknown;
      try {
        raw = parseCompanyJsonBytes(stdout);
        if (raw === undefined) throw new CompanyCandidateBrokerError("COMPANY_CANDIDATE_BROKER_REFUSED");
      } catch {
        reject(new CompanyCandidateBrokerError("COMPANY_CANDIDATE_BROKER_REFUSED"));
        return;
      }
      if (typeof raw === "object" && raw !== null && "error" in raw) {
        reject(new CompanyCandidateBrokerError("COMPANY_CANDIDATE_BROKER_REFUSED"));
        return;
      }
      resolve(JSON.stringify(raw));
    });
    child.stdin?.on("error", () => {
      child.kill("SIGKILL");
    });
    children.set(child, new Promise<void>(resolve => {
      child.once("close", () => {
        children.delete(child);
        resolve();
      });
    }));
    child.stdin?.end(stdin);
  });
}

function unlinkOwned(socketPath: string, created: boolean): void {
  if (!created) return;
  try {
    const info = lstatSync(socketPath);
    if (!info.isSymbolicLink() && info.isSocket() && info.uid === process.getuid?.()) unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function startCompanyCandidateBroker(
  configPath: string,
  onListening?: (broker: CompanyCandidateBroker) => void,
): Promise<CompanyCandidateBroker> {
  const config = loadBrokerConfig(configPath);
  const server = createServer({ allowHalfOpen: true });
  let active = 0;
  let created = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const children = new Map<ChildProcess, Promise<void>>();
  const closeServer = (target: Server) => new Promise<void>((resolve) => {
    target.close(() => resolve());
  });
  const broker: CompanyCandidateBroker = {
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        server.removeAllListeners("connection");
        for (const socket of sockets) socket.destroy();
        for (const child of children.keys()) child.kill("SIGKILL");
        await Promise.all(children.values());
        if (server.listening) await closeServer(server);
        unlinkOwned(config.socket, created);
        created = false;
      })();
      return closing;
    },
  };
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.socket, () => {
        server.removeListener("error", reject);
        created = true;
        try {
          if (config.caller_group_id !== undefined) {
            const uid = process.getuid?.();
            if (uid === undefined) fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
            chownSync(config.socket, uid, config.caller_group_id);
          }
          chmodSync(config.socket, config.caller_group_id === undefined ? 0o600 : 0o660);
        } catch (error) {
          reject(error);
          return;
        }
        onListening?.(broker);
        resolve();
      });
    });
  } catch (error) {
    try {
      if (server.listening) await closeServer(server);
    } finally {
      if (created) unlinkOwned(config.socket, true);
      created = false;
    }
    if (error instanceof CompanyCandidateBrokerError) throw error;
    fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  } finally {
    process.umask(previous);
  }

  const endBounded = (socket: Socket, body: string) => {
    if (socket.destroyed) return;
    const writeTimer = setTimeout(() => socket.destroy(), TIMEOUT_MS);
    socket.once("close", () => clearTimeout(writeTimer));
    socket.end(body, () => socket.destroy());
  };
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (active >= MAX_CLIENTS) {
      endBounded(socket, REFUSED);
      return;
    }
    active += 1;
    const chunks: Buffer[] = [];
    let total = 0;
    let responded = false;
    let dispatching = false;
    let childDone = false;
    let socketDone = false;
    let holding = true;
    const maybeRelease = () => {
      if (!holding || !childDone || !socketDone) return;
      holding = false;
      active -= 1;
    };
    const markChildDone = () => {
      if (childDone) return;
      childDone = true;
      clearTimeout(timer);
      maybeRelease();
    };
    const beginResponse = (body: string) => {
      if (responded) return;
      responded = true;
      markChildDone();
      if (socket.destroyed) {
        return;
      }
      endBounded(socket, body);
    };
    const releaseIfIdle = () => {
      if (!dispatching) beginResponse(REFUSED);
    };
    const timer = setTimeout(releaseIfIdle, TIMEOUT_MS);
    socket.once("close", () => {
      socketDone = true;
      if (!dispatching) markChildDone();
      maybeRelease();
    });
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) beginResponse(REFUSED);
      else chunks.push(chunk);
    });
    socket.on("error", releaseIfIdle);
    socket.on("end", () => {
      if (responded || dispatching) return;
      dispatching = true;
      clearTimeout(timer);
      void dispatch(Buffer.concat(chunks)).then(
        (body) => beginResponse(body),
        () => beginResponse(REFUSED),
      );
    });
  });

  async function dispatch(raw: Buffer): Promise<string> {
    if (closed) return REFUSED;
    let parsed: unknown;
    try {
      parsed = parseCompanyJsonBytes(raw);
      if (parsed === undefined) return REFUSED;
    } catch {
      return REFUSED;
    }
    if (typeof parsed === "object" && parsed !== null && "method" in parsed) {
      if (config.role !== "processor" || config.freshness_config_file === undefined) return REFUSED;
      try { parseCompanyFreshnessEnvelope(parsed); }
      catch { return REFUSED; }
      return runPinned(config, "freshness", raw, children);
    }
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) return REFUSED;
    const { authority, arguments: args } = envelope.data;
    if (authority.operation === "auto_process_internal") {
      if (config.role !== "processor" || config.auto_config_file === undefined
        || authority.purpose !== "company_internal_auto_trigger"
        || authority.principal_id !== "principal:jarvis-company-progress"
        || !z.object({ limit: z.literal(100) }).strict().safeParse(args).success) return REFUSED;
      return runPinned(config, "auto-internal", raw, children);
    }
    if (authority.operation === "read_auto_report") {
      if (config.role !== "handoff" || config.report_config_file === undefined
        || authority.purpose !== "company_memory_auto_report"
        || authority.principal_id !== "principal:jarvis-company-progress"
        || !companyReportArgumentsSchema.safeParse(args).success) return REFUSED;
      return runPinned(config, "auto-report", raw, children);
    }
    const action = pinnedAction(config.role, envelope.data.authority.operation);
    return runPinned(config, action, raw, children);
  }

  return broker;
}

function main(): void {
  let configPath = "";
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { config: { type: "string" } },
      strict: true,
    });
    if (typeof values.config !== "string" || !values.config.startsWith("/")) {
      fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
    }
    configPath = values.config;
  } catch (error) {
    const code = error instanceof CompanyCandidateBrokerError
      ? error.code
      : "COMPANY_CANDIDATE_BROKER_CONFIG_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
    return;
  }
  let broker: CompanyCandidateBroker | undefined;
  const stop = () => {
    void (broker?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  void startCompanyCandidateBroker(configPath, (listening) => {
    broker = listening;
  }).catch((error: unknown) => {
    const code = error instanceof CompanyCandidateBrokerError
      ? error.code
      : "COMPANY_CANDIDATE_BROKER_CONFIG_INVALID";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) main();
