import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { composeRemoteApproval } from "../../src/remote-approval-compose.js";
import { initialized, localKey } from "../helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function keyFile(pem: string): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-decision-key-"));
  roots.push(root);
  const path = join(root, "decision.pem");
  writeFileSync(path, pem, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe("production remote approval composition", () => {
  it("is ready only when the configured key matches the sealed decision key", async () => {
    const db = await initialized();
    try {
      const missing = composeRemoteApproval(db);
      expect(missing.readiness().remote_ready).toBe(false);
      expect(missing.readiness().reason).toBe("signer_unconfigured");
      const mismatched = composeRemoteApproval(db, { decisionKeyPath: keyFile(
        generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ) });
      expect(mismatched.readiness()).toEqual({ remote_ready: false, reason: "signer_mismatch" });
      const matched = composeRemoteApproval(db, {
        decisionKeyPath: keyFile(localKey(db).export({ type: "pkcs8", format: "pem" }).toString()),
      });
      expect(matched.readiness()).toEqual({ remote_ready: true, reason: null });
    } finally {
      db.close();
    }
  });
});
