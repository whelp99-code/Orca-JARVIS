import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb, MemoryCandidateError } from "../../src/index.js";
import { parseMemoryCandidateInput } from "../../src/memory-candidate-input.js";
import { memoryCandidateIdentity } from "../../src/memory-candidate-material.js";
import {
  approvedDecisionMemoryInput,
  evidenceRef,
  explicitMemoryInput,
  memoryHash,
  MEMORY_NOW,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  memoryCandidateStore,
  memoryDatabase,
  memoryRecord,
  memorySource,
  memoryTableCount,
  memoryTableCounts,
  seedMemoryAuthority,
} from "../fixtures/memory-candidate-store.js";

type InputFactory = typeof verifiedMemoryInput;
type SignedClass = {
  readonly name: string;
  readonly factory: InputFactory;
  readonly control: boolean;
};
type Mutation = {
  readonly name: string;
  readonly prepare?: (value: Record<string, unknown>) => void;
  readonly mutate: (value: Record<string, unknown>) => void;
  readonly controlOnly?: boolean;
};
type BindingCase = {
  readonly sourceClass: SignedClass;
  readonly mutation: Mutation;
};

const SIGNED_CLASSES: readonly SignedClass[] = [
  { name: "explicit", factory: explicitMemoryInput, control: true },
  { name: "verified", factory: verifiedMemoryInput, control: false },
  { name: "decision", factory: approvedDecisionMemoryInput, control: true },
];
const EFFECT_TABLES = [
  "memory_outbox", "memory_outbox_attempts", "memory_reconciliation_events", "memory_deletion_requests",
  "memory_tombstones", "notification_deliveries", "control_effect_attempts", "outbox", "consumer_inbox",
] as const;

function secondBrain(value: Record<string, unknown>): Record<string, unknown> {
  return memoryRecord(value["second_brain"]);
}

function conflict(value: Record<string, unknown>): Record<string, unknown> {
  return memoryRecord(value["conflict"]);
}

function conflictReference(value: Record<string, unknown>): Record<string, unknown> {
  const references = conflict(value)["references"];
  if (!Array.isArray(references) || references.length !== 1) throw new TypeError("one conflict reference required");
  return memoryRecord(references[0]);
}

function prepareNoData(value: Record<string, unknown>): void {
  value["second_brain"] = {
    state: "no_data",
    checked_at: MEMORY_NOW,
    fresh_until: "2026-08-28T12:01:00.000Z",
  };
}

function prepareConflict(value: Record<string, unknown>): void {
  value["conflict"] = {
    state: "conflict",
    references: [evidenceRef("second_brain_conflict", "policy-binding")],
  };
}

function mutatePrimaryAuthorityPointer(value: Record<string, unknown>): void {
  const source = memorySource(value);
  if (source["class"] === "verified_outcome") source["evidence_id"] = "verification-policy-mutated";
  else source["request_id"] = "request-policy-mutated";
}

const MUTATIONS: readonly Mutation[] = [
  { name: "host", mutate: value => { value["host"] = "linux-control-plane"; } },
  { name: "payload-field", mutate: value => { value["payload_fields"] = ["summary", "raw_body"]; } },
  {
    name: "payload-order",
    prepare: value => { value["payload_fields"] = ["summary", "title"]; },
    mutate: value => { value["payload_fields"] = ["title", "summary"]; },
  },
  { name: "second-state", mutate: prepareNoData },
  {
    name: "second-checked",
    prepare: prepareNoData,
    mutate: value => { secondBrain(value)["checked_at"] = "2026-08-28T11:59:59.000Z"; },
  },
  {
    name: "second-fresh",
    prepare: prepareNoData,
    mutate: value => { secondBrain(value)["fresh_until"] = "2026-08-28T12:02:00.000Z"; },
  },
  { name: "conflict-state", mutate: prepareConflict },
  {
    name: "conflict-kind",
    prepare: prepareConflict,
    mutate: value => { conflict(value)["references"] = [evidenceRef("existing_memory", "policy-binding-kind")]; },
  },
  {
    name: "conflict-id",
    prepare: prepareConflict,
    mutate: value => {
      memoryRecord(conflictReference(value)["identifier"])["id"] = memoryHash("fixture/reference-id/v1\0", "changed").slice(7);
    },
  },
  {
    name: "conflict-evidence",
    prepare: prepareConflict,
    mutate: value => { conflictReference(value)["evidence_digest"] = memoryHash("fixture/evidence/v1\0", "changed"); },
  },
  {
    name: "conflict-observed",
    prepare: prepareConflict,
    mutate: value => { conflictReference(value)["observed_at"] = "2026-08-28T10:59:59.000Z"; },
  },
  {
    name: "conflict-fresh",
    prepare: prepareConflict,
    mutate: value => { conflictReference(value)["fresh_until"] = "2026-08-28T13:01:00.000Z"; },
  },
  {
    name: "conflict-expires",
    prepare: prepareConflict,
    mutate: value => { conflictReference(value)["expires_at"] = "2026-08-30T12:00:00.000Z"; },
  },
  { name: "operation", mutate: value => { value["operation"] = "correct"; } },
  { name: "subject", mutate: value => { value["subject"] = "Mutated policy-bound subject"; } },
  { name: "content", mutate: value => { value["statement"] = "Mutated policy-bound statement."; } },
  { name: "purpose", mutate: value => { value["purpose"] = "live_awareness"; } },
  { name: "sensitivity", mutate: value => { value["sensitivity"] = "sensitive"; } },
  { name: "principal", mutate: value => { value["principal_id"] = "principal:foreign"; } },
  { name: "source-id", mutate: value => { memorySource(value)["source_id"] = "source-policy-mutated"; } },
  { name: "source-version", mutate: value => { memorySource(value)["source_version"] = "v2"; } },
  { name: "source-pointer", mutate: mutatePrimaryAuthorityPointer },
  {
    name: "receipt-pointer",
    controlOnly: true,
    mutate: value => { memorySource(value)["receipt_id"] = "receipt-policy-mutated"; },
  },
];

