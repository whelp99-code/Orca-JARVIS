import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import * as composition from "../../src/remote-approval-compose.js";
import { parseDashboardCli, startDashboardCli } from "../../src/dashboard/main.js";

it("creates the default service once before accepting requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-policy-once-"));
  const db = new AuthorityDb(join(root, "authority.sqlite"));
  const spy = vi.spyOn(composition, "composeRemoteApproval");
  let server: ReturnType<typeof createDashboardServer> | undefined;
  try {
    await db.migrate(); writeFileSync(join(root, "index.html"), "<!doctype html><title>fixture</title>");
    server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
    const origin = `http://127.0.0.1:${server.address.port}`;
    for (const path of ["/api/v1/health", "/api/v1/session"]) {
      const response = await fetch(origin + path); expect(response.status).toBe(200); await response.text();
    }
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); server?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("loads the source policy without trusting the current directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-policy-cwd-"));
  const db = new AuthorityDb(join(root, "authority.sqlite"));
  const previous = process.cwd();
  try {
    await db.migrate(); process.chdir(root);
    const service = composition.composeRemoteApproval(db);
    expect(service.options.policy.owner_principal).toBe("principal:owner");
    expect(service.readiness()).toEqual({ remote_ready: false, reason: "signer" });
  } finally { process.chdir(previous); db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("rejects a missing or malformed explicit policy before server construction", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-policy-invalid-"));
  const db = new AuthorityDb(join(root, "authority.sqlite"));
  try {
    await db.migrate();
    const policyPath = join(root, "policy.json");
    const options = { db, staticRoot: root, host: "127.0.0.1", port: 0, remoteApprovalPolicyPath: policyPath };
    const attempt = () => { const server = createDashboardServer(options); server.close(); };
    expect(attempt).toThrowError(expect.objectContaining({ code: "REMOTE_APPROVAL_POLICY_UNAVAILABLE" }));
    writeFileSync(policyPath, '{"invalid":true}');
    expect(attempt).toThrowError(expect.objectContaining({ code: "REMOTE_APPROVAL_POLICY_UNAVAILABLE" }));
    writeFileSync(policyPath, Buffer.alloc(262145, 32));
    expect(attempt).toThrowError(expect.objectContaining({ code: "REMOTE_APPROVAL_POLICY_UNAVAILABLE" }));
    writeFileSync(policyPath, readFileSync(fileURLToPath(new URL("../../config/personal-os-policy.json", import.meta.url))));
    const server = createDashboardServer(options);
    try {
      // The chosen policy is a startup snapshot; later requests never reread this file.
      writeFileSync(policyPath, "invalid after startup");
      const response = await fetch(`http://127.0.0.1:${server.address.port}/api/v1/health`);
      expect(response.status).toBe(200); await response.text();
    } finally { server.close(); }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("resolves an explicitly requested CLI policy and closes its database on policy failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-policy-cli-"));
  const path = join(root, "authority.sqlite");
  const db = new AuthorityDb(path); await db.migrate(); db.close();
  const close = vi.spyOn(AuthorityDb.prototype, "close");
  try {
    const options = parseDashboardCli(["--host", "127.0.0.1", "--port", "0", "--db", path,
      "--static-root", root, "--policy", join(root, "missing.json")]);
    expect(options.policyPath).toBe(join(root, "missing.json"));
    expect(() => startDashboardCli(options)).toThrowError(expect.objectContaining({ code: "REMOTE_APPROVAL_POLICY_UNAVAILABLE" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => composition.composeRemoteApproval(db, { policyPath: "relative.json" }))
      .toThrowError(expect.objectContaining({ code: "REMOTE_APPROVAL_POLICY_UNAVAILABLE" }));
  } finally { close.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
