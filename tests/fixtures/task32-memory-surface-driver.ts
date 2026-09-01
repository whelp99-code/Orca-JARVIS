import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityDb } from "../../src/db.js";
import { parseSecondBrainStrictJsonBytes } from "../../src/second-brain-strict-json.js";
import { startTask32QaServer, type Task32QaServer } from "./task32-memory-qa-server.js";

type DriverResult = { readonly case: string; readonly ok: boolean;
  readonly [key: string]: unknown };

const DRIVER_CASES = ["strict-boundary-bytes", "built-http-boundary", "record-token-one-time",
  "memory-ready-runtime", "content-free-authority", "evidence-dag"] as const;
type DriverCase = (typeof DRIVER_CASES)[number];

function isDriverCase(value: string | undefined): value is DriverCase {
  return DRIVER_CASES.some(name => name === value);
}

async function withServer<T>(
  scenario: "schema4" | "no-data",
  use: (server: Task32QaServer, csrf: string) => Promise<T>,
): Promise<T> {
  const server = await startTask32QaServer(scenario);
  try {
    const session: unknown = await (await fetch(`${server.url}/api/v1/session`)).json();
    const csrf = typeof session === "object" && session !== null
      ? Reflect.get(session, "csrf_token") : undefined;
    if (typeof csrf !== "string") throw new TypeError("session token required");
    return await use(server, csrf);
  } finally {
    await server.close();
  }
}

async function post(server: Task32QaServer, csrf: string, path: string, body: BodyInit) {
  const response = await fetch(`${server.url}${path}`, { method: "POST", body, headers: {
    "Content-Type": "application/json", "X-JARVIS-CSRF": csrf, Origin: server.url } });
  const parsed: unknown = await response.json();
  const error = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "error") : undefined;
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return { status: response.status, code: typeof code === "string" ? code : null, body: parsed };
}

