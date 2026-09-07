import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthorityDb } from "../../src/db.js";
import { GjcCoordinatorClient } from "../../src/gjc.js";
import { GjcRuntimeService } from "../../src/service.js";
import { initialized } from "../helpers.js";
import { gjcTaskFor, seedGjcDispatch } from "../fixtures/gjc-dispatch-fixture.js";

let db: AuthorityDb;
beforeEach(async () => { db = await initialized(); db.configureGjc(process.cwd(), "s", true); });
afterEach(() => { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); });

function reply(body: unknown) {
  return { exitCode: 0, stdout: [
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05",
      serverInfo: { name: "gjc-coordinator-mcp", version: "0.11.8" } } },
    { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(body) }] } },
  ].map(frame => JSON.stringify(frame)).join("\n") };
}

describe("GJC dispatch transport and authority boundary", () => {
  it.each(["code", "both"] as const)("sends the complete %s-authorized task in the published MCP shape", async authorization => {
    const source = seedGjcDispatch(db, authorization);
    const now = new Date();
    const calls: Record<string, unknown>[] = [];
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async run => {
      const frame = JSON.parse(run.stdin.trim().split("\n")[2]!) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      if (frame.params.name === "gjc_coordinator_read_turn") {
        return reply({ ok: true, turn: { session_id: "s", turn_id: "t", status: "completed" } });
      }
      if (frame.params.name === "gjc_coordinator_list_questions") return reply({ questions: [] });
      expect(frame.params.name).toBe("gjc_coordinator_send_prompt");
      const args = frame.params.arguments;
      calls.push(args);
      expect(Object.keys(args).sort()).toEqual(["allow_mutation", "idempotency_key", "prompt", "session_id"]);
      expect(args.session_id).toBe("s");
      expect(args.idempotency_key).toBe(source.idempotency_key);
      expect(JSON.parse(String(args.prompt))).toMatchObject({
        kind: "jarvis_authorized_continuation", intent_id: source.intent_id,
        continuation_id: source.continuation_id, authorization_reference: source.authorization_id,
        task: source.census.work[0],
      });
      return reply({ ok: true, turn: { session_id: "s", turn_id: "t", status: "accepted" } });
    }, true), "dispatch", undefined, () => now);
    try {
      await expect(service.once()).resolves.toMatchObject({ processed: source.intent_id, state: "accepted" });
      await expect(service.once()).resolves.toMatchObject({ state: "completed" });
      await expect(service.once()).resolves.toMatchObject({ processed: null });
    } finally { service.close(); }
    expect(calls).toHaveLength(1);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_dispatch_receipts").get()).toEqual({ n: 1 });
    expect(db.db.prepare("SELECT state FROM work_items WHERE id='codex-work'").get()).toEqual({ state: "continued" });
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE acked_at IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it.each(["expiry", "revocation", "key_revocation", "configuration", "scope", "fence", "budget"])(
    "rejects changed %s before any coordinator call", async change => {
      const source = seedGjcDispatch(db);
      let now = new Date();
      if (change === "expiry") now = new Date(source.authority_expires_at);
      if (change === "revocation") db.revokeAuthority(source.authorization_id, "test revocation");
      if (change === "key_revocation") {
        const key = db.db.prepare("SELECT key_id FROM policy_authorizations WHERE id=?")
          .get(source.authorization_id) as { key_id: string };
        db.revokeAuthority(key.key_id, "test key revocation");
      }
      if (change === "configuration") db.configureGjc(process.cwd(), "different-session", true);
      if (change === "scope") db.db.prepare("UPDATE work_items SET scope_json='{}' WHERE id='codex-work'").run();
      if (change === "fence") db.db.prepare("UPDATE work_items SET fencing_token=fencing_token+1 WHERE id='codex-work'").run();
      if (change === "budget") db.db.prepare("UPDATE work_items SET tokens_used=1000 WHERE id='codex-work'").run();
      let calls = 0;
      const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => {
        calls++; return reply({});
      }, true), "dispatch", undefined, () => now);
      try {
        await expect(service.once()).resolves.toMatchObject({ processed: source.intent_id, state: "failed" });
        expect(calls).toBe(0);
        expect(db.db.prepare("SELECT failure_code FROM gjc_intents WHERE intent_id=?").get(source.intent_id))
          .toEqual({ failure_code: "GJC_DISPATCH_NOT_AUTHORIZED" });
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM gjc_dispatch_receipts").get()).toEqual({ n: 0 });
      } finally { service.close(); }
    },
  );

  it("does not treat an arbitrary raw dispatch intent as execution authority", async () => {
    const intent = db.createGjcIntent("dispatch", { session_id: "s", prompt: "unapproved work" }, "raw");
    let calls = 0;
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => {
      calls++; return reply({});
    }, true));
    try {
      await expect(service.once()).resolves.toMatchObject({ processed: intent, state: "failed" });
      expect(calls).toBe(0);
    } finally { service.close(); }
  });

  it("never resends after a lost dispatch acknowledgment", async () => {
    const source = seedGjcDispatch(db);
    let calls = 0;
    const service = new GjcRuntimeService(db, new GjcCoordinatorClient(async () => {
      calls++; throw new Error("connection lost after delivery");
    }, true));
    try {
      await expect(service.once()).resolves.toMatchObject({ processed: source.intent_id, state: "uncertain" });
      await expect(service.once()).resolves.toMatchObject({ processed: null });
      expect(calls).toBe(1);
    } finally { service.close(); }
  });

  it("maps the CLI task schema and prevents another key from reusing consumed dispatch authority", () => {
    const source = seedGjcDispatch(db);
    const now = new Date().toISOString();
    const config = db.gjcConfig()!;
    const automatic = db.claimGjcIntent(source.intent_id, "setup", now)!;
    db.settleGjcIntent(source.intent_id, Number(automatic.lease_fence), { status: "failed", failure_code: "LOCAL_SETUP" }, now);
    const task = gjcTaskFor(db, source, "cli-task");
    const intent = db.createGjcDispatchFromTask(task, now);
    const claim = db.claimGjcIntent(intent, "cli", now)!;
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    const args = db.gjcDispatchArguments(intent, Number(claim.lease_fence), config, now);
    expect(Object.keys(args).sort()).toEqual(["prompt", "session_id"]);
    expect(JSON.parse(String(args.prompt)).task).toEqual(source.census.work[0]);
    expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    db.settleGjcIntent(intent, Number(claim.lease_fence), { status: "uncertain" }, now);
    const duplicate = db.createGjcDispatchFromTask({ ...task, idempotency_key: "another-key" }, now);
    const duplicateClaim = db.claimGjcIntent(duplicate, "cli", now)!;
    expect(() => db.gjcDispatchArguments(duplicate, Number(duplicateClaim.lease_fence), config, now))
      .toThrow("GJC_DISPATCH_NOT_AUTHORIZED");
  });

  it.each(["claimed", "accepted", "completed", "uncertain", "failed", "expired"] as const)(
    "blocks CLI redispatch after an automatic dispatch is %s", state => {
      const source = seedGjcDispatch(db);
      let now = new Date().toISOString();
      const automatic = db.claimGjcIntent(source.intent_id, "automatic", now, 1000)!;
      if (state === "expired") {
        now = new Date(Date.parse(now) + 1000).toISOString();
        expect(db.recoverExpiredGjcIntents(now)).toBe(1);
      } else if (state !== "claimed") {
        db.settleGjcIntent(source.intent_id, Number(automatic.lease_fence), {
          status: state, ...(state === "uncertain" ? {} : { receipt: { session_id: "s", turn_id: "sent-turn" } }),
        }, now);
      }
      const duplicate = db.createGjcDispatchFromTask(gjcTaskFor(db, source, "cli-replay"), now);
      const claim = db.claimGjcIntent(duplicate, "cli", now)!;
      expect(() => db.gjcDispatchArguments(duplicate, Number(claim.lease_fence), db.gjcConfig()!, now))
        .toThrow("GJC_DISPATCH_NOT_AUTHORIZED");
    },
  );
});
