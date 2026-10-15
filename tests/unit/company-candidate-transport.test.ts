import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from "node:fs";
import net, { createConnection, createServer, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createCompanyClient, type CompanyContext } from "../../src/company-candidate-transport.js";

const FIXED_PRIVATE_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINyiCKGU4D8nebjrzYdRP/Z6Z+531zOwNB2AxeB3uGuw
-----END PRIVATE KEY-----
`;
const FIXED_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAw8Oaa1xG0+2QBud0K0Y2uvSTggQ53og9F07EcKnPV4I=
-----END PUBLIC KEY-----
`;
const NOW = new Date("2026-10-12T00:00:00.000Z");
const CONTEXT: CompanyContext = {
  provider_instance_id: "provider:unit",
  workspace_id: "e7726a7a-804e-4720-bc9f-dd17a8de6b49",
  owner: "principal:owner",
  agent_id: "agent:jarvis",
  session_id: "session:unit",
  projects: ["project:unit"],
  policy_revision: "policy:unit",
  deletion_sequence: 7,
  deletion_set_root: `sha256:${"a".repeat(64)}`,
  processor_principal_id: "principal:processor",
};

const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const children: Array<ReturnType<typeof spawn>> = [];
const reviewPids = new Set<number>();
const BROKER = fileURLToPath(new URL("../../dist/src/company-candidate-broker-main.mjs", import.meta.url));
const REVIEW = fileURLToPath(new URL("../fixtures/company-candidate-broker-review.mjs", import.meta.url));

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const pid of reviewPids) {
    killReviewPid(pid);
  }
  reviewPids.clear();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) resolve();
    else server.close(() => resolve());
  })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join("/tmp", "co-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function writeSecure(path: string, body: string, mode = 0o600): void {
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
}

function clientConfig(root: string, role: "handoff" | "processor", socket: string, keyPath: string) {
  return {
    schema_version: 1,
    role,
    context: CONTEXT,
    socket,
    signing_key_id: "key:unit",
    signing_key_file: keyPath,
  };
}

async function listen(root: string): Promise<{ socketPath: string; received: () => Promise<string> }> {
  const socketPath = join(root, "c.sock");
  const chunks: Buffer[] = [];
  let resolveReceived: (value: string) => void = () => undefined;
  const received = new Promise<string>((resolve) => {
    resolveReceived = resolve;
  });
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      resolveReceived(Buffer.concat(chunks).toString("utf8"));
      socket.end(JSON.stringify({ state: "ok" }));
    });
  });
  servers.push(server);
  server.listen(socketPath);
  await once(server, "listening");
  return { socketPath, received: () => received };
}

