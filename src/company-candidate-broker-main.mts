import { execFile } from "node:child_process";
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
  caller_group_id: z.int().min(0).max(2_147_483_647).optional(),
}).strict();

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

/** Apply the credential ownership/mode gate before spawning the pinned SB executable. */
function readSecureConfig(path: string): string {
  try {
    if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
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
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || (directory.uid !== uid && directory.uid !== 0)
      || ((directory.mode & 0o022) !== 0 && (directory.mode & 0o1000) === 0)) {
      fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
    }
    if (parent === "/") break;
  }
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
  try {
    lstatSync(parsed.data.socket);
    fail("COMPANY_CANDIDATE_BROKER_SOCKET_EXISTS");
  } catch (error) {
    if (error instanceof CompanyCandidateBrokerError) throw error;
  }
  return parsed.data;
}

const authoritySchema = z.object({
  schema_version: z.literal(1),
  provider_instance_id: z.string().min(1).max(128),
  workspace_id: z.string().min(1).max(128),
  principal_id: z.string().min(1).max(128),
  agent_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
  projects: z.array(z.string().min(1).max(128)).max(128),
  policy_revision: z.string().min(1).max(256),
  purpose: z.string().min(1).max(64),
  operation: z.enum(["handoff", "accept", "reject", "mark_processed"]),
  request_digest: z.string().min(1).max(80),
  deletion_sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  deletion_set_root: z.string().min(1).max(80),
  issued_at: z.string().min(1).max(64),
  expires_at: z.string().min(1).max(64),
  nonce: z.string().min(1).max(128),
  signing_key_id: z.string().min(1).max(128),
  signature: z.string().min(1).max(256),
}).strict();

const envelopeSchema = z.object({
  authority: authoritySchema,
  arguments: z.record(z.string(), z.unknown()),
}).strict();

function pinnedAction(role: BrokerRole, operation: z.infer<typeof authoritySchema>["operation"]): "handoff" | "process" {
  if (role === "handoff") return operation === "handoff" ? "handoff" : fail("COMPANY_CANDIDATE_BROKER_REFUSED");
  if (operation === "accept" || operation === "reject" || operation === "mark_processed") return "process";
  return fail("COMPANY_CANDIDATE_BROKER_REFUSED");
}

function childEnv(): NodeJS.ProcessEnv {
  const home = userInfo().homedir;
  if (!home.startsWith("/")) fail("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID");
  return { PATH: "/usr/bin:/bin", HOME: home };
}

function runPinned(config: BrokerConfig, action: "handoff" | "process", stdin: Buffer): Promise<string> {
  assertPinnedExecutable(config.sb_company_bin);
  return new Promise((resolve, reject) => {
    const child = execFile(config.sb_company_bin, [action, "--config", config.sb_config_file], {
      shell: false,
      timeout: TIMEOUT_MS,
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
      child.kill("SIGTERM");
    });
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
  const sockets = new Set<Socket>();
  const closeServer = (target: Server) => new Promise<void>((resolve) => {
    target.close(() => resolve());
  });
  const broker: CompanyCandidateBroker = {
    async close() {
      if (closed) return;
      closed = true;
      server.removeAllListeners("connection");
      for (const socket of sockets) socket.destroy();
      if (server.listening) await closeServer(server);
      unlinkOwned(config.socket, created);
      created = false;
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

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (active >= MAX_CLIENTS) {
      socket.end(REFUSED, () => socket.destroy());
      return;
    }
    active += 1;
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let dispatching = false;
    const finish = (body: string) => {
      if (settled) return;
      settled = true;
      active -= 1;
      clearTimeout(timer);
      if (!socket.destroyed) socket.end(body, () => socket.destroy());
    };
    const releaseIfIdle = () => {
      if (!dispatching) finish(REFUSED);
    };
    const timer = setTimeout(releaseIfIdle, TIMEOUT_MS);
    socket.once("close", () => {
      releaseIfIdle();
    });
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BYTES) finish(REFUSED);
      else chunks.push(chunk);
    });
    socket.on("error", releaseIfIdle);
    socket.on("end", () => {
      if (settled || dispatching) return;
      dispatching = true;
      clearTimeout(timer);
      void dispatch(Buffer.concat(chunks)).then(
        (body) => finish(body),
        () => finish(REFUSED),
      );
    });
  });

  async function dispatch(raw: Buffer): Promise<string> {
    let parsed: unknown;
    try {
      parsed = parseCompanyJsonBytes(raw);
      if (parsed === undefined) return REFUSED;
    } catch {
      return REFUSED;
    }
    const envelope = envelopeSchema.safeParse(parsed);
    if (!envelope.success) return REFUSED;
    const action = pinnedAction(config.role, envelope.data.authority.operation);
    return runPinned(config, action, raw);
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
