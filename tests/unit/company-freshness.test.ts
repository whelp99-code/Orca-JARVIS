import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import {
  companyCheckpointSchema,
  companyOperationId,
  companyOperationTerminalStates,
  finishProgressResponseSchema,
  freshnessReadResponseSchema,
  loadCompanyFreshness,
  reserveProgressResponseSchema,
  type CompanyCheckpoint,
  type CompanyFreshnessProvider,
  type CompanyProgressOperation,
  type FinishProgressRequest,
  type FinishProgressResponse,
  type FreshnessReadRequest,
  type ReserveProgressRequest,
  type ReserveProgressResponse,
} from "../../src/company-freshness.js";
import { JarvisError } from "../../src/jarvis-error.js";
import {
  createTestOnlyMemoryProvider,
  setTestOnlyMemoryCasProbe,
} from "../fixtures/company-freshness.js";

const fixture = JSON.parse(readFileSync(
  new URL("../../fixtures/company-approver/company-approver-v2.test-only.json", import.meta.url),
  "utf8",
)) as {
  freshness_provider: unknown;
  expected_unconfigured_error: unknown;
  unconfigured_progress_responses: {
    reserve_progress: unknown;
    finish_progress: unknown;
  };
  read_freshness: { request: FreshnessReadRequest; response: unknown };
  command: { request_id: string };
  command_digest: string;
  terminal_state_by_operation: Record<CompanyProgressOperation, string>;
  terminal_state_negative_cases: Array<{
    operation: CompanyProgressOperation;
    terminal_state: string;
    expected_valid: boolean;
  }>;
  test_only_memory: {
    factory_input: { scope: FreshnessReadRequest["scope"]; initial_checkpoint: CompanyCheckpoint };
    cases: Array<{
      name: string;
      operation: "read_freshness" | "reserve_progress" | "finish_progress";
      request: FreshnessReadRequest | ReserveProgressRequest | FinishProgressRequest;
      response: unknown;
    }>;
  };
};

const memory = fixture.test_only_memory;
const scope = memory.factory_input.scope;
const requiredError = fixture.expected_unconfigured_error;

function provider(): CompanyFreshnessProvider {
  return createTestOnlyMemoryProvider(structuredClone(memory.factory_input));
}

function apply(target: CompanyFreshnessProvider, entry: (typeof memory.cases)[number]): unknown {
  if (entry.operation === "read_freshness") return target.readFreshness(entry.request as FreshnessReadRequest);
  if (entry.operation === "reserve_progress") return target.reserveProgress(entry.request as ReserveProgressRequest);
  return target.finishProgress(entry.request as FinishProgressRequest);
}

function contractCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof JarvisError) return error.code;
    throw error;
  }
  return "";
}