const BINDING_CASES: readonly BindingCase[] = SIGNED_CLASSES.flatMap(sourceClass => MUTATIONS
  .filter(mutation => !mutation.controlOnly || sourceClass.control)
  .map(mutation => ({ sourceClass, mutation })));

function identity(value: Record<string, unknown>) {
  return memoryCandidateIdentity(parseMemoryCandidateInput(value));
}

function checkpointBytes(root: string, authority: AuthorityDb): Readonly<Record<string, string>> {
  authority.db.pragma("wal_checkpoint(TRUNCATE)");
  return Object.fromEntries(readdirSync(root)
    .filter(name => name === "authority.sqlite" || name === "authority.sqlite-wal")
    .sort()
    .map(name => [name, readFileSync(join(root, name)).toString("base64")]));
}

function authorityFailure(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({
    name: "MemoryCandidateError",
    code: "MEMORY_CANDIDATE_AUTHORITY_INVALID",
    message: "MEMORY_CANDIDATE_AUTHORITY_INVALID",
  }));
}

function expectClaim(authority: AuthorityDb, candidateId: string, classificationDigest: string): void {
  expect(authority.db.prepare(
    `SELECT candidate_id,classification_digest FROM memory_candidate_authority_claims
     WHERE candidate_id=?`,
  ).get(candidateId)).toEqual({ candidate_id: candidateId, classification_digest: classificationDigest });
}

function expectNoEffects(authority: AuthorityDb): void {
  for (const table of EFFECT_TABLES) expect(memoryTableCount(authority, table), table).toBe(0);
}

