import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-adapter.js";
import type {
  SecondBrainCallOptions,
  SecondBrainMethod,
  SecondBrainOutcome,
  SecondBrainTransport,
} from "../../src/second-brain-transport.js";
import { explicitMemoryInput, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  seedMemoryAuthority,
  type MemoryDatabase,
} from "../fixtures/memory-candidate-store.js";

class CapturingTransport implements SecondBrainTransport {
  readonly calls: Array<{
    readonly method: SecondBrainMethod;
    readonly arguments_: Readonly<Record<string, unknown>>;
  }> = [];
  constructor(private readonly outcome: SecondBrainOutcome) {}
  call(
    method: SecondBrainMethod,
    arguments_: Readonly<Record<string, unknown>>,
    options?: SecondBrainCallOptions,
  ): Promise<SecondBrainOutcome> {
    void options;
    this.calls.push({ method, arguments_ });
    return Promise.resolve(this.outcome);
  }
  restart(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
  diagnostics(): readonly [] { return []; }
}

const databases: MemoryDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) closeMemoryDatabase(database);
});
function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}
async function authorizedRequest(): Promise<{
  readonly database: MemoryDatabase;
  readonly request: Readonly<Record<string, unknown>>;
}> {
  const database = await memoryDatabase(); databases.push(database);
  const input = explicitMemoryInput();
  seedMemoryAuthority(database.authority, input);
  const classification = memoryCandidateStore(database.authority).classify(input);
  const receipt = {
    schema_version: 1,
    receipt_id: `receipt:memory:${"4".repeat(64)}`,
    candidate_id: classification.candidate_id,
    candidate_digest: classification.candidate_digest,
    classification_digest: classification.classification_digest,
    operation: classification.operation,
    decision: "auto_staged",
    principal_id: "principal:owner",
    issued_at: MEMORY_NOW,
    expires_at: "2026-08-28T12:05:00.000Z",
  };
  const identity = {
    candidate_id: classification.candidate_id,
    candidate_digest: classification.candidate_digest,
    classification_digest: classification.classification_digest,
    operation: classification.operation,
  };
  const idempotency = digest("orca-jarvis/memory-write-idempotency/v1\0", identity);
  const base = {
    schema_version: 1,
    ...identity,
    idempotency_key: `memidem:pos:v1:${idempotency.slice(7)}`,
    subject: "wiki/example-alpha",
    purpose: "personal_memory",
    sensitivity: classification.policy_sensitivity,
    retention_days: classification.retention_days,
    created_at: MEMORY_NOW,
    expires_at: "2026-08-28T13:00:00.000Z",
    expected_prior: null,
    receipt,
    receipt_digest: digest("orca-jarvis/memory-write-receipt/v1\0", receipt),
    payload: { content: "ExampleAlpha" },
  };
  const requestDigest = digest("orca-jarvis/memory-write-request/v1\0", base);
  return { database, request: { ...base, request_id: `memreq:pos:v1:${requestDigest.slice(7)}`,
    request_digest: requestDigest } };
}
function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}
function rederive(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const receiptValue = input["receipt"];
  if (typeof receiptValue !== "object" || receiptValue === null || Array.isArray(receiptValue)) return input;
  const receipt = Object.fromEntries(Object.entries(receiptValue));
  const identity = {
    candidate_id: input["candidate_id"], candidate_digest: input["candidate_digest"],
    classification_digest: input["classification_digest"], operation: input["operation"],
  };
  const idempotency = digest("orca-jarvis/memory-write-idempotency/v1\0", identity);
  const withDerived = { ...input, receipt,
    receipt_digest: digest("orca-jarvis/memory-write-receipt/v1\0", receipt),
    idempotency_key: `memidem:pos:v1:${idempotency.slice(7)}` };
  const base = Object.fromEntries(Object.entries(withDerived).filter(
    ([key]) => key !== "request_id" && key !== "request_digest",
  ));
  const requestDigest = digest("orca-jarvis/memory-write-request/v1\0", base);
  return { ...base, request_id: `memreq:pos:v1:${requestDigest.slice(7)}`,
    request_digest: requestDigest };
}
function accepted(request: Readonly<Record<string, unknown>>): SecondBrainOutcome {
  return { kind: "data", value: {
    schema_version: 1, kind: "accepted", state: "pending",
    candidate_id: request["candidate_id"], request_id: request["request_id"],
    request_digest: request["request_digest"], idempotency_key: request["idempotency_key"],
    operation: request["operation"], accepted_at: MEMORY_NOW,
    inbox_path: `inbox/.requests/pending/${String(request["request_id"])}.json`,
    request_file_digest: `sha256:${"4".repeat(64)}`, replayed: false,
  } };
}

