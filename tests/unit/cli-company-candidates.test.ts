import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { CliCommandContext, CliValues } from "../../src/cli-command-context.js";
import { executeCompanyCandidates } from "../../src/cli-company-candidates.js";
import type { AuthorityDb } from "../../src/db.js";
import { initialized } from "../helpers.js";

const scratch: string[] = [];
const servers: Server[] = [];
const databases: AuthorityDb[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
  for (const db of databases.splice(0)) db.close();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writeSecure(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o600 });
}

function counts(db: AuthorityDb): { handoffs: number; commands: number } {
  const handoffs = db.db.prepare("SELECT COUNT(*) AS n FROM company_candidate_handoffs").get() as { n: number };
  const commands = db.db.prepare("SELECT COUNT(*) AS n FROM control_command_requests").get() as { n: number };
  return { handoffs: handoffs.n, commands: commands.n };
}

function caller(db: AuthorityDb, subcommand: "import" | "execute", values: CliValues, argument?: string): CliCommandContext {
  return {
    args: [],
    values: { db: db.filename, json: true, ...values },
    positionals: argument === undefined
      ? ["company-candidates", subcommand]
      : ["company-candidates", subcommand, argument],
    command: "company-candidates",
    subcommand,
    argument,
    fourth: undefined,
    fifth: undefined,
    sixth: undefined,
    db,
    dependencies: { clock: () => new Date("2026-10-14T00:00:00.000Z") },
  };
}

async function openedDatabase(): Promise<AuthorityDb> {
  const db = await initialized();
  databases.push(db);
  return db;
}

async function companyMaterial(role: "handoff" | "processor"): Promise<{ root: string; configPath: string; connections: Buffer[] }> {
  const root = mkdtempSync(join(tmpdir(), "jarvis-company-cli-"));
  scratch.push(root);
  const keyPath = join(root, "key.pem");
  const { privateKey } = generateKeyPairSync("ed25519");
  const exported = privateKey.export({ type: "pkcs8", format: "pem" });
  writeSecure(keyPath, typeof exported === "string" ? exported : exported.toString());
  const connections: Buffer[] = [];
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      connections.push(Buffer.concat(chunks));
      socket.end();
    });
  });
  servers.push(server);
  const socketPath = join(root, "c.sock");
  server.listen(socketPath);
  await once(server, "listening");
  const configPath = join(root, "client.json");
  writeSecure(configPath, JSON.stringify({
    schema_version: 1,
    role,
    context: {
      provider_instance_id: "provider:unit",
      workspace_id: "e7726a7a-804e-4720-bc9f-dd17a8de6b49",
      owner: "principal:owner",
      agent_id: "agent:jarvis",
      session_id: "session:unit",
      projects: ["project:unit"],
      policy_revision: "policy:unit",
      deletion_sequence: 7,
      deletion_set_root: `sha256:${"ab".repeat(32)}`,
      processor_principal_id: "principal:processor",
    },
    socket: socketPath,
    signing_key_id: "key:unit",
    signing_key_file: keyPath,
  }));
  return { root, configPath, connections };
}

describe("company-candidates CLI options", () => {
  it("refuses import --dry-run before the handoff client calls or the database changes", async () => {
    const db = await openedDatabase();
    const before = counts(db);
    const { configPath, connections } = await companyMaterial("handoff");

    await expect(executeCompanyCandidates(caller(db, "import", {
      "company-config": configPath,
      "dry-run": true,
      limit: "7",
    }))).rejects.toMatchObject({ code: "COMPANY_CALLER_CONFIG_INVALID" });

    expect(connections).toEqual([]);
    expect(counts(db)).toEqual(before);
  });

  it("refuses execute --dry-run before the processor client or a live execute read", async () => {
    const db = await openedDatabase();
    const before = counts(db);
    const { configPath, connections } = await companyMaterial("processor");

    await expect(executeCompanyCandidates(caller(db, "execute", {
      "company-config": configPath,
      "dry-run": true,
    }, "company-handoff:v1:aa:1"))).rejects.toMatchObject({ code: "COMPANY_CALLER_CONFIG_INVALID" });

    expect(connections).toEqual([]);
    expect(counts(db)).toEqual(before);
  });

  it.each([
    ["import --once", "import", undefined, { once: true }],
    ["import --cursor", "import", undefined, { cursor: "page-1" }],
    ["import --worktree", "import", undefined, { worktree: "/tmp/not-a-company-flag" }],
    ["execute --limit", "execute", "company-handoff:v1:bb:1", { limit: "3" }],
    ["execute --all", "execute", "company-handoff:v1:bb:1", { all: true }],
    ["execute --rehearse", "execute", "company-handoff:v1:bb:1", { rehearse: "/tmp/not-a-company-flag" }],
  ] as const)("refuses %s before a missing credential is opened", async (_label, subcommand, argument, extra) => {
    const db = await openedDatabase();
    const before = counts(db);
    const root = mkdtempSync(join(tmpdir(), "jarvis-company-cli-missing-"));
    scratch.push(root);
    const missing = join(root, "credential.json");

    await expect(executeCompanyCandidates(caller(db, subcommand, {
      "company-config": missing,
      ...extra,
    }, argument))).rejects.toMatchObject({ code: "COMPANY_CALLER_CONFIG_INVALID" });

    expect(counts(db)).toEqual(before);
  });

  it("still imports with an explicit limit and the global db/json flags", async () => {
    const db = await openedDatabase();
    const before = counts(db);
    const { configPath, connections } = await companyMaterial("handoff");

    await expect(executeCompanyCandidates(caller(db, "import", {
      "company-config": configPath,
      limit: "7",
    }))).rejects.toMatchObject({ code: "COMPANY_CANDIDATE_RESPONSE_INVALID" });

    expect(connections).toHaveLength(1);
    expect(JSON.parse(connections[0]?.toString("utf8") ?? "{}")).toMatchObject({
      arguments: { limit: 7, offset: 0 },
    });
    expect(counts(db)).toEqual(before);
  });

  it("still accepts execute completion config and reaches the executor without a handoff row", async () => {
    const db = await openedDatabase();
    const before = counts(db);
    const { configPath, connections } = await companyMaterial("processor");
    const completion = join(configPath, "..", "completion.json");
    writeSecure(completion, "{");

    await expect(executeCompanyCandidates(caller(db, "execute", {
      "company-config": configPath,
      "company-completion-config": completion,
    }, "company-handoff:v1:cc:1"))).rejects.toMatchObject({ code: "COMPANY_COMPLETION_CONFIG_INVALID" });

    expect(connections).toEqual([]);
    expect(counts(db)).toEqual(before);
  });
});
