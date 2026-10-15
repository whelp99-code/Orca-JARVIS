import { readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { ControlPlane } from "../../src/control-plane.js";
import { controlCommandDigest } from "../../src/control-plane-contract.js";
import { decodeStoredControlCommand, readControlCommand } from "../../src/control-command-read.js";
import { stageControlCommand } from "../../src/control-command-stage.js";
import { importCompanyPage } from "../../src/company-candidate-import.js";
import {
  companyHandoffKeyV2, decodeCompanyCommandV2, parseCompanyCommandV2, parseCompanyHandoffV2,
} from "../../src/company-candidate-v2-contract.js";
import { OwnerInbox } from "../../src/owner-inbox.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import type { CompanyContext } from "../../src/company-candidate-transport.js";
import {
  COMPANY_CONTEXT, COMPANY_NOW, COMPANY_OWNER_KEY, companyDatabase, companyPage, companyProposal,
} from "../fixtures/company-candidate.js";

const fixture = JSON.parse(readFileSync("fixtures/company-approver/company-approver-v2.test-only.json", "utf8")) as {
  handoff_key: string;
  command: { schema_version: 2; request_id: string; requested_at: string; expires_at: string; args: { approver_principal_id: string } };
  command_digest: string;
  command_validity: { cases: { name: string; now: string; expected_valid: boolean }[] };
  generation_validation: {
    previous_command: { request_id: string; requested_at: string };
    previous_command_digest: string;
    validation_time: string;
    cases: { name: string; command: { request_id: string }; command_digest: string; expected_valid: boolean }[];
  };
};

const V2_CONTEXT: CompanyContext = {
  provider_instance_id: "provider:TEST_ONLY",
  workspace_id: "11111111-1111-4111-8111-111111111111",
  owner: "principal:mail-ms",
  agent_id: "agent:test",
  session_id: "session:test",
  projects: ["project:alpha", "project:beta"],
  policy_revision: "policy:TEST_ONLY:v1",
  deletion_sequence: 0,
  deletion_set_root: "sha256:6bc4dd546ebd5fde9c03b4b8f08133ef224a7e6e68922ba05c7ed6a259a5e102",
  processor_principal_id: "principal:company-candidate-processor",
};

function pageOf(command: object, digest: string, key = companyHandoffKeyV2(command as { target: never; args: never })) {
  return { handoffs: [{ idempotency_key: key, command, command_digest: digest }], count: 1, limit: 100, offset: 0 };
}

function inbox(db: AuthorityDb, now: Date) {
  return new OwnerInbox(db, new ControlReceiptSigner(COMPANY_OWNER_KEY, "company-owner", COMPANY_CONTEXT.owner), true, () => now);
}

describe("company command v2 storage", () => {
  it("uses Unicode character bounds consistently in storage and the v2 inbox", async () => {
    const live = await companyDatabase();
    try {
      const command = decodeCompanyCommandV2(fixture.command);
      command.target.candidate_id = "\u{1f4bc}".repeat(2048);
      const key = companyHandoffKeyV2(command);
      command.request_id = `${key}:1`; command.nonce = command.request_id;
      const at = new Date(command.requested_at);
      expect(parseCompanyCommandV2(command, at).target.candidate_id).toBe(command.target.candidate_id);
      importCompanyPage(live.db, pageOf(command, controlCommandDigest(command), key), V2_CONTEXT, at);
      expect(inbox(live.db, at).list().find(item => item.request_id === command.request_id)?.company_candidate?.candidate_id)
        .toBe(command.target.candidate_id);
      for (const invalid of ["x\u007f", "e\u0301", "\u{1f4bc}".repeat(2049)]) {
        const changed = structuredClone(command);
        changed.target.candidate_id = invalid;
        const changedKey = companyHandoffKeyV2(changed);
        changed.request_id = `${changedKey}:1`; changed.nonce = changed.request_id;
        expect(() => decodeCompanyCommandV2(changed)).toThrow("COMPANY_COMMAND_INVALID");
      }
    } finally { live.close(); }
  });

  it("requires the fixed millisecond UTC timestamp profile", () => {
    const command = decodeCompanyCommandV2(fixture.command);
    expect(() => decodeCompanyCommandV2({ ...command, requested_at: command.requested_at.replace(".000Z", "Z") }))
      .toThrow("COMPANY_COMMAND_INVALID");
  });

  it("keeps the fixture handoff key and command digest", () => {
    expect(companyHandoffKeyV2(fixture.command as never)).toBe(fixture.handoff_key);
    expect(controlCommandDigest(fixture.command as never)).toBe(fixture.command_digest);
    expect(decodeCompanyCommandV2(fixture.command).request_id).toBe(fixture.command.request_id);
  });

  it.each(fixture.command_validity.cases)("applies the active window for $name", ({ now, expected_valid }) => {
    const at = new Date(now);
    if (expected_valid) expect(parseCompanyCommandV2(fixture.command, at).schema_version).toBe(2);
    else expect(() => parseCompanyCommandV2(fixture.command, at)).toThrow(JarvisError);
  });

  it("stores version 2, refuses version mutation, and reopens the same digest", async () => {
    const live = await companyDatabase();
    try {
      const historical = companyProposal();
      const stagedV1 = new ControlPlane(live.db).stage(historical.command, COMPANY_NOW);
      expect(stagedV1.schema_version).toBe(1);
      expect(stagedV1.command_digest).toBe(historical.command_digest);
      const at = new Date(fixture.command.requested_at);
      importCompanyPage(live.db, pageOf(fixture.command, fixture.command_digest, fixture.handoff_key), V2_CONTEXT, at);
      const stored = readControlCommand(live.db, fixture.command.request_id);
      expect(stored?.schema_version).toBe(2);
      expect(stored?.command_digest).toBe(fixture.command_digest);
      const digestBefore = live.db.db.prepare("SELECT command_digest FROM control_command_requests WHERE request_id=?").get(fixture.command.request_id);
      const eventsBefore = live.db.db.prepare("SELECT COUNT(*) AS n FROM control_events WHERE subject=?").get(fixture.command.request_id);
      expect(() => live.db.db.prepare("UPDATE control_command_requests SET schema_version=1 WHERE request_id=?").run(fixture.command.request_id))
        .toThrow("immutable control command identity");
      expect(() => live.db.db.prepare("UPDATE control_command_requests SET schema_version=2 WHERE request_id=?").run(historical.command.request_id))
        .toThrow("immutable control command identity");
      expect(live.db.db.prepare("SELECT schema_version,command_digest FROM control_command_requests WHERE request_id=?").get(fixture.command.request_id))
        .toEqual({ schema_version: 2, command_digest: fixture.command_digest });
      expect(live.db.db.prepare("SELECT schema_version,command_digest FROM control_command_requests WHERE request_id=?").get(historical.command.request_id))
        .toEqual({ schema_version: 1, command_digest: historical.command_digest });
      expect(live.db.db.prepare("SELECT command_digest FROM control_command_requests WHERE request_id=?").get(fixture.command.request_id)).toEqual(digestBefore);
      expect(live.db.db.prepare("SELECT COUNT(*) AS n FROM control_events WHERE subject=?").get(fixture.command.request_id)).toEqual(eventsBefore);
      expect(live.db.db.prepare("UPDATE control_command_requests SET state='approved',lease_fence=4,lease_owner='worker' WHERE request_id=?").run(fixture.command.request_id).changes).toBe(1);
      live.db.db.prepare("UPDATE control_command_requests SET state='pending',lease_fence=0,lease_owner=NULL WHERE request_id=?").run(fixture.command.request_id);
      const filename = live.db.filename;
      live.db.close();
      const reopened = new AuthorityDb(filename);
      try {
        const again = readControlCommand(reopened, fixture.command.request_id);
        expect(again?.schema_version).toBe(2);
        expect(again?.command_digest).toBe(fixture.command_digest);
        expect(controlCommandDigest(again!)).toBe(fixture.command_digest);
      } finally { reopened.close(); }
    } finally { rmSync(live.root, { recursive: true, force: true }); }
  });

  it("rejects a stored version that is not 1, including company-incompatible 2", async () => {
    const live = await companyDatabase();
    try {
      expect(() => decodeStoredControlCommand({
        schema_version: undefined, request_id: "x", action: "memory.confirm", action_level: 3,
        target_json: "{}", args_json: "{}", command_digest: "sha256:" + "a".repeat(64), reversible: 0,
        requested_by: "principal:owner", requested_at: COMPANY_NOW.toISOString(), expires_at: COMPANY_NOW.toISOString(),
        nonce: "n", state: "pending",
      })).toThrow("CONTROL_COMMAND_INVALID");
      live.db.db.prepare(
        `INSERT INTO control_command_requests(request_id,action,action_level,target_json,args_json,command_digest,reversible,
         requested_by,requested_at,expires_at,nonce,state,created_at,schema_version)
         VALUES('other-v2','memory.confirm',3,'{}','{}',?,0,'principal:owner',?,?,?,'pending',?,2)`,
      ).run("sha256:" + "b".repeat(64), COMPANY_NOW.toISOString(), new Date(COMPANY_NOW.getTime() + 60_000).toISOString(), "nonce-other-v2", COMPANY_NOW.toISOString());
      const row = live.db.db.prepare("SELECT * FROM control_command_requests WHERE request_id='other-v2'").get() as Record<string, unknown>;
      expect(() => decodeStoredControlCommand(row)).toThrow("CONTROL_COMMAND_INVALID");
      const rejected = { ...fixture.command, schema_version: 2 as const, action: "memory.confirm" };
      expect(() => stageControlCommand(live.db, rejected as never, new Date(fixture.command.requested_at), () => {})).toThrow("CONTROL_COMMAND_INVALID");
      expect(live.db.db.prepare("SELECT COUNT(*) AS n FROM control_command_requests WHERE action='memory.confirm' AND request_id<>'other-v2'").get()).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("lists historical company v1 beside a new v2 handoff", async () => {
    const live = await companyDatabase();
    try {
      const historical = companyProposal();
      importCompanyPage(live.db, companyPage(historical), COMPANY_CONTEXT, COMPANY_NOW);
      importCompanyPage(live.db, pageOf(fixture.command, fixture.command_digest, fixture.handoff_key), V2_CONTEXT, new Date(fixture.command.requested_at));
      const items = inbox(live.db, COMPANY_NOW).list();
      const v1 = items.find(item => item.request_id === historical.command.request_id);
      const v2 = items.find(item => item.request_id === fixture.command.request_id);
      expect(v1?.company_candidate).toMatchObject({ owner: COMPANY_CONTEXT.owner, status: "imported" });
      expect(v1?.company_candidate).not.toHaveProperty("approver_principal_id");
      expect(v2?.company_candidate).toMatchObject({
        approver_principal_id: fixture.command.args.approver_principal_id,
        approval_policy_version: 1,
        status: "imported",
      });
    } finally { live.close(); }
  });

  it("rejects request replay and a generation that does not strictly increase", async () => {
    const live = await companyDatabase();
    try {
      const previous = fixture.generation_validation.previous_command;
      const first = importCompanyPage(live.db, pageOf(previous, fixture.generation_validation.previous_command_digest), V2_CONTEXT, new Date(previous.requested_at));
      expect(first.imported).toBe(1);
      const again = importCompanyPage(live.db, pageOf(previous, fixture.generation_validation.previous_command_digest), V2_CONTEXT, new Date(previous.requested_at));
      expect(again.duplicate).toBe(1);
      const at = new Date(fixture.generation_validation.validation_time);
      for (const item of fixture.generation_validation.cases) {
        const body = pageOf(item.command, item.command_digest);
        if (item.expected_valid) {
          expect(importCompanyPage(live.db, body, V2_CONTEXT, at).imported).toBe(1);
          expect(live.db.db.prepare("SELECT generation,current FROM company_candidate_handoffs WHERE request_id=?").get(item.command.request_id))
            .toEqual({ generation: 3, current: 1 });
        } else {
          expect(() => importCompanyPage(live.db, body, V2_CONTEXT, at)).toThrow(
            item.name === "reused_with_changed_bytes" ? "COMPANY_HANDOFF_REPLAY_CONFLICT" : "COMPANY_HANDOFF_GENERATION_CONFLICT",
          );
          if (item.name === "reused_with_changed_bytes") {
            expect(live.db.db.prepare("SELECT command_digest FROM control_command_requests WHERE request_id=?").get(item.command.request_id))
              .toEqual({ command_digest: fixture.generation_validation.previous_command_digest });
          } else {
            expect(live.db.db.prepare("SELECT 1 FROM control_command_requests WHERE request_id=?").get(item.command.request_id)).toBeUndefined();
          }
        }
      }
      const mismatched = parseCompanyHandoffV2;
      const brokenNonce = { ...fixture.command, nonce: "not-the-request" };
      expect(() => mismatched({ idempotency_key: fixture.handoff_key, command: brokenNonce, command_digest: fixture.command_digest })).toThrow("COMPANY_COMMAND_INVALID");
      expect(() => mismatched({
        idempotency_key: fixture.handoff_key, command: fixture.command, command_digest: "sha256:" + "c".repeat(64),
      })).toThrow("COMPANY_HANDOFF_INVALID");
    } finally { live.close(); }
  });

  it("keeps approval bindings immutable and finishes a progress reservation once", async () => {
    const live = await companyDatabase();
    try {
      const historical = companyProposal();
      new ControlPlane(live.db).stage(historical.command, COMPANY_NOW);
      live.db.db.prepare(
        `INSERT INTO company_approval_bindings(provider_instance_id,workspace_id,binding_json,binding_digest,registered_at)
         VALUES('provider:TEST_ONLY','11111111-1111-4111-8111-111111111111','{}','sha256:${"d".repeat(64)}',?)`,
      ).run(COMPANY_NOW.toISOString());
      expect(() => live.db.db.prepare("UPDATE company_approval_bindings SET binding_json='{\"x\":1}'").run()).toThrow("immutable company approval binding");
      expect(() => live.db.db.prepare("DELETE FROM company_approval_bindings").run()).toThrow("immutable company approval binding");
      live.db.db.prepare(
        `INSERT INTO company_freshness_checkpoints(provider_instance_id,workspace_id,checkpoint_json,updated_at) VALUES(?,?,?,?)`,
      ).run("provider:TEST_ONLY", "11111111-1111-4111-8111-111111111111", "{}", COMPANY_NOW.toISOString());
      expect(live.db.db.prepare("UPDATE company_freshness_checkpoints SET checkpoint_json='{\"n\":1}',updated_at=?").run(COMPANY_NOW.toISOString()).changes).toBe(1);
      live.db.db.prepare(
        `INSERT INTO company_progress_reservations(operation_id,provider_instance_id,workspace_id,request_id,operation,reservation_id,
         reserve_request_json,checkpoint_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run("op-1", "provider:TEST_ONLY", "11111111-1111-4111-8111-111111111111", historical.command.request_id, "decide_approve",
        "reservation-1", "{}", "{}", COMPANY_NOW.toISOString());
      expect(live.db.db.prepare(
        "UPDATE company_progress_reservations SET finished_checkpoint_json=?,evidence_digest=?,terminal_state=? WHERE operation_id=?",
      ).run("{}", "sha256:" + "e".repeat(64), "approved", "op-1").changes).toBe(1);
      expect(() => live.db.db.prepare("UPDATE company_progress_reservations SET terminal_state='rejected' WHERE operation_id='op-1'").run())
        .toThrow("immutable company progress reservation result");
      expect(() => live.db.db.prepare("UPDATE company_progress_reservations SET operation='decide_reject' WHERE operation_id='op-1'").run())
        .toThrow("immutable company progress reservation identity");
    } finally { live.close(); }
  });
});
