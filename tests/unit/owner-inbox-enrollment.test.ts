import { describe, expect, it } from "vitest";
import { JarvisError } from "../../src/db.js";
import { enrollOwnerPasskey, issueEnrollmentCode } from "../../src/owner-inbox-enrollment.js";
import { initialized } from "../helpers.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const ORIGIN = "https://jm-acloud.alpines-goldeye.ts.net:8444";
const attestation = { id: "cred", clientDataJSON: "e30", attestationObject: "e30" };
const pass = async () => ({ ok: true as const, publicKey: Buffer.from("pk"), counter: 1 });

describe("owner inbox enrollment", () => {
  it("rejects a wrong code, a reused code, an expired code, and a bad origin", async () => {
    const db = await initialized();
    const issued = issueEnrollmentCode(db, NOW);
    await expect(enrollOwnerPasskey(db, {
      code: "wrong-code-value", attestation, origin: ORIGIN, expectedOrigin: ORIGIN, rpId: "jm-acloud.alpines-goldeye.ts.net", now: NOW, check: pass,
    })).rejects.toThrow(/OWNER_INBOX_IDENTITY_REQUIRED/);
    await expect(enrollOwnerPasskey(db, {
      code: issued.code, attestation, origin: "https://evil.example", expectedOrigin: ORIGIN, rpId: "evil.example", now: NOW, check: pass,
    })).rejects.toThrow(/OWNER_INBOX_IDENTITY_REQUIRED/);
    await enrollOwnerPasskey(db, {
      code: issued.code, attestation, origin: ORIGIN, expectedOrigin: ORIGIN, rpId: "jm-acloud.alpines-goldeye.ts.net", now: NOW, check: pass,
    });
    await expect(enrollOwnerPasskey(db, {
      code: issued.code, attestation, origin: ORIGIN, expectedOrigin: ORIGIN, rpId: "jm-acloud.alpines-goldeye.ts.net", now: NOW, check: pass,
    })).rejects.toThrow(/OWNER_INBOX_REPLAY/);
    const expired = issueEnrollmentCode(db, NOW);
    await expect(enrollOwnerPasskey(db, {
      code: expired.code, attestation, origin: ORIGIN, expectedOrigin: ORIGIN, rpId: "jm-acloud.alpines-goldeye.ts.net",
      now: new Date(NOW.getTime() + 11 * 60_000), check: pass,
    })).rejects.toThrow(/OWNER_INBOX_EXPIRED/);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM audit_facts WHERE subject_id='enrollment'").get()).toEqual({ n: 5 });
    db.close();
  });

  it("stores only the public key, credential id, and counter", async () => {
    const db = await initialized();
    const issued = issueEnrollmentCode(db, NOW);
    const enrolled = await enrollOwnerPasskey(db, {
      code: issued.code, attestation, origin: ORIGIN, expectedOrigin: ORIGIN, rpId: "jm-acloud.alpines-goldeye.ts.net", now: NOW, check: pass,
    });
    expect(enrolled).toEqual({ credential_id: "cred" });
    const row = db.db.prepare("SELECT credential_id, counter FROM owner_inbox_credentials").get() as { credential_id: string; counter: number };
    expect(row).toEqual({ credential_id: "cred", counter: 1 });
    expect(JSON.stringify(row)).not.toContain(issued.code);
    db.close();
  });
});

void JarvisError;
