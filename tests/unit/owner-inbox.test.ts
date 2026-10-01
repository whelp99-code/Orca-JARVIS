import { describe, expect, it } from "vitest";
import { controlCommandDigest, type ControlCommandRequestInput } from "../../src/control-plane-contract.js";
import { JarvisError } from "../../src/db.js";
import { OwnerInbox } from "../../src/owner-inbox.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { initialized, localKey } from "../helpers.js";

const NOW = new Date("2026-09-30T00:00:00.000Z");
const LATER = "2026-09-30T01:00:00.000Z";

function request(id: string, action: string, expires = LATER): ControlCommandRequestInput {
  return {
    schema_version: 1,
    request_id: id,
    action,
    action_level: 3,
    target: { candidate_id: id },
    args: { note: "staged" },
    reversible: false,
    requested_by: "principal:owner",
    requested_at: NOW.toISOString(),
    expires_at: expires,
    nonce: `nonce:${id}`,
  };
}

function insert(db: Awaited<ReturnType<typeof initialized>>, input: ControlCommandRequestInput): string {
  const digest = controlCommandDigest(input);
  db.db.prepare(
    `INSERT INTO control_command_requests(
      request_id, action, action_level, target_json, args_json, command_digest, reversible,
      requested_by, requested_at, expires_at, nonce, state, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?)`,
  ).run(
    input.request_id, input.action, input.action_level, JSON.stringify(input.target), JSON.stringify(input.args),
    digest, 0, input.requested_by, input.requested_at, input.expires_at, input.nonce, input.requested_at,
  );
  return digest;
}

describe("owner inbox", () => {
  it("lists only pending allowlisted requests and signs exactly one matching digest", async () => {
    const db = await initialized();
    const digest = insert(db, request("req-confirm", "memory.confirm"));
    insert(db, request("req-other", "workflow.start"));
    insert(db, request("req-old", "memory.outbox.dispatch", "2026-09-29T00:00:00.000Z"));
    const inbox = new OwnerInbox(db, new ControlReceiptSigner(localKey(db), "decision-test", "test-operator"), true, () => NOW);
    expect(inbox.list().map(item => item.request_id)).toEqual(["req-confirm", "req-old"]);
    expect(inbox.list().find(item => item.request_id === "req-old")?.expired).toBe(true);
    expect(JSON.stringify(inbox.list())).not.toContain("PRIVATE");
    db.db.prepare("INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)").run("cred-1", Buffer.from("pk"), 0, NOW.toISOString());
    const issued = inbox.issueChallenge({ request_id: "req-confirm", decision: "approve", command_digest: digest, session_id: "session-1" });
    const decided = await inbox.decide({
      request_id: "req-confirm", decision: "approve", command_digest: digest, session_id: "session-1",
      challenge_id: issued.challenge_id,
      assertion: { id: "cred-1", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
      origin: "http://127.0.0.1:4173", rpId: "127.0.0.1",
      check: async () => ({ ok: true, newCounter: 1 }),
    });
    expect(decided).toEqual({ request_id: "req-confirm", state: "approved" });
    expect(inbox.list().map(item => item.request_id)).toEqual(["req-old"]);
    const audit = db.db.prepare("SELECT fact_type, subject_id FROM audit_facts WHERE subject_id=?").get("req-confirm") as {
      fact_type: string;
    };
    expect(audit.fact_type).toBe("owner_inbox_attempt");
    await expect(inbox.decide({
      request_id: "req-confirm", decision: "approve", command_digest: digest, session_id: "session-1",
      challenge_id: issued.challenge_id,
      assertion: { id: "cred-1", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
      origin: "http://127.0.0.1:4173", rpId: "127.0.0.1",
      check: async () => ({ ok: true, newCounter: 2 }),
    })).rejects.toThrow(/OWNER_INBOX_REPLAY/);
  });

  it("refuses a mismatched digest, a forbidden action, a missing session, and an unconfigured key", async () => {
    const db = await initialized();
    const digest = insert(db, request("req-confirm", "memory.confirm"));
    insert(db, request("req-other", "workflow.start"));
    const inbox = new OwnerInbox(db, new ControlReceiptSigner(localKey(db), "decision-test", "test-operator"), true, () => NOW);
    await expect(inbox.decide({
      request_id: "req-confirm", decision: "approve", command_digest: "sha256:nope", session_id: "session-1",
      challenge_id: "missing", assertion: undefined, origin: "http://127.0.0.1", rpId: "127.0.0.1", check: async () => ({ ok: false }),
    })).rejects.toThrow(/OWNER_INBOX_DIGEST_MISMATCH/);
    await expect(inbox.decide({
      request_id: "req-other", decision: "approve", command_digest: digest, session_id: "session-1",
      challenge_id: "missing", assertion: undefined, origin: "http://127.0.0.1", rpId: "127.0.0.1", check: async () => ({ ok: false }),
    })).rejects.toThrow(/OWNER_INBOX_ACTION_FORBIDDEN/);
    await expect(inbox.decide({
      request_id: "req-confirm", decision: "reject", command_digest: digest, session_id: "",
      challenge_id: "missing", assertion: undefined, origin: "http://127.0.0.1", rpId: "127.0.0.1", check: async () => ({ ok: false }),
    })).rejects.toThrow(/OWNER_INBOX_IDENTITY_REQUIRED/);
    const unready = new OwnerInbox(db, new ControlReceiptSigner(localKey(db), "decision-test", "test-operator"), false, () => NOW);
    await expect(unready.decide({
      request_id: "req-confirm", decision: "approve", command_digest: digest, session_id: "session-1",
      challenge_id: "missing", assertion: { id: "x", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
      origin: "http://127.0.0.1", rpId: "127.0.0.1", check: async () => ({ ok: true, newCounter: 1 }),
    })).rejects.toThrow(/OWNER_INBOX_UNCONFIGURED/);
    expect(db.db.prepare("SELECT state FROM control_command_requests WHERE request_id='req-confirm'").get()).toEqual({ state: "pending" });
  });
});
