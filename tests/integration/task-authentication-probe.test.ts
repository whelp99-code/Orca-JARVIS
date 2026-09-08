import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { probeClaudeTaskAuthentication } from "../../src/claude-task-authentication.js";
import { probeTaskExecutor } from "../../src/task-executor-registry.js";
import { execute } from "../../src/cli.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-auth-probe-")); roots.push(root);
  const path = join(root, "provider");
  writeFileSync(path, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  return { root, path, env: { ...process.env, JARVIS_TASK_CLAUDE_PATH: path } };
}
function response(value: string | Buffer, code: number) {
  return fixture(`process.stdout.write(Buffer.from('${Buffer.from(value).toString("base64")}','base64'),()=>process.exit(${code}));`);
}

it.each([{ loggedIn: true, code: 0, state: "reported_logged_in" }, { loggedIn: false, code: 1, state: "reported_logged_out" }])(
  "reports only the CLI's $state without exposing identity fields", async ({ loggedIn, code, state }) => {
    const f = response(JSON.stringify({ loggedIn, email: "private-email", orgId: "private-org", authMethod: "private-method" }), code);
    expect(await probeClaudeTaskAuthentication(f.env)).toEqual({ state, remote_verification: "not_performed" });
  });

it.each([
  { raw: '{"loggedIn":true}', code: 1 }, { raw: '{"loggedIn":false}', code: 0 },
  { raw: '{"loggedIn":"true"}', code: 0 }, { raw: '{"loggedIn":false,"loggedIn":true}', code: 0 },
  { raw: 'private-not-json', code: 2 }, { raw: Buffer.from([0xff]), code: 0 },
])("rejects malformed or contradictory status %# without returning raw data", async ({ raw, code }) => {
  const f = response(raw, code);
  expect(await probeClaudeTaskAuthentication(f.env)).toEqual({ state: "unknown", remote_verification: "not_performed",
    reason_code: "TASK_AUTH_PROBE_RESULT_INVALID" });
});

it("uses fixed auth argv, a restricted environment and root cwd; compiled CLI creates no DB", () => {
  const f = fixture(`if (JSON.stringify(process.argv.slice(2)) !== '["auth","status","--json"]'
    || process.cwd() !== '/' || process.env.PRIVATE_MARKER) process.exit(7);
    process.stderr.write('private-diagnostic'); process.stdout.write('{"loggedIn":true,"email":"private-email"}');`);
  const raw = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "routing", "probe-executor", "claude-code"], {
    cwd: f.root, env: { ...f.env, PRIVATE_MARKER: "private-secret", JARVIS_DB: join(f.root, "authority.sqlite") },
    encoding: "utf8", timeout: 10000,
  });
  expect(JSON.parse(raw)).toMatchObject({ ok: true, executor: { execution_available: false, readiness: "not_probed",
    authentication: { state: "reported_logged_in", remote_verification: "not_performed" } } });
  expect(raw).not.toContain("private-"); expect(raw).not.toContain(f.root);
  expect(readdirSync(f.root)).toEqual(["provider"]);
});

it("bounds combined stdout and stderr before decoding", async () => {
  const f = fixture("process.stderr.write(Buffer.alloc(32769,120)); setInterval(()=>{},1000);");
  expect(await probeClaudeTaskAuthentication(f.env)).toMatchObject({ state: "unknown", reason_code: "TASK_AUTH_PROBE_OUTPUT_LIMIT" });
});

it("terminates a timed-out process before returning unknown", async () => {
  const f = fixture(""); const marker = join(f.root, "pid");
  writeFileSync(f.path, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
  expect(await probeClaudeTaskAuthentication(f.env)).toMatchObject({ state: "unknown", reason_code: "TASK_AUTH_PROBE_TIMEOUT" });
  const pid = Number(readFileSync(marker, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}, 15000);

it("does not probe absent configuration or unregistered executors and rejects execution flags", async () => {
  expect(await probeClaudeTaskAuthentication({})).toMatchObject({ state: "not_probed", reason_code: "TASK_AUTH_PROBE_NOT_CONFIGURED" });
  expect(await probeTaskExecutor("cursor", { JARVIS_TASK_CLAUDE_PATH: "/nonexistent/provider" }))
    .toMatchObject({ registration: "unregistered", authentication: { state: "not_probed", reason_code: "TASK_EXECUTOR_UNREGISTERED" } });
  expect(await probeClaudeTaskAuthentication({ JARVIS_TASK_CLAUDE_PATH: "/nonexistent/provider" }))
    .toMatchObject({ state: "unknown", reason_code: "TASK_AUTH_PROBE_UNAVAILABLE" });
  await expect(execute(["routing", "probe-executor", "claude-code", "--db", "/nonexistent/db"]))
    .rejects.toMatchObject({ code: "WORK_ROUTING_INPUT_INVALID" });
});