function domainDigest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(`${domain}\0`).update(canonicalize(value)).digest("hex")}`;
}

function progressRoot(previousRoot: string, sequence: number, record: Record<string, string>): string {
  return domainDigest("second-brain/TEST_ONLY-memory-progress/v1", {
    previous_root: previousRoot,
    sequence,
    record,
  });
}

function operationId(operation: CompanyProgressOperation): string {
  if (operation === "delete") return companyOperationId({ scope, deletion_plan_digest: fixture.command_digest, operation });
  return companyOperationId({
    scope,
    request_id: fixture.command.request_id,
    command_digest: fixture.command_digest,
    operation,
  });
}

function reserveRequest(
  operation: CompanyProgressOperation,
  expected: CompanyCheckpoint,
  challenge: string,
  eventDigest?: string,
): ReserveProgressRequest {
  const sample = memory.cases.find(entry => entry.operation === "reserve_progress")!.request as ReserveProgressRequest;
  const digest = eventDigest ?? sample.event_digest;
  return {
    ...sample,
    operation_id: operationId(operation),
    operation,
    expected_checkpoint: structuredClone(expected),
    event_digest: digest,
    challenge,
  };
}

afterEach(() => {
  setTestOnlyMemoryCasProbe(undefined);
});

describe("company freshness contract", () => {
  it("replays the ten memory cases and the unconfigured vectors", () => {
    const memoryProvider = provider();
    for (const entry of memory.cases) {
      expect(apply(memoryProvider, entry)).toEqual(entry.response);
    }
    const unconfigured = loadCompanyFreshness(fixture.freshness_provider);
    expect(unconfigured.readFreshness(fixture.read_freshness.request)).toEqual(fixture.read_freshness.response);
    const reserve = memory.cases.find(entry => entry.name === "reserve_winner")!.request as ReserveProgressRequest;
    const finish = memory.cases.find(entry => entry.name === "finish_winner")!.request as FinishProgressRequest;
    expect(unconfigured.reserveProgress(reserve)).toEqual(fixture.unconfigured_progress_responses.reserve_progress);
    expect(unconfigured.finishProgress(finish)).toEqual(fixture.unconfigured_progress_responses.finish_progress);
    expect(unconfigured.reserveProgress(reserve)).toEqual(requiredError);
    expect(freshnessReadResponseSchema.parse(fixture.read_freshness.response)).toEqual(fixture.read_freshness.response);
  });

  it("pins operation ids and terminal states to fixture machine values", () => {
    expect(companyOperationTerminalStates).toEqual(fixture.terminal_state_by_operation);
    const acceptId = operationId("accept");
    expect(acceptId).toBe(domainDigest("second-brain/company-operation/v1", {
      scope,
      request_id: fixture.command.request_id,
      command_digest: fixture.command_digest,
      operation: "accept",
    }));
    expect(acceptId).toBe((memory.cases.find(entry => entry.name === "reserve_winner")!.request as ReserveProgressRequest).operation_id);
    expect(operationId("accept")).toBe(acceptId);
    expect(operationId("delete")).toBe(domainDigest("second-brain/company-operation/v1", {
      scope, deletion_plan_digest: fixture.command_digest, operation: "delete",
    }));
    expect(contractCode(() => companyOperationId({
      scope, request_id: fixture.command.request_id, command_digest: fixture.command_digest, operation: "delete",
    } as never))).toBe("COMPANY_CONTRACT_INVALID");
    expect(contractCode(() => companyOperationId({
      scope,
      request_id: fixture.command.request_id,
      command_digest: fixture.command_digest,
      operation: "accept",
      epoch: 1,
      retried_at: "2026-10-15T00:00:00.000Z",
    } as never))).toBe("COMPANY_CONTRACT_INVALID");
  });

  it("rejects mixed and malformed response objects", () => {
    const reserved = memory.cases.find(entry => entry.name === "reserve_winner")!.response as Record<string, unknown>;
    const recorded = memory.cases.find(entry => entry.name === "finish_winner")!.response as Record<string, unknown>;
    const ready = memory.cases.find(entry => entry.name === "ready")!.response as Record<string, unknown>;
    expect(reserveProgressResponseSchema.safeParse(requiredError).success).toBe(true);
    expect(finishProgressResponseSchema.safeParse(requiredError).success).toBe(true);
    expect(reserveProgressResponseSchema.safeParse({ ...requiredError as object, scope }).success).toBe(false);
    expect(finishProgressResponseSchema.safeParse({ ...requiredError as object, checkpoint: null }).success).toBe(false);
    expect(reserveProgressResponseSchema.safeParse({ ...reserved, code: "COMPANY_FRESHNESS_REQUIRED" }).success).toBe(false);
    expect(reserveProgressResponseSchema.safeParse({ ...reserved, reservation_id: null }).success).toBe(false);
    expect(finishProgressResponseSchema.safeParse({ ...recorded, reservation_id: reserved.reservation_id }).success).toBe(false);
    expect(finishProgressResponseSchema.safeParse({ ...recorded, checkpoint: null }).success).toBe(false);
    expect(freshnessReadResponseSchema.safeParse({ ...ready, checkpoint: null }).success).toBe(false);
    expect(freshnessReadResponseSchema.safeParse({
      ...ready,
      status: "unavailable",
    }).success).toBe(false);
    const checkpoint = structuredClone(memory.factory_input.initial_checkpoint);
    expect(companyCheckpointSchema.safeParse({ ...checkpoint, extra: 1 }).success).toBe(false);
    expect(companyCheckpointSchema.safeParse({ ...checkpoint, intent_sequence: 1.5 }).success).toBe(false);
    expect(companyCheckpointSchema.safeParse({ ...checkpoint, intent_sequence: -1 }).success).toBe(false);
    expect(companyCheckpointSchema.safeParse({ ...checkpoint, operational_epoch: 0 }).success).toBe(false);
  });

  it("keeps a bad terminal state reserved and then accepts the mapped state", () => {
    for (const negative of fixture.terminal_state_negative_cases) {
      expect(negative.expected_valid).toBe(false);
      const target = provider();
      const reserved = target.reserveProgress(reserveRequest(negative.operation, memory.factory_input.initial_checkpoint, "challenge:TEST_ONLY:bad-terminal"));
      expect(reserved.outcome).toBe("reserved");
      if (reserved.outcome !== "reserved") continue;
      const finish = {
        schema_version: 2 as const,
        scope,
        operation_id: reserved.reservation_id && operationId(negative.operation),
        reservation_id: reserved.reservation_id,
        expected_checkpoint: reserved.checkpoint,
        evidence_digest: (memory.cases.find(entry => entry.name === "finish_winner")!.request as FinishProgressRequest).evidence_digest,
        terminal_state: negative.terminal_state,
        challenge: "challenge:TEST_ONLY:bad-finish",
      };
      if (negative.terminal_state === "uncertain" || negative.terminal_state === "failed") {
        expect(contractCode(() => target.finishProgress(finish as FinishProgressRequest))).toBe("COMPANY_CONTRACT_INVALID");
      } else {
        expect(target.finishProgress(finish as FinishProgressRequest)).toEqual({
          schema_version: 2,
          scope,
          challenge: finish.challenge,
          outcome: "conflict",
          checkpoint: null,
        });
      }
      expect(target.readFreshness({
        ...fixture.read_freshness.request,
        challenge: "challenge:TEST_ONLY:still-reserved",
        observed_checkpoint: reserved.checkpoint,
      })).toEqual({
        schema_version: 2,
        scope,
        challenge: "challenge:TEST_ONLY:still-reserved",
        status: "uncertain",
        checkpoint: null,
      });
    }
    const target = provider();
    const reserved = target.reserveProgress(reserveRequest("accept", memory.factory_input.initial_checkpoint, "challenge:TEST_ONLY:repair"));
    expect(reserved.outcome).toBe("reserved");
    if (reserved.outcome !== "reserved") return;
    const evidence = (memory.cases.find(entry => entry.name === "finish_winner")!.request as FinishProgressRequest).evidence_digest;
    expect(target.finishProgress({
      schema_version: 2,
      scope,
      operation_id: operationId("accept"),
      reservation_id: reserved.reservation_id,
      expected_checkpoint: reserved.checkpoint,
      evidence_digest: evidence,
      terminal_state: "rejected",
      challenge: "challenge:TEST_ONLY:repair-bad",
    }).outcome).toBe("conflict");
    const recorded = target.finishProgress({
      schema_version: 2,
      scope,
      operation_id: operationId("accept"),
      reservation_id: reserved.reservation_id,
      expected_checkpoint: reserved.checkpoint,
      evidence_digest: evidence,
      terminal_state: companyOperationTerminalStates.accept,
      challenge: "challenge:TEST_ONLY:repair-good",
    });
    expect(recorded.outcome).toBe("recorded");
  });

  it("returns original reserve and finish evidence without applying conflicts", () => {
    const target = provider();
    const expected = structuredClone(memory.factory_input.initial_checkpoint);
    const first = target.reserveProgress(reserveRequest("accept", expected, "challenge:TEST_ONLY:idem-reserve"));
    expect(first.outcome).toBe("reserved");
    if (first.outcome !== "reserved") return;
    const replay = target.reserveProgress(reserveRequest("accept", expected, "challenge:TEST_ONLY:idem-replay"));
    expect(replay).toEqual({ ...first, challenge: "challenge:TEST_ONLY:idem-replay", outcome: "already_reserved" });
    if (replay.outcome === "already_reserved") replay.checkpoint.intent_sequence = 99;
    expect(target.reserveProgress(reserveRequest("accept", expected, "challenge:TEST_ONLY:idem-clone")).outcome).toBe("already_reserved");
    const changed = reserveRequest("accept", expected, "challenge:TEST_ONLY:idem-conflict");
    changed.event_digest = (memory.cases.find(entry => entry.name === "finish_conflict")!.request as FinishProgressRequest).evidence_digest;
    expect(target.reserveProgress(changed)).toEqual({
      schema_version: 2,
      scope,
      challenge: changed.challenge,
      outcome: "conflict",
      checkpoint: null,
      reservation_id: null,
    });
    expect(target.reserveProgress(reserveRequest("accept", expected, "challenge:TEST_ONLY:idem-still")).outcome).toBe("already_reserved");
    const evidence = (memory.cases.find(entry => entry.name === "finish_winner")!.request as FinishProgressRequest).evidence_digest;
    const finished = target.finishProgress({
      schema_version: 2,
      scope,
      operation_id: operationId("accept"),
      reservation_id: first.reservation_id,
      expected_checkpoint: first.checkpoint,
      evidence_digest: evidence,
      terminal_state: "accepted",
      challenge: "challenge:TEST_ONLY:idem-finish",
    });
    expect(finished.outcome).toBe("recorded");
    if (finished.outcome !== "recorded") return;
    expect(progressRoot(expected.intent_root, 1, {
      operation_id: operationId("accept"),
      operation: "accept",
      event_digest: (reserveRequest("accept", expected, "challenge:TEST_ONLY:root")).event_digest,
      reservation_id: first.reservation_id,
      state: "reserved",
    })).toBe(first.checkpoint.intent_root);
    expect(finished.checkpoint.intent_sequence).toBe(first.checkpoint.intent_sequence + 1);
    expect(target.finishProgress({
      schema_version: 2,
      scope,
      operation_id: operationId("accept"),
      reservation_id: first.reservation_id,
      expected_checkpoint: first.checkpoint,
      evidence_digest: evidence,
      terminal_state: "accepted",
      challenge: "challenge:TEST_ONLY:idem-recorded",
    })).toEqual({ ...finished, challenge: "challenge:TEST_ONLY:idem-recorded", outcome: "already_recorded" });
    expect(target.finishProgress({
      schema_version: 2,
      scope,
      operation_id: operationId("accept"),
      reservation_id: first.reservation_id,
      expected_checkpoint: first.checkpoint,
      evidence_digest: changed.event_digest,
      terminal_state: "accepted",
      challenge: "challenge:TEST_ONLY:idem-finish-conflict",
    }).outcome).toBe("conflict");
    expect(target.readFreshness({
      ...fixture.read_freshness.request,
      challenge: "challenge:TEST_ONLY:idem-ready",
      observed_checkpoint: finished.checkpoint,
    }).status).toBe("ready");
  });

  it("lets exactly one valid concurrent reserve and finish win", () => {
    const target = provider();
    const head = structuredClone(memory.factory_input.initial_checkpoint);
    let nestedReserve: ReserveProgressResponse | undefined;
    setTestOnlyMemoryCasProbe(() => {
      nestedReserve = target.reserveProgress(reserveRequest("reject", head, "challenge:TEST_ONLY:race-reserve-b"));
    });
    const outerReserve = target.reserveProgress(reserveRequest("accept", head, "challenge:TEST_ONLY:race-reserve-a"));
    const reserveResults = [outerReserve, nestedReserve];
    expect(reserveResults.filter(item => item?.outcome === "reserved")).toHaveLength(1);
    expect(reserveResults.filter(item => item?.outcome === "conflict")).toHaveLength(1);
    const reserveWinner = reserveResults.find(item => item?.outcome === "reserved");
    if (!reserveWinner || reserveWinner.outcome !== "reserved" || !nestedReserve) return;
    expect(target.readFreshness({
      ...fixture.read_freshness.request,
      challenge: "challenge:TEST_ONLY:race-snap",
      observed_checkpoint: reserveWinner.checkpoint,
    }).status).toBe("uncertain");
    const loserOperation: CompanyProgressOperation = outerReserve.outcome === "reserved" ? "reject" : "accept";
    const loserReserved = target.reserveProgress(reserveRequest(loserOperation, reserveWinner.checkpoint, "challenge:TEST_ONLY:race-loser"));
    expect(loserReserved.outcome).toBe("reserved");
    if (loserReserved.outcome !== "reserved") return;
    let nestedFinish: FinishProgressResponse | undefined;
    const evidence = (memory.cases.find(entry => entry.name === "finish_winner")!.request as FinishProgressRequest).evidence_digest;
    const otherEvidence = (memory.cases.find(entry => entry.name === "finish_conflict")!.request as FinishProgressRequest).evidence_digest;
    const finishOf = (reservation: ReserveProgressResponse, digest: string, challenge: string): FinishProgressRequest => {
      if (reservation.outcome !== "reserved" && reservation.outcome !== "already_reserved") {
        throw new Error("missing reservation");
      }
      return {
        schema_version: 2,
        scope,
        operation_id: reservation.reservation_id.slice("reservation:TEST_ONLY:".length).replace(/^/, "sha256:"),
        reservation_id: reservation.reservation_id,
        expected_checkpoint: loserReserved.checkpoint,
        evidence_digest: digest,
        terminal_state: reservation.reservation_id.endsWith(operationId("accept").slice("sha256:".length))
          ? "accepted"
          : "rejected",
        challenge,
      };
    };
    setTestOnlyMemoryCasProbe(() => {
      nestedFinish = target.finishProgress(finishOf(loserReserved, otherEvidence, "challenge:TEST_ONLY:race-finish-b"));
    });
    const outerFinish = target.finishProgress(finishOf(reserveWinner, evidence, "challenge:TEST_ONLY:race-finish-a"));
    const finishResults = [outerFinish, nestedFinish];
    expect(finishResults.filter(item => item?.outcome === "recorded")).toHaveLength(1);
    expect(finishResults.filter(item => item?.outcome === "conflict")).toHaveLength(1);
    const finishWinner = finishResults.find(item => item?.outcome === "recorded");
    if (!finishWinner || finishWinner.outcome !== "recorded") return;
    expect(target.readFreshness({
      ...fixture.read_freshness.request,
      challenge: "challenge:TEST_ONLY:race-unfinished",
      observed_checkpoint: finishWinner.checkpoint,
    })).toMatchObject({ status: "uncertain", checkpoint: null });
  });

  it("isolates constructor and read snapshots from caller objects", () => {
    const input = structuredClone(memory.factory_input);
    const target = createTestOnlyMemoryProvider(input);
    input.initial_checkpoint.intent_sequence = 8;
    input.initial_checkpoint.stores.jarvis.receipt_sequence = 4;
    const ready = memory.cases.find(entry => entry.name === "ready")!;
    expect(target.readFreshness(ready.request as FreshnessReadRequest)).toEqual(ready.response);
    const seen = target.readFreshness(ready.request as FreshnessReadRequest);
    if (seen.status === "ready" && seen.checkpoint) seen.checkpoint.intent_root = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(target.readFreshness(ready.request as FreshnessReadRequest)).toEqual(ready.response);
    const invented = structuredClone(memory.factory_input.initial_checkpoint);
    invented.intent_sequence += 1;
    expect(target.readFreshness({
      ...(ready.request as FreshnessReadRequest),
      challenge: "challenge:TEST_ONLY:invented",
      observed_checkpoint: invented,
    })).toMatchObject({ status: "mismatch", checkpoint: null });
    let observedDuringCas: unknown;
    setTestOnlyMemoryCasProbe(() => {
      observedDuringCas = target.readFreshness(ready.request as FreshnessReadRequest);
    });
    target.reserveProgress(reserveRequest("delete", memory.factory_input.initial_checkpoint, "challenge:TEST_ONLY:snapshot"));
    expect(observedDuringCas).toEqual(ready.response);
  });

  it("rejects scope mismatch, unknown input, and production selection of the test provider", () => {
    const source = readFileSync(new URL("../../src/company-freshness.ts", import.meta.url), "utf8");
    expect(source.includes("TEST_ONLY_memory")).toBe(false);
    expect(source.includes("createTestOnlyMemoryProvider")).toBe(false);
    const target = provider();
    const ready = memory.cases.find(entry => entry.name === "ready")!;
    const foreign = structuredClone(ready.request as FreshnessReadRequest);
    foreign.scope = { ...foreign.scope, provider_instance_id: "provider:OTHER" };
    expect(contractCode(() => target.readFreshness(foreign))).toBe("COMPANY_CONTRACT_INVALID");
    expect(contractCode(() => target.reserveProgress({
      ...(memory.cases.find(entry => entry.name === "reserve_winner")!.request as ReserveProgressRequest),
      scope: foreign.scope,
    }))).toBe("COMPANY_CONTRACT_INVALID");
    expect(target.readFreshness(ready.request as FreshnessReadRequest)).toEqual(ready.response);
    expect(contractCode(() => target.readFreshness({
      ...(ready.request as FreshnessReadRequest),
      unexpected: true,
    } as FreshnessReadRequest))).toBe("COMPANY_CONTRACT_INVALID");
    expect(contractCode(() => createTestOnlyMemoryProvider({
      scope,
      initial_checkpoint: memory.factory_input.initial_checkpoint,
      kind: "TEST_ONLY_memory",
    } as never))).toBe("COMPANY_CONTRACT_INVALID");
    expect(contractCode(() => loadCompanyFreshness({ schema_version: 2, kind: "TEST_ONLY_memory" }))).toBe("COMPANY_CONTRACT_INVALID");
    expect(contractCode(() => loadCompanyFreshness({ ...fixture.freshness_provider as object, test_only: true }))).toBe("COMPANY_CONTRACT_INVALID");
    process.env.COMPANY_FRESHNESS_KIND = "TEST_ONLY_memory";
    const loaded = loadCompanyFreshness(fixture.freshness_provider);
    expect(loaded.readFreshness(fixture.read_freshness.request).status).toBe("unavailable");
    delete process.env.COMPANY_FRESHNESS_KIND;
  });
});
