import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JarvisError } from "../../src/jarvis-error.js";
import { personalConnectorDefinition } from "../../src/personal-connector-definitions.js";
import {
  CORE5_INTEGRATION_AUDIENCE,
  CORE5_INTEGRATION_CAPABILITIES,
  Core5CapabilityRegistry,
  Core5OperationLedger,
  StaticVerifiedIssuer,
  SyntheticReadOnlyExecutor,
  applyCancellation,
  decideCancellation,
  isCore5IntegrationEnabled,
  loadIntegrationFixture,
  loadIntegrationSchema,
  parseApprovalRef,
  parseCommandEnvelope,
  parseEvidenceRef,
  parseExecutionResult,
  verifyCallerRequest,
} from "../../src/integration/index.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { tempDb } from "../helpers.js";

const goldenEnvelope = () => parseCommandEnvelope(loadIntegrationFixture("command-envelope.golden.json"));

function issuer() {
  return new StaticVerifiedIssuer({
    principal: "operator:test",
    workspace: "ws:jarvis-shadow",
    audience: CORE5_INTEGRATION_AUDIENCE,
  });
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(JarvisError);
    expect((error as JarvisError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function ledger() {
  const db = await migratedTestDatabase(tempDb());
  return { db, store: new Core5OperationLedger(db.db) };
}

describe("core5 K02 contracts", () => {
  it("loads CommandEnvelope, ExecutionResult, EvidenceRef, ApprovalRef schemas and goldens", () => {
    expect(loadIntegrationSchema("command-envelope.schema.json")["title"]).toBe("CommandEnvelope");
    expect(loadIntegrationSchema("execution-result.schema.json")["title"]).toBe("ExecutionResult");
    expect(loadIntegrationSchema("evidence-ref.schema.json")["title"]).toBe("EvidenceRef");
    expect(loadIntegrationSchema("approval-ref.schema.json")["title"]).toBe("ApprovalRef");
    const envelope = goldenEnvelope();
    expect(envelope.operation_id).not.toBe(envelope.attempt_id);
    expect(envelope.operation_id).not.toBe(envelope.lease_fence);
    expect(envelope.attempt_id).not.toBe(envelope.lease_fence);
    expect(parseExecutionResult(loadIntegrationFixture("execution-result.golden.json")).status).toBe("SUCCESS");
    expect(parseEvidenceRef(loadIntegrationFixture("evidence-ref.golden.json")).kind).toBe("synthetic_read");
    expect(parseApprovalRef(loadIntegrationFixture("approval-ref.golden.json")).approval_id).toBe("appr:1");
  });

  it("rejects collapsed operation/attempt/fence identities", () => {
    const raw = { ...goldenEnvelope(), attempt_id: goldenEnvelope().operation_id };
    expect(() => parseCommandEnvelope(raw)).toThrowError(JarvisError);
  });
});

describe("core5 J01 capability registry", () => {
  it("defaults CORE5_INTEGRATION_ENABLED off", () => {
    expect(isCore5IntegrationEnabled({})).toBe(false);
    expect(isCore5IntegrationEnabled({ CORE5_INTEGRATION_ENABLED: "0" })).toBe(false);
    expect(isCore5IntegrationEnabled({ CORE5_INTEGRATION_ENABLED: "true" })).toBe(true);
    const registry = new Core5CapabilityRegistry({});
    expect(registry.enabled()).toBe(false);
    expect(registry.list().map(item => item.id)).toEqual([...CORE5_INTEGRATION_CAPABILITIES]);
    expect(registry.list().every(item => item.enabled === false && item.live_send === false)).toBe(true);
    expectCode(() => registry.get("mail.send"), "CORE5_LIVE_SEND_NOT_REGISTERED");
    expect(registry.personalMailConfigured()).toBe(false);
    expect(personalConnectorDefinition("mail").configured).toBe(false);
  });

  it("does not activate live Mail send when the flag is on", () => {
    const registry = new Core5CapabilityRegistry({ CORE5_INTEGRATION_ENABLED: "1" });
    expect(registry.requireEnabled("mail.read").live_send).toBe(false);
    expectCode(() => registry.get("mail.send"), "CORE5_LIVE_SEND_NOT_REGISTERED");
    expect(personalConnectorDefinition("mail").configured).toBe(false);
  });
});

describe("core5 J02 verified caller", () => {
  it("accepts issuer-verified principal/workspace/purpose/expiry/audience", () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    const caller = verifyCallerRequest({ caller: goldenEnvelope().caller }, issuer(), now);
    expect(caller.audience).toBe(CORE5_INTEGRATION_AUDIENCE);
  });

  it("rejects self-asserted permission on the request", () => {
    const now = new Date("2026-09-20T00:00:00.000Z");
    expectCode(() => verifyCallerRequest({
      caller: goldenEnvelope().caller,
      permission: "admin",
    }, issuer(), now), "CORE5_CALLER_SELF_ASSERTED_PERMISSION");
    expectCode(() => verifyCallerRequest({
      caller: { ...goldenEnvelope().caller, roles: ["admin"] },
    }, issuer(), now), "CORE5_CALLER_SELF_ASSERTED_PERMISSION");
    expectCode(() => issuer().verify({
      ...goldenEnvelope().caller,
      principal: "forged",
    }, now), "CORE5_CALLER_UNVERIFIED");
  });
});

describe("core5 J03 operation ledger", () => {
  it("persists mapping and refuses a new lease for the same approved operation", async () => {
    const { db, store } = await ledger();
    const envelope = goldenEnvelope();
    const first = store.schedule(envelope);
    expect(first.operation_id).toBe(envelope.operation_id);
    expect(first.attempt_id).toBe(envelope.attempt_id);
    expect(first.lease_fence).toBe(envelope.lease_fence);
    expect(first.approval_digest).toBe(envelope.approval_ref?.digest);
    expectCode(() => store.schedule({ ...envelope, attempt_id: "att:02", lease_fence: "fence:8" }), "CORE5_DUPLICATE_SIDE_EFFECT");
    const timeout: ReturnType<typeof store.recordResult> = store.recordResult({
      schema_version: 1,
      operation_id: envelope.operation_id,
      attempt_id: envelope.attempt_id,
      lease_fence: envelope.lease_fence,
      status: "TIMEOUT",
    });
    expect(store.classify(timeout.outcome as "TIMEOUT")).toBe("neither");
    expect(store.classify("UNCERTAIN")).toBe("neither");
    expect(store.classify("SUCCESS")).toBe("success");
    expect(store.classify("FAIL")).toBe("fail");
    db.close();
  });
});

describe("core5 J05 ADR", () => {
  it("records isolated compare and not-adopted", () => {
    const path = fileURLToPath(new URL("../../docs/adr/core5-j05-dbos-compare.md", import.meta.url));
    const body = readFileSync(path, "utf8");
    expect(body).toMatch(/not adopted/i);
    expect(body).toMatch(/Do not migrate the production engine/);
  });
});

describe("core5 J06 cancellation and synthetic executor", () => {
  it("distinguishes cancel vs possible external effect", () => {
    expect(decideCancellation("none").status).toBe("CANCELLED");
    expect(decideCancellation("possible").status).toBe("CANCELLED_AFTER_POSSIBLE_EFFECT");
    expectCode(() => applyCancellation({ status: "SUCCESS" }, "none"), "CORE5_CANCEL_AFTER_TERMINAL");
  });

  it("runs a synthetic read-only executor against the contract", async () => {
    const { db, store } = await ledger();
    const executor = new SyntheticReadOnlyExecutor(
      new Core5CapabilityRegistry({ CORE5_INTEGRATION_ENABLED: "1" }),
      store,
    );
    const result = executor.execute(goldenEnvelope());
    expect(result.status).toBe("SUCCESS");
    expect(result.evidence_refs?.[0]?.kind).toBe("synthetic_read");
    expectCode(() => executor.execute({ ...goldenEnvelope(), capability: "mail.draft" }), "CORE5_SYNTHETIC_READ_ONLY");
    db.close();
  });

  it("records CANCELLED_AFTER_POSSIBLE_EFFECT on the ledger", async () => {
    const { db, store } = await ledger();
    const executor = new SyntheticReadOnlyExecutor(
      new Core5CapabilityRegistry({ CORE5_INTEGRATION_ENABLED: "1" }),
      store,
    );
    const cancelled = executor.cancel(goldenEnvelope(), "possible");
    expect(cancelled.status).toBe("CANCELLED_AFTER_POSSIBLE_EFFECT");
    expect(store.get(goldenEnvelope().operation_id)?.outcome).toBe("CANCELLED_AFTER_POSSIBLE_EFFECT");
    db.close();
  });
});

describe("core5 J04 hold", () => {
  it("records Mail M04 unblocked and keeps mail.send off the product path", () => {
    const hold = fileURLToPath(new URL("../../docs/core5/J04-HOLD.md", import.meta.url));
    expect(existsSync(hold)).toBe(true);
    expect(readFileSync(hold, "utf8")).toMatch(/unblocked by Mail M04/);
    const productIndex = readFileSync(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), "utf8");
    expect(productIndex).not.toMatch(/mail\.send/);
    expect(existsSync(fileURLToPath(new URL("../../docs/core5/J04.md", import.meta.url)))).toBe(true);
  });
});

describe("core5 K01 baseline record", () => {
  it("is a read-only JSON snapshot", () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/core5-k01-baseline.json", import.meta.url)), "utf8"));
    expect(raw.read_only).toBe(true);
    expect(raw.repos[0].head).toBe("82dc6f388df077b2544713aeae2f5d6741fb9b03");
  });
});