describe("Second Brain write-request authority adapter", () => {
  it("dispatches once only for the exact persisted Task 27 candidate and claim", async () => {
    // Given
    const { database, request } = await authorizedRequest();
    const transport = new CapturingTransport(accepted(request));
    const adapter = createSecondBrainWriteRequestAdapter(
      transport, database.authority, () => new Date(MEMORY_NOW),
    );
    // When
    const result = await adapter.write(request);
    // Then
    expect(result).toMatchObject({ kind: "accepted", state: "pending", replayed: false });
    expect(transport.calls).toEqual([{ method: "sb_write_request", arguments_: { request } }]);
  });

  it("rejects an accepted result that is not exactly bound to the dispatched request", async () => {
    // Given
    const { database, request } = await authorizedRequest();
    const outcome = accepted({ ...request, candidate_id: `memcand:pos:v1:${"8".repeat(64)}` });
    const transport = new CapturingTransport(outcome);
    const adapter = createSecondBrainWriteRequestAdapter(
      transport, database.authority, () => new Date(MEMORY_NOW),
    );
    // When
    const result = await adapter.write(request);
    // Then
    expect(result).toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" });
    expect(transport.calls).toHaveLength(1);
  });

  it("rejects every malformed V1 invariant locally with zero transport and no authority mutation", async () => {
    // Given
    const { database, request } = await authorizedRequest();
    const transport = new CapturingTransport(accepted(request));
    const adapter = createSecondBrainWriteRequestAdapter(
      transport, database.authority, () => new Date(MEMORY_NOW),
    );
    const receipt = objectRecord(request["receipt"]);
    const cases: ReadonlyArray<Readonly<Record<string, unknown>>> = [
      { ...request, extra: true },
      rederive({ ...request, subject: "wiki/e\u0301" }),
      rederive({ ...request, retention_days: 0 }),
      rederive({ ...request, expected_prior: { source_id: "wiki/x", source_version: `git:${"1".repeat(40)}`,
        source_digest: `sha256:${"2".repeat(64)}` } }),
      rederive({ ...request, payload: { content: "x", extra: "y" } }),
      rederive({ ...request, receipt: { ...receipt, principal_id: "principal:other" } }),
      rederive({ ...request, receipt: { ...receipt, issued_at: "2026-08-28T11:59:59.999Z" } }),
      rederive({ ...request, expires_at: "2026-08-30T12:00:00.000Z" }),
      { ...request, request_digest: `sha256:${"0".repeat(64)}` },
      { ...request, idempotency_key: `memidem:pos:v1:${"0".repeat(64)}` },
      { ...request, candidate_digest: "sha256:ABC" },
    ];
    const before = database.authority.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_authority_claims",
    ).get();
    // When
    const results = await Promise.all(cases.map(value => adapter.write(value)));
    // Then
    expect(results).toEqual(cases.map(() => (
      { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" }
    )));
    expect(transport.calls).toEqual([]);
    expect(database.authority.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_authority_claims",
    ).get()).toEqual(before);
  });

  it("rejects unapproved, consumed, and revoked terminal authority with zero frames", async () => {
    // Given
    const rejectedCase = await authorizedRequest();
    const consumedCase = await authorizedRequest();
    const revokedCase = await authorizedRequest();
    rejectedCase.database.authority.db.prepare(
      "UPDATE memory_candidates SET state='rejected',updated_at=? WHERE candidate_id=?",
    ).run(MEMORY_NOW, rejectedCase.request["candidate_id"]);
    consumedCase.database.authority.db.prepare(
      "UPDATE memory_candidates SET state='queued',updated_at=? WHERE candidate_id=?",
    ).run(MEMORY_NOW, consumedCase.request["candidate_id"]);
    const terminal = objectRecord(revokedCase.database.authority.db.prepare(
      `SELECT control_request_id,control_receipt_id,control_command_digest
       FROM memory_candidate_classifications WHERE candidate_id=?`,
    ).get(revokedCase.request["candidate_id"]));
    revokedCase.database.authority.db.prepare(
      `INSERT INTO control_command_revocations(
        revocation_id,request_id,receipt_id,command_digest,reason,revoked_by,revoked_at,
        payload_json,payload_digest,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run("revocation-task28", terminal["control_request_id"], terminal["control_receipt_id"],
      terminal["control_command_digest"], "test", "local-owner", MEMORY_NOW, "{}",
      `sha256:${"9".repeat(64)}`, MEMORY_NOW);
    const transport = new CapturingTransport(accepted(rejectedCase.request));
    const adapters = [rejectedCase, consumedCase, revokedCase].map(value => (
      createSecondBrainWriteRequestAdapter(transport, value.database.authority, () => new Date(MEMORY_NOW))
    ));
    // When
    const results = await Promise.all(adapters.map((adapter, index) => (
      adapter.write([rejectedCase, consumedCase, revokedCase][index]?.request)
    )));
    // Then
    expect(results).toEqual(adapters.map(() => (
      { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" }
    )));
    expect(transport.calls).toEqual([]);
  });

  it("returns one generic error and zero frames for absent, mismatched, or stale authority", async () => {
    // Given
    const { database, request } = await authorizedRequest();
    const transport = new CapturingTransport(accepted(request));
    const adapter = createSecondBrainWriteRequestAdapter(
      transport, database.authority, () => new Date(MEMORY_NOW),
    );
    const missing = rederive({ ...request,
      candidate_id: `memcand:pos:v1:${"0".repeat(64)}`,
      receipt: { ...objectRecord(request["receipt"]),
        candidate_id: `memcand:pos:v1:${"0".repeat(64)}` },
    });
    const classificationDigest = `sha256:${"0".repeat(64)}`;
    const mismatched = rederive({ ...request, classification_digest: classificationDigest,
      receipt: { ...objectRecord(request["receipt"]), classification_digest: classificationDigest },
    });
    const staleAdapter = createSecondBrainWriteRequestAdapter(
      transport, database.authority, () => new Date("2026-08-28T12:06:00.000Z"),
    );
    // When
    const results = await Promise.all([
      adapter.write(missing), adapter.write(mismatched), staleAdapter.write(request),
    ]);
    // Then
    expect(results).toEqual(results.map(() => (
      { kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" }
    )));
    expect(transport.calls).toEqual([]);
  });
});
