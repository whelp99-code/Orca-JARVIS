import { dailyLoopUsage } from "../../src/daily-loop-usage.js";
import { canonicalize } from "../../src/canonical.js";
import { describe, expect, it } from "vitest";
import {
  AuthorityDb,
  DailyLoopStore,
  EveningCloseoutStore,
  generateEveningCloseout,
  parseEveningCloseoutInput,
} from "../../src/index.js";
import {
  closeoutInput,
  signer,
  trustedCloseoutKey,
} from "../fixtures/evening-closeout.js";
import { initialized } from "../helpers.js";
import { generateNativeEveningEnvelope } from "../../src/evening-native-envelope.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { closeoutHash, closeoutSigningBytes } from "../../src/evening-closeout-crypto.js";

const T0 = new Date("2026-08-30T12:00:00.000Z");
const T1 = new Date("2026-08-30T12:01:00.000Z");
function prepare(loop: DailyLoopStore): string {
  return loop.prepare({
    due: {
      kind: "due",
      local_date: "2026-08-30",
      phase: "evening",
      scheduled_at: T0.toISOString(),
    },
    created_at: T0,
    deadline_at: new Date("2026-08-30T13:00:00.000Z"),
    steps: [{ key: "evening_summary", sequence: 1 }],
  });
}
function artifact(runId: string, correlationId: string, sourceOmissions: readonly string[] = [], generatedAt = T1) {
  const input = closeoutInput();
  return generateEveningCloseout(parseEveningCloseoutInput({
    ...input,
    run_id: runId,
    correlation_id: correlationId,
    generated_at: generatedAt.toISOString(),
    source_readiness: "no_data",
    source_omissions: sourceOmissions,
    records: [],
    decisions: [],
    memory_candidates: [],
    tomorrow_actions: [],
    risks: [],
  }), signer(generatedAt.toISOString()));
}
function correlation(db: AuthorityDb, runId: string): string {
  const value: unknown = db.db.prepare(
    "SELECT correlation_id FROM daily_loop_runs WHERE run_id=?",
  ).get(runId);
  if (typeof value !== "object" || value === null || !("correlation_id" in value)) {
    throw new Error("test correlation missing");
  }
  return String(value.correlation_id);
}
describe("evening closeout persistence", () => {
  it.each([false, true])("counts native v2 durable output after suppression (populated=%s)", async populated => {
    const db = await initialized();
    try {
      const loop = new DailyLoopStore(db); const runId = prepare(loop);
      const claim = loop.claim({ run_id: runId, owner_id: "native-owner", at: T1, lease_ms: 600_000 });
      let value = generateNativeEveningEnvelope(db, { run_id: runId, correlation_id: correlation(db, runId),
        local_date: "2026-08-30", observed_at: T1, repository_identities: [], max_records: 10, max_bytes: 1048576 }, signer(T1.toISOString()));
      if (populated) {
        // Opaque signed record tests durable accounting, not proof admission or live validity.
        const record = { fixture: "signed-cost-only" };
        const source = { ...JSON.parse(value.source_json), state: "ready", records: [record], evidence_bytes: Buffer.byteLength(canonicalize(record)) };
        const { artifact_id, canonical_digest, envelope, ...base } = value;
        void artifact_id; void canonical_digest; void envelope;
        const core = { ...base, native_completion_count: 1, source_json: canonicalize(source), source_digest: closeoutHash(source) };
        const digest = closeoutHash(core); const handle = signer(T1.toISOString());
        const unsigned = { ...core, artifact_id: `evening-closeout:v2:${digest.slice(7)}`, canonical_digest: digest, envelope: handle.identity };
        value = { ...unsigned, envelope: { ...handle.identity,
          signature: Buffer.from(handle.sign(closeoutSigningBytes("orca-jarvis/evening-closeout-native/v2\0", unsigned))).toString("base64url") } };
      }
      // Exercise accounting of a completed ledger; this is not native publication admission.
      loop.completeStep({ claim, step: loop.steps(runId)[0]!, detail: value, at: T1 });
      loop.complete(claim!, T1);
      const expected = { items: populated ? 1 : 0, work: 1, bytes: Buffer.byteLength(canonicalize(value)) };
      expect(dailyLoopUsage(db, "2026-08-30", trustedCloseoutKey)).toEqual(expected);
      new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: "daily_run", id: runId, component_id: runId }, T1);
      expect(dailyLoopUsage(db, "2026-08-30", trustedCloseoutKey)).toEqual(expected);
      expect(() => dailyLoopUsage(db, "2026-08-30")).toThrow("DAILY_LOOP_INTEGRITY_FAILURE");
      expect(() => dailyLoopUsage(db, "2026-08-30", { ...trustedCloseoutKey, key_id: "wrong" }))
        .toThrow("DAILY_LOOP_INTEGRITY_FAILURE");
    } finally { db.close(); }
  });

  it("includes earlier morning work and rolls back an interruption after evening step persistence", async () => {
    const db = await initialized();
    try {
      const loop = new DailyLoopStore(db);
      const morning = loop.prepare({ due: { kind: "due", local_date: "2026-08-30", phase: "morning", scheduled_at: T0.toISOString() },
        created_at: T0, deadline_at: new Date("2026-08-30T13:00:00.000Z"), steps: [{ key: "refresh_context", sequence: 1 }] });
      const morningClaim = loop.claim({ run_id: morning, owner_id: "morning", at: T1, lease_ms: 600_000 });
      loop.completeStep({ claim: morningClaim, step: loop.steps(morning)[0]!, at: T1,
        detail: { state: "no_data", reason: "refresh_missing", refresh_id: null } });
      const runId = prepare(loop);
      const claim = loop.claim({ run_id: runId, owner_id: "evening", at: T1, lease_ms: 600_000 });
      const value = artifact(runId, correlation(db, runId));
      const input = { claim, artifact: value, at: T1 };
      const budgets = { max_items: 100, max_work: 2, max_bytes: 100_000 };
      const fault = new EveningCloseoutStore(db, trustedCloseoutKey, { after_artifact_persisted: () => { throw new Error("INTERRUPTED"); } });
      expect(() => fault.settleWithinBudget(input, budgets)).toThrow("INTERRUPTED");
      expect(loop.steps(runId)[0]?.state).toBe("pending");
      const store = new EveningCloseoutStore(db, trustedCloseoutKey);
      expect(() => store.settleWithinBudget(input, { ...budgets, max_work: 1 })).toThrow("BUDGET_WORK_EXHAUSTED");
      expect(loop.steps(runId)[0]?.state).toBe("pending");
      expect(() => store.settleWithinBudget(input, { ...budgets, max_items: -1 })).toThrow("DAILY_LOOP_CONFIG_INVALID");
      expect(loop.steps(runId)[0]?.state).toBe("pending");
      expect(store.settleWithinBudget(input, budgets)).toBe(true);
      expect(dailyLoopUsage(db, "2026-08-30", trustedCloseoutKey).work).toBe(2);
    } finally { db.close(); }
  });

  it.each(["items", "work", "bytes"])("rolls back the whole evening publication when %s exceeds budget", async dimension => {
    const db = await initialized();
    try {
      const loop = new DailyLoopStore(db); const runId = prepare(loop);
      const claim = loop.claim({ run_id: runId, owner_id: "owner", at: T1, lease_ms: 600_000 });
      const value = generateEveningCloseout(parseEveningCloseoutInput({
        ...closeoutInput(), run_id: runId, correlation_id: correlation(db, runId), generated_at: T1.toISOString(),
      }), signer(T1.toISOString()));
      const budget = { max_items: 5, max_work: 1, max_bytes: Buffer.byteLength(canonicalize(value)) };
      const store = new EveningCloseoutStore(db, trustedCloseoutKey);
      const snapshot = () => ({ run: db.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(runId),
        steps: db.db.prepare("SELECT * FROM daily_loop_steps WHERE run_id=?").all(runId) });
      const before = snapshot();
      const key = `max_${dimension}` as keyof typeof budget;
      expect(() => store.settleWithinBudget({ claim, artifact: value, at: T1 }, { ...budget, [key]: budget[key] - 1 }))
        .toThrow(`BUDGET_${dimension.toUpperCase()}_EXHAUSTED`);
      expect(snapshot()).toEqual(before);
      expect(store.settleWithinBudget({ claim, artifact: value, at: T1 }, budget)).toBe(true);
      expect(store.settleWithinBudget({ claim, artifact: value, at: T1 }, budget)).toBe(false);
    } finally { db.close(); }
  });

  it.each(["run_id", "correlation_id", "local_date"])("rejects a signed artifact with foreign %s in the completed ledger", async field => {
    const db = await initialized();
    try {
      const loop = new DailyLoopStore(db); const runId = prepare(loop);
      const claim = loop.claim({ run_id: runId, owner_id: "owner", at: T1, lease_ms: 600_000 });
      const value = generateEveningCloseout(parseEveningCloseoutInput({
        ...closeoutInput(), run_id: runId, correlation_id: correlation(db, runId), generated_at: T1.toISOString(),
        [field]: field === "local_date" ? "2026-08-29" : "foreign-identity",
      }), signer(T1.toISOString()));
      // Generic step persistence does not verify the domain-specific artifact identity.
      loop.completeStep({ claim, step: loop.steps(runId)[0]!, detail: value, at: T1 });
      const before = db.db.prepare("SELECT total_changes() AS changes").get();
      expect(() => dailyLoopUsage(db, "2026-08-30", trustedCloseoutKey)).toThrow("DAILY_LOOP_INTEGRITY_FAILURE");
      expect(db.db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    } finally { db.close(); }
  });

  it.each([false, true])("counts signed evening output with external trust (populated=%s)", async populated => {
    const db = await initialized();
    try {
      const loop = new DailyLoopStore(db); const runId = prepare(loop);
      const claim = loop.claim({ run_id: runId, owner_id: "owner", at: T1, lease_ms: 600_000 });
      const value = populated ? generateEveningCloseout(parseEveningCloseoutInput({
        ...closeoutInput(), run_id: runId, correlation_id: correlation(db, runId), generated_at: T1.toISOString(),
      }), signer(T1.toISOString())) : artifact(runId, correlation(db, runId));
      new EveningCloseoutStore(db, trustedCloseoutKey).settle({ claim, artifact: value, at: T1 });
      expect(() => dailyLoopUsage(db, "2026-08-30")).toThrow("DAILY_LOOP_INTEGRITY_FAILURE");
      expect(dailyLoopUsage(db, "2026-08-30", trustedCloseoutKey)).toEqual({
        items: populated ? 5 : 0, work: 1, bytes: Buffer.byteLength(canonicalize(value)),
      });
      expect(() => dailyLoopUsage(db, "2026-08-30", { ...trustedCloseoutKey, key_id: "untrusted" }))
        .toThrow("DAILY_LOOP_INTEGRITY_FAILURE");
    } finally { db.close(); }
  });

  it("rejects a validly signed future artifact without changing the run or step", async () => {
    const db = await initialized();
    try {
      const loop = new DailyLoopStore(db);
      const runId = prepare(loop);
      const claim = loop.claim({ run_id: runId, owner_id: "owner", at: T1, lease_ms: 600_000 });
      const store = new EveningCloseoutStore(db, trustedCloseoutKey);
      const value = artifact(runId, correlation(db, runId), [], new Date(T1.getTime() + 1));
      const before = db.db.prepare("SELECT total_changes() AS changes").get();
      expect(() => store.settle({ claim, artifact: value, at: T1 })).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
      expect(db.db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
      expect(loop.steps(runId)[0]?.state).toBe("pending");
      expect(store.settle({ claim, artifact: value, at: new Date(T1.getTime() + 1) })).toBe(true);
      const completed = db.db.prepare("SELECT total_changes() AS changes").get();
      expect(() => store.settle({ claim, artifact: value, at: T1 })).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
      expect(db.db.prepare("SELECT total_changes() AS changes").get()).toEqual(completed);
    } finally { db.close(); }
  });

  it("Given a current fence When settled twice Then exact lifecycle is idempotent", async () => {
    const db = await initialized();
    const loop = new DailyLoopStore(db);
    const runId = prepare(loop);
    const claim = loop.claim({
      run_id: runId,
      owner_id: "closeout-owner",
      at: T1,
      lease_ms: 600_000,
    });
    const store = new EveningCloseoutStore(db, trustedCloseoutKey);
    const value = artifact(runId, correlation(db, runId));
    expect(store.settle({ claim, artifact: value, at: T1 })).toBe(true);
    expect(store.settle({ claim, artifact: value, at: T1 })).toBe(false);
    expect(store.read(runId)).toEqual(value);
    expect(db.db.prepare("SELECT state FROM daily_loop_runs WHERE run_id=?").get(runId))
      .toEqual({ state: "completed" });
    db.close();
  });

  it("Given a post-persist crash When reopened Then resumes and changed bytes write zero", async () => {
    const db = await initialized();
    const filename = db.filename;
    const loop = new DailyLoopStore(db);
    const runId = prepare(loop);
    const claim = loop.claim({
      run_id: runId,
      owner_id: "closeout-owner",
      at: T1,
      lease_ms: 600_000,
    });
    const value = artifact(runId, correlation(db, runId));
    const crashing = new EveningCloseoutStore(db, trustedCloseoutKey, {
      after_artifact_persisted: () => { throw new Error("injected crash"); },
    });
    expect(() => crashing.settle({ claim, artifact: value, at: T1 })).toThrow("injected crash");
    db.close();
    const reopened = new AuthorityDb(filename);
    const recovered = new EveningCloseoutStore(reopened, trustedCloseoutKey);
    expect(recovered.settle({ claim, artifact: value, at: T1 })).toBe(true);
    const before = reopened.db.prepare("SELECT total_changes() AS changes").get();
    const mutation = {
      ...value,
      envelope: {
        ...value.envelope,
        signature: `${value.envelope.signature.startsWith("A") ? "B" : "A"}${value.envelope.signature.slice(1)}`,
      },
    };
    expect(() => recovered.settle({ claim, artifact: mutation, at: T1 }))
      .toThrow("EVENING_CLOSEOUT_INTEGRITY_FAILURE");
    expect(reopened.db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    expect(reopened.db.prepare("SELECT count(*) AS n FROM daily_loop_steps WHERE run_id=?").get(runId))
      .toEqual({ n: 1 });
    const changes = reopened.db.prepare("SELECT total_changes() AS changes").get();
    expect(() => recovered.settle({
      claim,
      artifact: artifact(runId, correlation(reopened, runId), ["alternate-source"]),
      at: T1,
    })).toThrow("EVENING_CLOSEOUT_IDENTITY_CONFLICT");
    expect(reopened.db.prepare("SELECT total_changes() AS changes").get()).toEqual(changes);
    reopened.close();
  });

  it("Given two connections and a stale fence When settling Then writes zero", async () => {
    const first = await initialized();
    const filename = first.filename;
    const firstLoop = new DailyLoopStore(first);
    const runId = prepare(firstLoop);
    const staleClaim = firstLoop.claim({
      run_id: runId,
      owner_id: "first-owner",
      at: T1,
      lease_ms: 60_000,
    });
    const second = new AuthorityDb(filename);
    const secondLoop = new DailyLoopStore(second);
    secondLoop.claim({
      run_id: runId,
      owner_id: "second-owner",
      at: new Date("2026-08-30T12:02:01.000Z"),
      lease_ms: 60_000,
    });
    const before = first.db.prepare("SELECT total_changes() AS changes").get();
    const store = new EveningCloseoutStore(first, trustedCloseoutKey);
    expect(() => store.settle({
      claim: staleClaim,
      artifact: artifact(runId, correlation(first, runId)),
      at: T1,
    })).toThrow("DAILY_LOOP_STALE_LEASE");
    expect(first.db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    second.close();
    first.close();
  });

  it("Given a non-summary evening step When settling Then generic completion is rejected", async () => {
    const db = await initialized();
    const loop = new DailyLoopStore(db);
    const runId = loop.prepare({
      due: {
        kind: "due", local_date: "2026-08-30", phase: "evening", scheduled_at: T0.toISOString(),
      },
      created_at: T0,
      deadline_at: new Date("2026-08-30T13:00:00.000Z"),
      steps: [{ key: "generic_step", sequence: 1 }],
    });
    const claim = loop.claim({ run_id: runId, owner_id: "owner", at: T1, lease_ms: 60_000 });
    const before = db.db.prepare("SELECT total_changes() AS changes").get();
    const store = new EveningCloseoutStore(db, trustedCloseoutKey);
    expect(() => store.settle({
      claim,
      artifact: artifact(runId, correlation(db, runId)),
      at: T1,
    })).toThrow("EVENING_CLOSEOUT_IDENTITY_CONFLICT");
    expect(db.db.prepare("SELECT total_changes() AS changes").get()).toEqual(before);
    db.close();
  });
});