function strictBoundaryBytes(): DriverResult {
  const corpus = [
    ["duplicate-top-level", Buffer.from('{"query":"a","query":"b"}', "utf8")],
    ["duplicate-nested", Buffer.from('{"p":{"r":"a","r":"b"}}', "utf8")],
    ["malformed-utf8", Buffer.concat([Buffer.from('{"q":"'), Buffer.from([0xff]), Buffer.from('"}')])],
    ["lone-surrogate-bytes", Buffer.concat([Buffer.from('{"q":"'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}')])],
  ] as const;
  const rejected = corpus.filter(([, bytes]) => parseSecondBrainStrictJsonBytes(bytes) === undefined);
  const accepted = parseSecondBrainStrictJsonBytes(Buffer.from('{"query":"ok"}', "utf8"));
  return { case: "strict-boundary-bytes", corpus: corpus.length, rejected: rejected.length,
    well_formed_accepted: accepted !== undefined,
    ok: rejected.length === corpus.length && accepted !== undefined };
}

async function builtHttpBoundary(): Promise<DriverResult> {
  return withServer("schema4", async (server, csrf) => {
    const oversize = JSON.stringify({ schema_version: 1, query: "a".repeat(65_537), limit: 5 });
    const observed = {
      duplicate_key: await post(server, csrf, "/api/v1/memory/search",
        '{"schema_version":1,"query":"a","query":"b","limit":5}'),
      malformed_utf8: await post(server, csrf, "/api/v1/memory/search",
        Buffer.concat([Buffer.from('{"schema_version":1,"query":"'), Buffer.from([0xff]),
          Buffer.from('","limit":5}')])),
      prohibited_query: await post(server, csrf, "/api/v1/memory/search",
        JSON.stringify({ schema_version: 1, query: "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE", limit: 5 })),
      oversize: await post(server, csrf, "/api/v1/memory/search", oversize),
    };
    return { case: "built-http-boundary",
      duplicate_key: observed.duplicate_key, malformed_utf8: observed.malformed_utf8,
      prohibited_query: observed.prohibited_query, oversize: observed.oversize,
      ok: observed.duplicate_key.code === "MEMORY_INPUT_INVALID"
        && observed.malformed_utf8.code === "MEMORY_INPUT_INVALID"
        && observed.prohibited_query.code === "MEMORY_QUERY_PROHIBITED"
        && observed.oversize.code === "MEMORY_REQUEST_TOO_LARGE" && observed.oversize.status === 413 };
  });
}

async function recordTokenOneTime(): Promise<DriverResult> {
  return withServer("schema4", async (server, csrf) => {
    const search = await post(server, csrf, "/api/v1/memory/search",
      JSON.stringify({ schema_version: 1, query: "evidence", limit: 5 }));
    const items = typeof search.body === "object" && search.body !== null
      ? Reflect.get(search.body, "items") : undefined;
    const first = Array.isArray(items) ? items[0] : undefined;
    const token = typeof first === "object" && first !== null
      ? Reflect.get(first, "record_token") : undefined;
    if (typeof token !== "string") {
      return { case: "record-token-one-time", ok: false, error: "TASK32_DRIVER_NO_RECORD_TOKEN" };
    }
    const detail = JSON.stringify({ schema_version: 1, record_token: token });
    const initial = await post(server, csrf, "/api/v1/memory/records/detail", detail);
    const replay = await post(server, csrf, "/api/v1/memory/records/detail", detail);
    return { case: "record-token-one-time", first_status: initial.status,
      replay_status: replay.status, replay_code: replay.code,
      ok: initial.status === 200 && replay.status === 404 };
  });
}

async function memoryReadyRuntime(): Promise<DriverResult> {
  return withServer("schema4", async (server, csrf) => {
    const response = await fetch(`${server.url}/api/v1/memory/status`, {
      headers: { "X-JARVIS-CSRF": csrf } });
    const body: unknown = await response.json();
    const read = (key: string): unknown => typeof body === "object" && body !== null
      ? Reflect.get(body, key) : undefined;
    return { case: "memory-ready-runtime", state: read("state"),
      contract_schema: read("contract_schema"), mutations_enabled: read("mutations_enabled"),
      ok: read("state") === "ready" && read("contract_schema") === 4
        && read("mutations_enabled") === true };
  });
}

async function contentFreeAuthority(): Promise<DriverResult> {
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "task32-content-free-"));
  const db = new AuthorityDb(join(root, "authority.db"), resolve("dist/migrations"));
  try {
    await db.migrate();
    const tables = db.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
      .all() as ReadonlyArray<{ readonly name: string; readonly sql: string | null }>;
    const outbox = db.db.prepare("PRAGMA table_info(memory_outbox)")
      .all() as ReadonlyArray<{ readonly name: string }>;
    const bearing = tables.filter(row => row.name.startsWith("memory_")
      && (row.sql ?? "").includes("request_json")).map(row => row.name);
    return { case: "content-free-authority", tables: tables.length,
      memory_request_json_tables: bearing,
      memory_outbox_has_request_json: outbox.some(column => column.name === "request_json"),
      ok: tables.length > 0 && bearing.length === 0 };
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function evidenceDag(): DriverResult {
  const root = ".omo/evidence/task-32-remediation-v6";
  const files = ["manifest.json", "manifest.sha256", "evidence-root.json", "evidence-root.sha256"];
  const missing = files.filter(file => !existsSync(`${root}/${file}`));
  const digests = Object.fromEntries(files.filter(file => existsSync(`${root}/${file}`))
    .map(file => [file, `sha256:${createHash("sha256")
      .update(readFileSync(`${root}/${file}`)).digest("hex")}`]));
  return { case: "evidence-dag", missing, digests, ok: missing.length === 0 };
}

async function run(name: DriverCase): Promise<DriverResult> {
  switch (name) {
    case "strict-boundary-bytes": return strictBoundaryBytes();
    case "built-http-boundary": return builtHttpBoundary();
    case "record-token-one-time": return recordTokenOneTime();
    case "memory-ready-runtime": return memoryReadyRuntime();
    case "content-free-authority": return contentFreeAuthority();
    case "evidence-dag": return evidenceDag();
    default: return assertNever(name);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected driver case: ${String(value)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const caseIndex = args.indexOf("--case");
  const name = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
  if (!args.includes("--json") || !isDriverCase(name)) {
    process.stderr.write(`usage: task32-memory-surface-driver --case <${DRIVER_CASES.join("|")}> --json\n`);
    process.exitCode = 2;
    return;
  }
  const result = await run(name);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === entry) await main();
