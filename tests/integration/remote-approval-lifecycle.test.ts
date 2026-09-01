import { describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { initialized } from "../helpers.js";
import { createRemoteService } from "../fixtures/remote-approval-support.js";
import { createP256Authenticator } from "../fixtures/webauthn-p256.js";

describe("remote approval lifecycle", () => {
  it("creates a singleton principal and at most one active owner enrollment without a second user", async () => {
    const db = await initialized();
    const now = new Date();
    const service = createRemoteService(db);
    const first = service.ensureOwner(now);
    const second = service.ensureOwner(now);
    expect(second.principal_id).toBe(first.principal_id);
    const authenticator = createP256Authenticator(first.user_handle);
    service.installActiveCredential({
      credential_id: authenticator.credentialIdB64, public_key_cose: authenticator.coseKey,
      algorithm: -7, sign_count: 0, backup_eligible: 0, backup_state: 0, now,
    });
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM remote_owner_principals_v2").get() as { n: number }).n).toBe(1);
    expect(() => service.installActiveCredential({
      credential_id: authenticator.credentialIdB64, public_key_cose: authenticator.coseKey,
      algorithm: -7, sign_count: 0, backup_eligible: 0, backup_state: 0, now,
    })).toThrow();
    expect(new ControlPlane(db).list().every(item => !item.action.startsWith("remote.") || item.requested_by !== "anonymous")).toBe(true);
    db.close();
  });
});
