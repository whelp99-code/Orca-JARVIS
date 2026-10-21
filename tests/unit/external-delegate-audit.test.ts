import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { expect, it } from "vitest";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { initialized } from "../helpers.js";

it("records low-risk retries once and rejects changed content under the same request id", async () => {
  const db = await initialized();
  const root = mkdtempSync(join(tmpdir(), "delegate-audit-"));
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, "t".repeat(40), { mode: 0o600 });
  const previous = process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE;
  process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE = tokenFile;
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    clock: () => new Date("2026-10-02T00:00:00Z"),
  });
  const origin = `http://127.0.0.1:${server.address.port}`;
  const body = { request_id: "audit-replay-001", action_kind: "mail.read", summary: "synthetic", payload_digest: `sha256:${"ab".repeat(32)}` };
  const audit = async (input: Record<string, unknown> = body) => {
    const result = await request(`${origin}/api/v1/internal/external-delegate/audit`, {
      method: "POST",
      headers: { host: new URL(origin).host, "content-type": "application/json", "x-jarvis-delegate-token": "t".repeat(40) },
      body: JSON.stringify(input),
    });
    await result.body.dump();
    return result.statusCode;
  };
  try {
    expect(await Promise.all([audit(), audit()])).toEqual([202, 202]);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM audit_facts WHERE fact_type='owner_inbox_attempt' AND json_extract(payload_json,'$.code')='LOW_RISK'").get()).toMatchObject({ n: 1 });
    expect(await audit({ ...body, payload_digest: `sha256:${"cd".repeat(32)}` })).toBe(409);
    expect(await audit({ ...body, summary: "different" })).toBe(409);
    expect(await audit({ action_kind: "mail.read", summary: "missing identity" })).toBe(400);
    expect(await audit({ ...body, request_id: "bad" })).toBe(400);
    expect(await audit({ ...body, payload_digest: "bad" })).toBe(400);
    expect(await audit({ ...body, request_id: "audit-replay-002" })).toBe(202);
  } finally {
    server.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE;
    else process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE = previous;
  }
});