describe("Task 27 full policy-input authority binding", () => {
  it.each(BINDING_CASES)("rejects $sourceClass.name $mutation.name before and after intended use", async ({
    sourceClass,
    mutation,
  }) => {
    for (const order of ["attacker-first", "intended-first"] as const) {
      const database = await memoryDatabase();
      try {
        const id = `${sourceClass.name}-${mutation.name}-${order}`;
        const intended = sourceClass.factory({
          authority_id: `binding-${id}`,
          idempotency_key: `candidate:binding:${id}:intended`,
        });
        mutation.prepare?.(intended);
        const attacker = structuredClone(intended);
        attacker["idempotency_key"] = `candidate:binding:${id}:attacker`;
        mutation.mutate(attacker);
        seedMemoryAuthority(database.authority, intended);
        expect(identity(attacker).candidate_id, id).not.toBe(identity(intended).candidate_id);
        const store = memoryCandidateStore(database.authority);
        if (order === "attacker-first") {
          const before = memoryTableCounts(database.authority);
          const bytes = checkpointBytes(database.root, database.authority);
          authorityFailure(() => store.classify(attacker));
          expect(memoryTableCounts(database.authority), `${id}:counts`).toEqual(before);
          expect(checkpointBytes(database.root, database.authority), `${id}:bytes`).toEqual(bytes);
          expect(memoryTableCount(database.authority, "memory_candidate_authority_claims")).toBe(0);
          const result = store.classify(intended);
          expectClaim(database.authority, result.candidate_id, result.classification_digest);
        } else {
          const result = store.classify(intended);
          expectClaim(database.authority, result.candidate_id, result.classification_digest);
          const before = memoryTableCounts(database.authority);
          const bytes = checkpointBytes(database.root, database.authority);
          authorityFailure(() => store.classify(attacker));
          expect(memoryTableCounts(database.authority), `${id}:counts`).toEqual(before);
          expect(checkpointBytes(database.root, database.authority), `${id}:bytes`).toEqual(bytes);
        }
        expectNoEffects(database.authority);
      } finally {
        database.authority.close();
        rmSync(database.root, { recursive: true, force: true });
        rmSync(database.anchorsRoot, { recursive: true, force: true });
      }
    }
  });

  it.each(SIGNED_CLASSES)("keeps only $name idempotency aliases outside policy identity", async sourceClass => {
    const database = await memoryDatabase();
    try {
      const intended = sourceClass.factory({
        authority_id: `alias-${sourceClass.name}`,
        idempotency_key: `candidate:binding:alias:${sourceClass.name}:first`,
        payload_fields: ["summary", "title"],
        second_brain: {
          state: "no_data",
          checked_at: MEMORY_NOW,
          fresh_until: "2026-08-28T12:01:00.000Z",
        },
      });
      const alias = structuredClone(intended);
      alias["idempotency_key"] = `candidate:binding:alias:${sourceClass.name}:second`;
      expect(identity(alias)).toEqual(identity(intended));
      seedMemoryAuthority(database.authority, intended);
      const store = memoryCandidateStore(database.authority);
      const first = store.classify(intended);
      const before = memoryTableCounts(database.authority);
      expect(store.classify(alias)).toEqual(first);
      const after = memoryTableCounts(database.authority);
      for (const [table, count] of Object.entries(after)) {
        expect(count - (before[table] ?? 0), table).toBe(table === "memory_candidate_idempotency" ? 1 : 0);
      }
      expectClaim(database.authority, first.candidate_id, first.classification_digest);
      expectNoEffects(database.authority);
    } finally {
      database.authority.close();
      rmSync(database.root, { recursive: true, force: true });
      rmSync(database.anchorsRoot, { recursive: true, force: true });
    }
  });

  it.each(SIGNED_CLASSES)("preserves $name terminal authority binding across restart", async sourceClass => {
    const database = await memoryDatabase();
    const intended = sourceClass.factory({
      authority_id: `restart-${sourceClass.name}`,
      idempotency_key: `candidate:binding:restart:${sourceClass.name}`,
      conflict: {
        state: "conflict",
        references: [evidenceRef("second_brain_conflict", `restart-${sourceClass.name}`, {
          fresh_until: MEMORY_NOW,
          expires_at: MEMORY_NOW,
        })],
      },
    });
    let reopened: AuthorityDb | null = null;
    try {
      seedMemoryAuthority(database.authority, intended);
      const first = memoryCandidateStore(database.authority).classify(intended);
      expect(first).toMatchObject({ state: "expired", classification_reason: "SOURCE_EXPIRED" });
      expectClaim(database.authority, first.candidate_id, first.classification_digest);
      database.authority.close();
      const active = new AuthorityDb(database.path);
      reopened = active;
      const attacker = structuredClone(intended);
      attacker["idempotency_key"] = `candidate:binding:restart:${sourceClass.name}:attacker`;
      attacker["host"] = "linux-control-plane";
      const before = memoryTableCounts(active);
      authorityFailure(() => memoryCandidateStore(active).classify(attacker));
      expect(memoryTableCounts(active)).toEqual(before);
      const alias = structuredClone(intended);
      alias["idempotency_key"] = `candidate:binding:restart:${sourceClass.name}:alias`;
      expect(memoryCandidateStore(active).classify(alias)).toEqual(first);
      expectClaim(active, first.candidate_id, first.classification_digest);
      expectNoEffects(active);
    } finally {
      reopened?.close();
      rmSync(database.root, { recursive: true, force: true });
      rmSync(database.anchorsRoot, { recursive: true, force: true });
    }
  });

  it("uses one generic typed error for every mutation case", () => {
    expect(BINDING_CASES.length).toBe(68);
    expect(new MemoryCandidateError("MEMORY_CANDIDATE_AUTHORITY_INVALID")).toMatchObject({
      name: "MemoryCandidateError",
      code: "MEMORY_CANDIDATE_AUTHORITY_INVALID",
      message: "MEMORY_CANDIDATE_AUTHORITY_INVALID",
    });
  });
});