describe("company candidate transport", () => {
  it("signs the whole handoff arguments with the company domains", async () => {
    const root = tempRoot();
    const keyPath = join(root, "key.pem");
    writeSecure(keyPath, FIXED_PRIVATE_PEM);
    const { socketPath, received } = await listen(root);
    const configPath = join(root, "client.json");
    writeSecure(configPath, JSON.stringify(clientConfig(root, "handoff", socketPath, keyPath)));
    const client = createCompanyClient(configPath, "handoff");
    expect(client.publicKeyPem).toBe(FIXED_PUBLIC_PEM);
    expect(client.keyId).toBe("key:unit");
    const args = { limit: 1, offset: 0, approval: { receipt_id: "receipt:fixed" } };
    await client.call("handoff", args, NOW);
    const raw = await received();
    const request = JSON.parse(raw) as {
      authority: Record<string, unknown> & { signature: string };
      arguments: unknown;
    };
    const { signature, ...unsigned } = request.authority;
    const digest = `sha256:${createHash("sha256")
      .update("second-brain/company-memory-request/v1\0")
      .update(canonicalize({ operation: "handoff", arguments: args }))
      .digest("hex")}`;
    expect(request.arguments).toEqual(args);
    expect(unsigned.request_digest).toBe(digest);
    expect(unsigned.purpose).toBe("company_memory_handoff");
    expect(unsigned.principal_id).toBe(CONTEXT.owner);
    expect(unsigned.expires_at).toBe("2026-10-12T00:01:00.000Z");
    expect(unsigned.nonce).toMatch(/^jarvis:[0-9a-f-]{36}$/);
    expect(verify(
      null,
      Buffer.from(`second-brain/company-memory-authority/v1\0${canonicalize(unsigned)}`),
      createPublicKey(FIXED_PUBLIC_PEM),
      Buffer.from(signature, "base64url"),
    )).toBe(true);
  });

  it("binds processor calls to the processor principal and refuses the other role", async () => {
    const root = tempRoot();
    const keyPath = join(root, "key.pem");
    writeSecure(keyPath, FIXED_PRIVATE_PEM);
    const { socketPath, received } = await listen(root);
    const processorPath = join(root, "processor.json");
    const handoffPath = join(root, "handoff.json");
    writeSecure(processorPath, JSON.stringify(clientConfig(root, "processor", socketPath, keyPath)));
    writeSecure(handoffPath, JSON.stringify(clientConfig(root, "handoff", socketPath, keyPath)));
    const processor = createCompanyClient(processorPath, "processor");
    const handoff = createCompanyClient(handoffPath, "handoff");
    await processor.call("accept", { candidate_id: "candidate:1", handoff_id: "handoff:1" }, NOW);
    const raw = await received();
    const request = JSON.parse(raw) as { authority: { principal_id: string; purpose: string } };
    expect(request.authority.principal_id).toBe(CONTEXT.processor_principal_id);
    expect(request.authority.purpose).toBe("company_memory_accept");
    expect(() => handoff.call("accept", {})).toThrow(expect.objectContaining({
      code: "COMPANY_CANDIDATE_OPERATION_DENIED",
    }));
    expect(() => processor.call("handoff", { limit: 1, offset: 0 })).toThrow(expect.objectContaining({
      code: "COMPANY_CANDIDATE_OPERATION_DENIED",
    }));
  });

  it("rejects loose credentials and non-Ed25519 keys", () => {
    const root = tempRoot();
    const keyPath = join(root, "key.pem");
    writeSecure(keyPath, FIXED_PRIVATE_PEM);
    const socketPath = join(root, "c.sock");
    const publicPath = join(root, "public.json");
    writeSecure(publicPath, JSON.stringify(clientConfig(root, "handoff", socketPath, keyPath)), 0o644);
    expect(() => createCompanyClient(publicPath, "handoff")).toThrow(expect.objectContaining({
      code: "COMPANY_CANDIDATE_CREDENTIAL_INVALID",
    }));
    const securePath = join(root, "client.json");
    writeSecure(securePath, JSON.stringify(clientConfig(root, "handoff", socketPath, keyPath)));
    const link = join(root, "link.json");
    symlinkSync(securePath, link);
    expect(() => createCompanyClient(link, "handoff")).toThrow(expect.objectContaining({
      code: "COMPANY_CANDIDATE_CREDENTIAL_INVALID",
    }));
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPath = join(root, "rsa.pem");
    writeSecure(rsaPath, rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const rsaConfig = join(root, "rsa.json");
    writeSecure(rsaConfig, JSON.stringify(clientConfig(root, "handoff", socketPath, rsaPath)));
    expect(() => createCompanyClient(rsaConfig, "handoff")).toThrow(expect.objectContaining({
      code: "COMPANY_CANDIDATE_CREDENTIAL_INVALID",
    }));
    expect(() => createCompanyClient(securePath, "processor")).toThrow(expect.objectContaining({
      code: "COMPANY_CANDIDATE_CONFIG_INVALID",
    }));
  });

  it("refuses an error response without copying its body", async () => {
    const root = tempRoot();
    const keyPath = join(root, "key.pem");
    writeSecure(keyPath, FIXED_PRIVATE_PEM);
    const socketPath = join(root, "c.sock");
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("data", () => undefined);
      socket.on("end", () => socket.end(JSON.stringify({ error: "secret-path:/var/lib/company.db" })));
    });
    servers.push(server);
    server.listen(socketPath);
    await once(server, "listening");
    const configPath = join(root, "client.json");
    writeSecure(configPath, JSON.stringify(clientConfig(root, "handoff", socketPath, keyPath)));
    const client = createCompanyClient(configPath, "handoff");
    await expect(client.call("handoff", { limit: 1, offset: 0 }, NOW)).rejects.toEqual(
      expect.objectContaining({ code: "COMPANY_CANDIDATE_CALL_REFUSED", message: "COMPANY_CANDIDATE_CALL_REFUSED" }),
    );
  });
});

function brokerFixture(role: "handoff" | "processor", scriptBody: string) {
  const root = tempRoot();
  const bin = join(root, "sb-company");
  const sbConfig = join(root, "sb.json");
  const brokerConfig = join(root, "broker.json");
  const socketPath = join(root, "b.sock");
  const log = join(root, "child.log");
  writeSecure(bin, scriptBody.replaceAll("__LOG__", log), 0o755);
  chmodSync(bin, 0o755);
  writeSecure(sbConfig, "{\"schema_version\":1}\n");
  writeSecure(brokerConfig, JSON.stringify({
    schema_version: 1,
    role,
    socket: socketPath,
    sb_company_bin: bin,
    sb_config_file: sbConfig,
  }));
  return { root, bin, sbConfig, brokerConfig, socketPath, log };
}

const CHILD = `#!/bin/bash
{
  printf 'argv:'
  printf ' %s' "$@"
  printf '\\nHOME=%s\\nPATH=%s\\n' "$HOME" "$PATH"
  env | sort
  printf 'stdin:'
  cat
} > __LOG__
printf '%s' '{"state":"ok"}'
`;

function readBroker(socketPath: string, payload: unknown): Promise<string> {
  const socket = createConnection(socketPath);
  socket.on("error", () => undefined);
  sockets.push(socket);
  const chunks: Buffer[] = [];
  const response = new Promise<string>((resolve, reject) => {
    const signal = AbortSignal.timeout(5_000);
    const fail = () => reject(new Error("broker response timed out"));
    signal.addEventListener("abort", fail, { once: true });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      signal.removeEventListener("abort", fail);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  socket.end(JSON.stringify(payload));
  return response;
}

function isBrokerHandle(value: unknown): value is { close(): Promise<void> } {
  return typeof value === "object" && value !== null && "close" in value && typeof value.close === "function";
}

function spawnBroker(configPath: string, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["--experimental-strip-types", BROKER, "--config", configPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  children.push(child);
  return child;
}

function socketReady(root: string, socketPath: string, expectedMode = 0o600): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => existsSync(socketPath) && (statSync(socketPath).mode & 0o777) === expectedMode;
    const timer = setTimeout(() => { watcher.close(); reject(new Error("socket did not appear")); }, 5_000);
    const watcher = watch(root, () => {
      if (!ready()) return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
    if (ready()) {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
  });
}

function rememberPid(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) reviewPids.add(pid);
}

function killReviewPid(pid: number): void {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ESRCH") throw error;
  }
}

async function loadBroker(configPath: string): Promise<{ close(): Promise<void> }> {
  const loaded: unknown = await import(pathToFileURL(BROKER).href);
  if (typeof loaded !== "object" || loaded === null || !("startCompanyCandidateBroker" in loaded)
    || typeof loaded.startCompanyCandidateBroker !== "function") throw new Error("compiled broker export missing");
  const broker: unknown = await loaded.startCompanyCandidateBroker(configPath);
  if (!isBrokerHandle(broker)) throw new Error("compiled broker handle missing");
  return broker;
}

function capturePid(socket: Socket): void {
  let buf = "";
  socket.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const line = buf.split("\n")[0] ?? "";
    if (/^\d+$/.test(line)) rememberPid(Number(line));
  });
}

