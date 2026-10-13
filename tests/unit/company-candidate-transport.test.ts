import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from "node:fs";
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
const BROKER = fileURLToPath(new URL("../../dist/src/company-candidate-broker-main.mjs", import.meta.url));
const REVIEW = fileURLToPath(new URL("../fixtures/company-candidate-broker-review.mjs", import.meta.url));

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
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
});