function handoffEnvelope(): {
  authority: Record<string, unknown>;
  arguments: { limit: number; offset: number };
} {
  return {
    authority: {
      schema_version: 1,
      provider_instance_id: "provider:unit",
      workspace_id: CONTEXT.workspace_id,
      principal_id: CONTEXT.owner,
      agent_id: CONTEXT.agent_id,
      session_id: CONTEXT.session_id,
      projects: ["project:unit"],
      policy_revision: "policy:unit",
      purpose: "company_memory_handoff",
      operation: "handoff",
      request_digest: `sha256:${"b".repeat(64)}`,
      deletion_sequence: 7,
      deletion_set_root: CONTEXT.deletion_set_root,
      issued_at: NOW.toISOString(),
      expires_at: "2026-10-12T00:01:00.000Z",
      nonce: "jarvis:fixed-nonce",
      signing_key_id: "key:unit",
      signature: "c2ln",
    },
    arguments: { limit: 1, offset: 0 },
  };
}

function readBrokerBounded(socketPath: string, payload: unknown, budgetMs: number): Promise<string> {
  const socket = createConnection(socketPath);
  socket.on("error", () => undefined);
  sockets.push(socket);
  const chunks: Buffer[] = [];
  const response = new Promise<string>((resolve, reject) => {
    const signal = AbortSignal.timeout(budgetMs);
    const fail = () => reject(new Error("broker response timed out"));
    signal.addEventListener("abort", fail, { once: true });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => {
      signal.removeEventListener("abort", fail);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
  socket.end(JSON.stringify(payload));
  return response;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function exchange(socketPath: string, payload: unknown): Promise<string> {
  const socket = createConnection(socketPath);
  sockets.push(socket);
  const chunks: Buffer[] = [];
  const response = new Promise<string>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
  socket.end(JSON.stringify(payload));
  return response;
}

describe("company candidate broker", () => {
  it.each(["handoff", "processor"] as const)("routes authenticated receipt reads only through the processor broker (%s)", async role => {
    const fixture = brokerFixture(role, `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const envelope = JSON.parse(input);
  fs.writeFileSync("__LOG__", JSON.stringify({ argv: process.argv.slice(2), envelope }));
  const authority = envelope.authority;
  process.stdout.write(JSON.stringify({
    schema_version: 2,
    provider_instance_id: authority.provider_instance_id,
    workspace_id: authority.workspace_id,
    selector: envelope.arguments,
    lookup_nonce: authority.nonce,
    lookup_request_digest: authority.request_digest,
    outcome: "not_found",
    receipt: null,
  }));
});
`);
    const ready = socketReady(fixture.root, fixture.socketPath);
    spawnBroker(fixture.brokerConfig);
    await ready;
    const key = join(fixture.root, "key.pem");
    const config = join(fixture.root, "processor.json");
    writeSecure(key, FIXED_PRIVATE_PEM);
    writeSecure(config, JSON.stringify(clientConfig(fixture.root, "processor", fixture.socketPath, key)));
    const client = createCompanyClient(config, "processor");
    const query = {
      candidate_id: "candidate:unit", handoff_id: "handoff:unit", operation: "accept",
      transition_request_digest: `sha256:${"b".repeat(64)}`, command_digest: `sha256:${"c".repeat(64)}`,
      content_digest: `sha256:${"d".repeat(64)}`, approval_policy_version: 1,
      approval_binding_digest: `sha256:${"e".repeat(64)}`,
    };
    if (role === "handoff") {
      await expect(client.call("read_transition_receipt", query, NOW))
        .rejects.toMatchObject({ code: "COMPANY_CANDIDATE_CALL_REFUSED" });
      expect(existsSync(fixture.log)).toBe(false);
      return;
    }
    await expect(client.call("read_transition_receipt", query, NOW))
      .resolves.toMatchObject({ outcome: "not_found", selector: query, receipt: null });
    const logged = JSON.parse(readFileSync(fixture.log, "utf8")) as {
      argv: string[]; envelope: { authority: Record<string, unknown> & { signature: string }; arguments: unknown };
    };
    expect(logged.argv).toEqual(["process", "--config", fixture.sbConfig]);
    expect(logged.envelope.arguments).toEqual(query);
    const { signature, ...authority } = logged.envelope.authority;
    expect(authority).toMatchObject({
      principal_id: CONTEXT.processor_principal_id,
      operation: "read_transition_receipt", purpose: "company_memory_receipt_read",
    });
    expect(verify(null, Buffer.from(`second-brain/company-memory-authority/v1\0${canonicalize(authority)}`),
      createPublicKey(FIXED_PUBLIC_PEM), Buffer.from(signature, "base64url"))).toBe(true);
  });

  it.each([0o770, 0o707])("refuses a writable socket ancestor at startup (%i)", async mode => {
    const fixture = brokerFixture("handoff", CHILD);
    const ancestor = join(fixture.root, "replaceable-socket");
    const parent = join(ancestor, "private");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    chmodSync(ancestor, mode);
    const socketPath = join(parent, "b.sock");
    writeSecure(fixture.brokerConfig, JSON.stringify({
      schema_version: 1, role: "handoff", socket: socketPath,
      sb_company_bin: fixture.bin, sb_config_file: fixture.sbConfig,
    }));
    const child = spawnBroker(fixture.brokerConfig);
    const [code] = await once(child, "exit", { signal: AbortSignal.timeout(3_000) });
    expect(code).toBe(1);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(fixture.log)).toBe(false);
  });

  it.each([0o770, 0o707])("refuses a writable SB config ancestor at startup (%i)", async mode => {
    const fixture = brokerFixture("handoff", CHILD);
    const ancestor = join(fixture.root, "replaceable-config");
    const parent = join(ancestor, "credentials");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const config = join(parent, "sb.json");
    renameSync(fixture.sbConfig, config);
    chmodSync(ancestor, mode);
    writeSecure(fixture.brokerConfig, JSON.stringify({
      schema_version: 1, role: "handoff", socket: fixture.socketPath,
      sb_company_bin: fixture.bin, sb_config_file: config,
    }));
    const child = spawnBroker(fixture.brokerConfig);
    const [code] = await once(child, "exit", { signal: AbortSignal.timeout(3_000) });
    expect(code).toBe(1);
    expect(existsSync(fixture.socketPath)).toBe(false);
    expect(existsSync(fixture.log)).toBe(false);
  });

  it.each([0o770, 0o707])("refuses a replaced SB config under a changed ancestor before dispatch (%i)", async mode => {
    const fixture = brokerFixture("handoff", CHILD);
    const ancestor = join(fixture.root, "replaceable-config");
    const parent = join(ancestor, "credentials");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(ancestor, 0o700);
    const config = join(parent, "sb.json");
    renameSync(fixture.sbConfig, config);
    writeSecure(fixture.brokerConfig, JSON.stringify({
      schema_version: 1, role: "handoff", socket: fixture.socketPath,
      sb_company_bin: fixture.bin, sb_config_file: config,
    }));
    const ready = socketReady(fixture.root, fixture.socketPath);
    spawnBroker(fixture.brokerConfig);
    await ready;
    const key = join(fixture.root, "client.pem");
    writeSecure(key, FIXED_PRIVATE_PEM);
    const clientPath = join(fixture.root, "client.json");
    writeSecure(clientPath, JSON.stringify(clientConfig(fixture.root, "handoff", fixture.socketPath, key)));
    const client = createCompanyClient(clientPath, "handoff");
    expect(await client.call("handoff", { limit: 1, offset: 0 }, NOW)).toEqual({ state: "ok" });
    rmSync(fixture.log);
    chmodSync(ancestor, mode);
    renameSync(config, `${config}.original`);
    writeSecure(config, "{\"replacement\":true}");
    await expect(client.call("handoff", { limit: 1, offset: 0 }, NOW))
      .rejects.toThrow("COMPANY_CANDIDATE_CALL_REFUSED");
    expect(existsSync(fixture.log)).toBe(false);
  });

  it.each(["mode", "symlink"] as const)("rechecks the SB config file itself before dispatch (%s)", async change => {
    const fixture = brokerFixture("handoff", CHILD);
    const ready = socketReady(fixture.root, fixture.socketPath);
    spawnBroker(fixture.brokerConfig);
    await ready;
    const key = join(fixture.root, "client.pem");
    writeSecure(key, FIXED_PRIVATE_PEM);
    const clientPath = join(fixture.root, "client.json");
    writeSecure(clientPath, JSON.stringify(clientConfig(fixture.root, "handoff", fixture.socketPath, key)));
    const client = createCompanyClient(clientPath, "handoff");
    if (change === "mode") chmodSync(fixture.sbConfig, 0o640);
    else {
      renameSync(fixture.sbConfig, `${fixture.sbConfig}.original`);
      symlinkSync(`${fixture.sbConfig}.original`, fixture.sbConfig);
    }
    await expect(client.call("handoff", { limit: 1, offset: 0 }, NOW))
      .rejects.toThrow("COMPANY_CANDIDATE_CALL_REFUSED");
    expect(existsSync(fixture.log)).toBe(false);
  });

  it.each([0o720, 0o702])("refuses a writable executable ancestor at startup (%i)", async mode => {
    const fixture = brokerFixture("handoff", CHILD);
    const ancestor = join(fixture.root, "replaceable");
    const parent = join(ancestor, "bin");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const executable = join(parent, "sb-company");
    renameSync(fixture.bin, executable);
    chmodSync(ancestor, mode);
    writeSecure(fixture.brokerConfig, JSON.stringify({
      schema_version: 1, role: "handoff", socket: fixture.socketPath,
      sb_company_bin: executable, sb_config_file: fixture.sbConfig,
    }));
    const child = spawnBroker(fixture.brokerConfig);
    const [code] = await once(child, "exit", { signal: AbortSignal.timeout(3_000) });
    expect(code).toBe(1);
    expect(existsSync(fixture.socketPath)).toBe(false);
    expect(existsSync(fixture.log)).toBe(false);
  });

  it.each([0o720, 0o702])("rechecks a changed executable ancestor before dispatch (%i)", async mode => {
    const fixture = brokerFixture("handoff", CHILD);
    const ancestor = join(fixture.root, "replaceable");
    const parent = join(ancestor, "bin");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(ancestor, 0o700);
    const executable = join(parent, "sb-company");
    renameSync(fixture.bin, executable);
    writeSecure(fixture.brokerConfig, JSON.stringify({
      schema_version: 1, role: "handoff", socket: fixture.socketPath,
      sb_company_bin: executable, sb_config_file: fixture.sbConfig,
    }));
    const ready = socketReady(fixture.root, fixture.socketPath);
    spawnBroker(fixture.brokerConfig);
    await ready;
    const key = join(fixture.root, "client.pem");
    writeSecure(key, FIXED_PRIVATE_PEM);
    const config = join(fixture.root, "client.json");
    writeSecure(config, JSON.stringify(clientConfig(fixture.root, "handoff", fixture.socketPath, key)));
    const client = createCompanyClient(config, "handoff");
    expect(await client.call("handoff", { limit: 1, offset: 0 }, NOW)).toEqual({ state: "ok" });
    rmSync(fixture.log);
    chmodSync(ancestor, mode);
    renameSync(executable, `${executable}.original`);
    writeSecure(executable, `#!/bin/bash\nprintf replaced > '${fixture.log}'\nprintf '%s' '{"state":"replacement"}'\n`, 0o755);
    await expect(client.call("handoff", { limit: 1, offset: 0 }, NOW))
      .rejects.toThrow("COMPANY_CANDIDATE_CALL_REFUSED");
    expect(existsSync(fixture.log)).toBe(false);
  });

  it("runs only the pinned action and config", async () => {
    const fixture = brokerFixture("handoff", CHILD);
    const ready = socketReady(fixture.root, fixture.socketPath);
    const child = spawnBroker(fixture.brokerConfig, {
      ...process.env,
      HOME: "/tmp/not-the-broker-home",
      SB_CONFIG: "/tmp/should-not-leak",
      PYTHONPATH: "/tmp/should-not-leak",
    });
    await ready;
    const socket = createConnection(fixture.socketPath);
    sockets.push(socket);
    const response = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("error", reject);
    });
    const envelope = {
      authority: {
        schema_version: 1,
        provider_instance_id: "provider:unit",
        workspace_id: CONTEXT.workspace_id,
        principal_id: CONTEXT.owner,
        agent_id: CONTEXT.agent_id,
        session_id: CONTEXT.session_id,
        projects: ["project:unit"],
        policy_revision: "policy:unit",
        purpose: "company_memory_handoff",
        operation: "handoff",
        request_digest: `sha256:${"b".repeat(64)}`,
        deletion_sequence: 7,
        deletion_set_root: CONTEXT.deletion_set_root,
        issued_at: NOW.toISOString(),
        expires_at: "2026-10-12T00:01:00.000Z",
        nonce: "jarvis:fixed-nonce",
        signing_key_id: "key:unit",
        signature: "c2ln",
      },
      arguments: { limit: 1, offset: 0, action: "process", config: "/tmp/evil.json" },
    };
    socket.end(JSON.stringify(envelope));
    expect(JSON.parse(await response)).toEqual({ state: "ok" });
    const log = readFileSync(fixture.log, "utf8");
    expect(log.split("\n")[0]).toBe(`argv: handoff --config ${fixture.sbConfig}`);
    expect(log).toContain(`HOME=${userInfo().homedir}`);
    expect(log).toContain("PATH=/usr/bin:/bin");
    expect(log).not.toContain("should-not-leak");
    expect(log).not.toContain("not-the-broker-home");
    expect(child.exitCode).toBeNull();
  });

  it("does not execute when the caller injects an action or the wrong operation", async () => {
    const fixture = brokerFixture("processor", CHILD);
    const ready = socketReady(fixture.root, fixture.socketPath);
    spawnBroker(fixture.brokerConfig);
    await ready;
    const response = await exchange(fixture.socketPath, {
      action: "handoff",
      config: "/tmp/evil.json",
      authority: { operation: "handoff" },
      arguments: {},
    });
    expect(JSON.parse(response)).toEqual({ error: "COMPANY_CANDIDATE_BROKER_REFUSED" });
    expect(existsSync(fixture.log)).toBe(false);
  });

  it("leaves a pre-existing socket untouched and removes only its own socket on close", async () => {
    const root = tempRoot();
    const existingPath = join(root, "taken.sock");
    const existing = createServer();
    servers.push(existing);
    existing.listen(existingPath);
    await once(existing, "listening");
    const bin = join(root, "sb-company");
    const sbConfig = join(root, "sb.json");
    writeSecure(bin, "#!/bin/bash\nprintf '%s' '{\"state\":\"ok\"}'\n", 0o755);
    chmodSync(bin, 0o755);
    writeSecure(sbConfig, "{\"schema_version\":1}\n");
    const brokerConfig = join(root, "broker.json");
    writeSecure(brokerConfig, JSON.stringify({
      schema_version: 1,
      role: "handoff",
      socket: existingPath,
      sb_company_bin: bin,
      sb_config_file: sbConfig,
    }));
    const child = spawnBroker(brokerConfig);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await once(child, "exit");
    expect(code).toBe(1);
    expect(stderr).toBe("COMPANY_CANDIDATE_BROKER_SOCKET_EXISTS\n");
    expect(existing.listening).toBe(true);
    expect(existsSync(existingPath)).toBe(true);
  });

  it("cleans its socket when the executable receives SIGTERM", async () => {
    const fixture = brokerFixture("handoff", CHILD);
    const ready = socketReady(fixture.root, fixture.socketPath);
    const child = spawnBroker(fixture.brokerConfig);
    await ready;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code] = await exited;
    expect(code).toBe(0);
    expect(existsSync(fixture.socketPath)).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT"] as const)("ends dispatched children before broker shutdown (%s)", async signal => {
    const root = tempRoot();
    const gatePath = join(root, "gate.sock");
    const gate = createServer();
    servers.push(gate);
    const started = new Promise<{ socket: Socket; pid: number }>((resolve, reject) => {
      const timeout = AbortSignal.timeout(5_000);
      timeout.addEventListener("abort", () => reject(new Error("shutdown child did not start")), { once: true });
      gate.once("connection", socket => {
        let body = "";
        socket.on("error", reject);
        socket.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf8");
          if (!body.includes("\n")) return;
          const pid = Number(body.split("\n")[0]);
          rememberPid(pid);
          resolve({ socket, pid });
        });
      });
    });
    gate.listen(gatePath);
    await once(gate, "listening");
    const script = `#!/bin/bash\nexec ${quoteShell(process.execPath)} ${quoteShell(REVIEW)} ${quoteShell(gatePath)} ignore-term\n`;
    const fixture = brokerFixture("handoff", script);
    const ready = socketReady(fixture.root, fixture.socketPath);
    const broker = spawnBroker(fixture.brokerConfig);
    await ready;
    const response = readBroker(fixture.socketPath, handoffEnvelope());
    const child = await started;
    try {
      const exited = once(broker, "exit", { signal: AbortSignal.timeout(3_000) });
      broker.kill(signal);
      const [code] = await exited;
      expect(code).toBe(0);
      expect(() => process.kill(child.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(existsSync(fixture.socketPath)).toBe(false);
      await response;
    } finally {
      const closed = child.socket.destroyed ? Promise.resolve()
        : once(child.socket, "close", { signal: AbortSignal.timeout(3_000) });
      killReviewPid(child.pid);
      await closed;
    }
  });

  it("supports an explicitly pinned caller group without exposing SB credentials or database", async () => {
    const fixture = brokerFixture("processor", CHILD);
    const group = process.getgid?.();
    expect(group).toBeTypeOf("number");
    chmodSync(fixture.root, 0o710);
    writeSecure(fixture.brokerConfig, JSON.stringify({
      schema_version: 1, role: "processor", socket: fixture.socketPath,
      sb_company_bin: fixture.bin, sb_config_file: fixture.sbConfig, caller_group_id: group,
    }));
    const ready = socketReady(fixture.root, fixture.socketPath, 0o660);
    spawnBroker(fixture.brokerConfig);
    await ready;
    expect(statSync(fixture.socketPath).gid).toBe(group);
    expect(statSync(fixture.socketPath).mode & 0o777).toBe(0o660);
    expect(statSync(fixture.sbConfig).mode & 0o777).toBe(0o600);
  });

  it("closes the listening server when socket setup fails after listen", async () => {
    const fixture = brokerFixture("handoff", CHILD);
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--import",
      REVIEW,
      BROKER,
      "--config",
      fixture.brokerConfig,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, JARVIS_BROKER_REVIEW_FAULT: "post-listen" },
    });
    children.push(child);
    const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [code] = await exited;
    expect(code).toBe(1);
    expect(stderr).toBe("COMPANY_CANDIDATE_BROKER_CONFIG_INVALID\n");
    expect(existsSync(fixture.socketPath)).toBe(false);
  });

  it("refuses a ninth dispatch while disconnected children still hold slots", async () => {
    const root = tempRoot();
    const gatePath = join(root, "gate.sock");
    const gate = createServer();
    servers.push(gate);
    const started: Socket[] = [];
    const eight = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dispatch children did not start")), 5_000);
      gate.on("connection", (sock) => {
        started.push(sock);
        sock.on("error", () => undefined);
        if (started.length === 8) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    gate.listen(gatePath);
    await once(gate, "listening");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const script = `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(REVIEW)} ${quote(gatePath)}\n`;
    const fixture = brokerFixture("handoff", script);
    const realExecFile = childProcess.execFile;
    const tracked: ChildProcess[] = [];
    const execTarget: Record<string, unknown> = childProcess;
    execTarget["execFile"] = (...args: Parameters<typeof realExecFile>) => {
      const child = realExecFile(...args);
      tracked.push(child);
      return child;
    };
    const serverSockets: Socket[] = [];
    const realCreateServer = net.createServer;
    const netTarget: Record<string, unknown> = net;
    netTarget["createServer"] = (...args: Parameters<typeof realCreateServer>) => {
      const server = realCreateServer(...args);
      server.on("connection", (socket) => {
        serverSockets.push(socket);
      });
      return server;
    };
    syncBuiltinESMExports();
    const envelope = {
      authority: {
        schema_version: 1,
        provider_instance_id: "provider:unit",
        workspace_id: CONTEXT.workspace_id,
        principal_id: CONTEXT.owner,
        agent_id: CONTEXT.agent_id,
        session_id: CONTEXT.session_id,
        projects: ["project:unit"],
        policy_revision: "policy:unit",
        purpose: "company_memory_handoff",
        operation: "handoff",
        request_digest: `sha256:${"b".repeat(64)}`,
        deletion_sequence: 7,
        deletion_set_root: CONTEXT.deletion_set_root,
        issued_at: NOW.toISOString(),
        expires_at: "2026-10-12T00:01:00.000Z",
        nonce: "jarvis:fixed-nonce",
        signing_key_id: "key:unit",
        signature: "c2ln",
      },
      arguments: { limit: 1, offset: 0 },
    };
    let broker: { close(): Promise<void> } | undefined;
    try {
      const loaded: unknown = await import(pathToFileURL(BROKER).href);
      if (typeof loaded !== "object" || loaded === null || !("startCompanyCandidateBroker" in loaded)
        || typeof loaded.startCompanyCandidateBroker !== "function") {
        throw new Error("compiled broker export missing");
      }
      const startedBroker: unknown = await loaded.startCompanyCandidateBroker(fixture.brokerConfig);
      if (!isBrokerHandle(startedBroker)) throw new Error("compiled broker handle missing");
      broker = startedBroker;
      const holds: Socket[] = [];
      for (let index = 0; index < 8; index += 1) {
        const socket = createConnection(fixture.socketPath);
        socket.on("error", () => undefined);
        sockets.push(socket);
        holds.push(socket);
        socket.end(JSON.stringify(envelope));
      }
      await eight;
      expect(tracked).toHaveLength(8);
      const requestSockets = serverSockets.slice(0, 8);
      const disconnected = Promise.all(requestSockets.map((socket) => once(socket, "close")));
      for (const socket of holds) socket.destroy();
      for (const socket of requestSockets) socket.destroy();
      await disconnected;
      const ninthSpawn = new Promise<void>((resolve) => {
        gate.once("connection", () => resolve());
      });
      const refused = readBroker(fixture.socketPath, envelope);
      const winner = await Promise.race([
        refused.then((body) => ({ kind: "response" as const, body })),
        ninthSpawn.then(() => ({ kind: "spawned" as const })),
      ]);
      expect(winner).toEqual({ kind: "response", body: '{"error":"COMPANY_CANDIDATE_BROKER_REFUSED"}' });
      expect(started).toHaveLength(8);
      expect(tracked).toHaveLength(8);
      const settled = Promise.all(tracked.map((child) => once(child, "close")));
      for (const sock of started) sock.end();
      await settled;
      const admittedSpawn = new Promise<Socket>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("admission child did not start")), 5_000);
        gate.once("connection", (socket) => {
          clearTimeout(timer);
          resolve(socket);
        });
      });
      const admittedReply = readBroker(fixture.socketPath, envelope);
      const admittedSocket = await admittedSpawn;
      admittedSocket.end();
      const admitted = await admittedReply;
      expect(JSON.parse(admitted)).toEqual({ state: "ok" });
      expect(tracked).toHaveLength(9);
    } finally {
      execTarget["execFile"] = realExecFile;
      netTarget["createServer"] = realCreateServer;
      syncBuiltinESMExports();
      for (const sock of started) sock.destroy();
      for (const child of tracked) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
      await broker?.close();
    }
  });

  it("holds quota until a stalled response socket closes within the write bound", async () => {
    const root = tempRoot();
    const gatePath = join(root, "gate.sock");
    const gate = createServer();
    servers.push(gate);
    const started: Socket[] = [];
    const ended: Array<Promise<void>> = [];
    const eight = new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(5_000);
      const fail = () => reject(new Error("dispatch children did not start"));
      signal.addEventListener("abort", fail, { once: true });
      gate.on("connection", (sock) => {
        started.push(sock);
        capturePid(sock);
        sock.on("error", () => undefined);
        ended.push(sock.readableEnded ? Promise.resolve() : once(sock, "end").then(() => undefined));
        if (started.length === 8) {
          signal.removeEventListener("abort", fail);
          resolve();
        }
      });
    });
    gate.listen(gatePath);
    await once(gate, "listening");
    const script = `#!/bin/bash\nexec ${quoteShell(process.execPath)} ${quoteShell(REVIEW)} ${quoteShell(gatePath)} stall\n`;
    const fixture = brokerFixture("handoff", script);
    const brokerSockets: Socket[] = [];
    const realCreateServer = net.createServer;
    const netTarget: Record<string, unknown> = net;
    netTarget["createServer"] = (...args: Parameters<typeof realCreateServer>) => {
      const server = realCreateServer(...args);
      server.on("connection", sock => brokerSockets.push(sock));
      return server;
    };
    syncBuiltinESMExports();
    let broker: { close(): Promise<void> } | undefined;
    try {
      broker = await loadBroker(fixture.brokerConfig);
      const envelope = handoffEnvelope();
      const holds: Socket[] = [];
      const sawWrite: Array<Promise<void>> = [];
      for (let index = 0; index < 8; index += 1) {
        const socket = createConnection(fixture.socketPath);
        sockets.push(socket);
        holds.push(socket);
        sawWrite.push(new Promise((resolve, reject) => {
          const signal = AbortSignal.timeout(5_000);
          const fail = () => reject(new Error("response write did not start"));
          signal.addEventListener("abort", fail, { once: true });
          socket.on("data", () => {
            socket.pause();
            signal.removeEventListener("abort", fail);
            resolve();
          });
        }));
        socket.end(JSON.stringify(envelope));
      }
      await eight;
      await Promise.all(ended);
      await Promise.all(sawWrite);
      const ninth = new Promise<void>((resolve) => {
        gate.once("connection", () => resolve());
      });
      const refused = readBroker(fixture.socketPath, envelope);
      const winner = await Promise.race([
        refused.then((body) => ({ kind: "response" as const, body })),
        ninth.then(() => ({ kind: "spawned" as const })),
      ]);
      expect(winner).toEqual({ kind: "response", body: '{"error":"COMPANY_CANDIDATE_BROKER_REFUSED"}' });
      expect(started).toHaveLength(8);
      for (const socket of holds) expect(socket.destroyed).toBe(false);
      const stillHeld = JSON.parse(await readBroker(fixture.socketPath, envelope)) as { error?: string };
      expect(stillHeld).toEqual({ error: "COMPANY_CANDIDATE_BROKER_REFUSED" });
      await Promise.all(brokerSockets.slice(0, 8).map(sock =>
        once(sock, "close", { signal: AbortSignal.timeout(13_000) })));
      const admitted = new Promise<Socket>((resolve, reject) => {
        const signal = AbortSignal.timeout(5_000);
        signal.addEventListener("abort", () => reject(new Error("write budget did not restore admission")), { once: true });
        gate.once("connection", (sock) => {
          capturePid(sock);
          resolve(sock);
        });
      });
      const admittedReply = readBroker(fixture.socketPath, envelope);
      const outcome = await Promise.race([
        admitted.then((sock) => ({ kind: "spawned" as const, sock })),
        admittedReply.then((body) => ({ kind: "response" as const, body })),
      ]);
      expect(outcome.kind).toBe("spawned");
      if (outcome.kind === "spawned") outcome.sock.destroy();
    } finally {
      netTarget["createServer"] = realCreateServer;
      syncBuiltinESMExports();
      for (const sock of brokerSockets) sock.destroy();
      await broker?.close();
    }
  }, 30_000);

  it("hard-kills a pinned child that ignores SIGTERM and restores the slot", async () => {
    const root = tempRoot();
    const gatePath = join(root, "gate.sock");
    const marker = join(root, "sigterm.txt");
    const gate = createServer();
    servers.push(gate);
    const connected = new Promise<Socket>((resolve, reject) => {
      const signal = AbortSignal.timeout(5_000);
      signal.addEventListener("abort", () => reject(new Error("deadline child did not start")), { once: true });
      gate.once("connection", (sock) => {
        capturePid(sock);
        sock.on("error", () => undefined);
        resolve(sock);
      });
    });
    gate.listen(gatePath);
    await once(gate, "listening");
    const script = `#!/bin/bash\nexec ${quoteShell(process.execPath)} ${quoteShell(REVIEW)} ${quoteShell(gatePath)} ignore-term ${quoteShell(marker)}\n`;
    const fixture = brokerFixture("handoff", script);
    const ready = socketReady(fixture.root, fixture.socketPath);
    spawnBroker(fixture.brokerConfig);
    await ready;
    const envelope = handoffEnvelope();
    const response = readBrokerBounded(fixture.socketPath, envelope, 16_000);
    const gateSock = await connected;
    const startedAt = Date.now();
    await once(gateSock, "close", { signal: AbortSignal.timeout(13_000) });
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(7_000);
    expect(elapsed).toBeLessThan(13_000);
    expect(JSON.parse(await response)).toEqual({ error: "COMPANY_CANDIDATE_BROKER_REFUSED" });
    const again = new Promise<Socket>((resolve, reject) => {
      const signal = AbortSignal.timeout(5_000);
      signal.addEventListener("abort", () => reject(new Error("admission was not restored")), { once: true });
      gate.once("connection", (sock) => {
        capturePid(sock);
        resolve(sock);
      });
    });
    const second = readBrokerBounded(fixture.socketPath, envelope, 3_000).then(
      (body) => ({ kind: "response" as const, body }),
      () => ({ kind: "pending" as const }),
    );
    const outcome = await Promise.race([
      again.then((sock) => ({ kind: "spawned" as const, sock })),
      second,
    ]);
    expect(outcome.kind).toBe("spawned");
    if (outcome.kind === "spawned") {
      outcome.sock.destroy();
      for (const pid of reviewPids) killReviewPid(pid);
    }
  }, 30_000);

  it("closes a refused response after flushing even when the peer keeps its write side open", async () => {
    const fixture = brokerFixture("handoff", CHILD);
    const serverSockets: Socket[] = [];
    let entered: (() => void) | undefined;
    const eight = new Promise<void>(resolve => { entered = resolve; });
    let ninthEntered: ((socket: Socket) => void) | undefined;
    const ninth = new Promise<Socket>(resolve => { ninthEntered = resolve; });
    const realCreateServer = net.createServer;
    const target: Record<string, unknown> = net;
    target["createServer"] = (...args: Parameters<typeof realCreateServer>) => {
      const server = realCreateServer(...args);
      server.on("connection", socket => {
        serverSockets.push(socket);
        if (serverSockets.length === 8) entered?.();
        if (serverSockets.length === 9) ninthEntered?.(socket);
      });
      return server;
    };
    syncBuiltinESMExports();
    let broker: { close(): Promise<void> } | undefined;
    try {
      broker = await loadBroker(fixture.brokerConfig);
      for (let index = 0; index < 8; index++) sockets.push(createConnection(fixture.socketPath));
      await eight;
      const peer = createConnection(fixture.socketPath);
      peer.on("error", () => undefined);
      peer.pause();
      sockets.push(peer);
      const rejected = await ninth;
      const closed = once(rejected, "close", { signal: AbortSignal.timeout(3_000) });
      await closed;
      expect(rejected.destroyed).toBe(true);
      expect(peer.writableEnded).toBe(false);
    } finally {
      target["createServer"] = realCreateServer;
      syncBuiltinESMExports();
      for (const socket of serverSockets) socket.destroy();
      await broker?.close();
    }
  }, 10_000);
});
