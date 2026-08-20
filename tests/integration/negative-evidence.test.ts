import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor, ControlPlane, DEFAULT_AGENTOPS_LOOP, TaskTimeline, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/index.js";
import { appendSettledNegativeEvidence, negativeEvidenceId, type NegativeEvidenceInputV1 } from "../../src/negative-evidence.js";
import { buildCurrentState, writeCurrentState } from "../../src/state-projection.js";
import { future, initialized, localKey, snapshot } from "../helpers.js";

const digest = (fill: string): `sha256:${string}` => `sha256:${fill.repeat(64)}`;
const evidenceInput = (overrides: Partial<NegativeEvidenceInputV1> = {}): NegativeEvidenceInputV1 => ({
  schema_version: 1,
  task_id: "codex-work",
  attempt_id: "attempt:neg",
  reason_code: "failed_approach",
  scope: ["src/approved-executor.ts"],
  summary: "bounded failed approach",
  evidence_digest: digest("a"),
  ...overrides,
});
const clocked = (now: Date, minutes = 10): Pick<ControlCommandRequestInput, "requested_at" | "expires_at"> => ({ requested_at: now.toISOString(), expires_at: new Date(now.getTime() + minutes * 60_000).toISOString() });
const request = (id: string, args: NegativeEvidenceInputV1, level: 0 | 1 | 2 | 3 | 4 | 5 = 2, extras: Partial<ControlCommandRequestInput> = {}): ControlCommandRequestInput => ({
  schema_version: 1,
  request_id: id,
  action: "evidence.negative.record",
  action_level: level,
  target: { environment: "local", task_id: args.task_id },
  args: { ...args },
  reversible: true,
  requested_by: "operator",
  requested_at: extras.requested_at ?? new Date().toISOString(),
  expires_at: extras.expires_at ?? future(10),
  nonce: extras.nonce ?? `nonce-${id}`,
});
const approve = (db: Awaited<ReturnType<typeof initialized>>, control: ControlPlane, input: ControlCommandRequestInput, now = new Date()): string => {
  if (input.action === "evidence.negative.record") seedKnownTask(db);
  const staged = control.stage(input, now);
  const at = now.toISOString();
  const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `approval-${input.request_id}`, request_id: input.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub", key_id: "decision-test", algorithm: "Ed25519", issued_at: at, not_before: at, expires_at: input.expires_at, nonce: `approval-nonce-${input.request_id}`, max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(receipt, localKey(db)), now);
  return input.request_id;
};
const reject = (db: Awaited<ReturnType<typeof initialized>>, control: ControlPlane, input: ControlCommandRequestInput, now = new Date()): string => {
  const staged = control.stage(input, now);
  const at = now.toISOString();
  const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `rejection-${input.request_id}`, request_id: input.request_id, decision: "reject", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub", key_id: "decision-test", algorithm: "Ed25519", issued_at: at, not_before: at, expires_at: input.expires_at, nonce: `reject-nonce-${input.request_id}`, max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(receipt, localKey(db)), now);
  return input.request_id;
};
const countRows = (db: Awaited<ReturnType<typeof initialized>>): number => Number((db.db.prepare("SELECT COUNT(*) AS n FROM negative_evidence").get() as { n: number }).n);
const seedKnownTask = (db: Awaited<ReturnType<typeof initialized>>): void => {
  if (!db.db.prepare("SELECT 1 FROM work_items WHERE id='codex-work'").get()) db.ingest(snapshot());
};
const workflowCommand = (id: string, action: string, level: 0 | 1 | 2 | 3 | 4 | 5, args: Record<string, unknown>): ControlCommandRequestInput => ({ schema_version: 1, request_id: id, action, action_level: level, target: { environment: "local" }, args, reversible: true, requested_by: "operator", requested_at: new Date().toISOString(), expires_at: future(10), nonce: `nonce-${id}` });
const blockedFromMarkdown = (markdown: string): unknown[] => {
  const match = markdown.match(/## BLOCKED\n\n```json\n([\s\S]*?)\n```/);
  expect(match?.[1]).toEqual(expect.any(String));
  return JSON.parse(String(match?.[1])) as unknown[];
};
const dispose = (db: Awaited<ReturnType<typeof initialized>>, root?: string): void => {
  db.close();
  if (root) rmSync(root, { recursive: true, force: true });
  rmSync(dirname(db.filename), { recursive: true, force: true });
};

describe("approved negative evidence", () => {
  it("records one immutable row through a claimed level-2 receipt and projects it", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-neg-valid-"));
    const db = await initialized();
    const control = new ControlPlane(db);
    const executor = new ApprovedCommandExecutor(db, join(root, "backups"), join(root, "state"));
    try {
      const input = evidenceInput();
      const id = approve(db, control, request("neg-valid", input));
      const result = await executor.execute(id);
      expect(result).toMatchObject({ request_id: id, action: "evidence.negative.record", state: "completed" });
      const payload = result.result as { evidence_id: string; payload_digest: string };
      expect(payload.evidence_id).toBe(negativeEvidenceId(input));
      expect(payload.payload_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(countRows(db)).toBe(1);
      const row = db.db.prepare("SELECT * FROM negative_evidence WHERE evidence_id=?").get(payload.evidence_id) as { request_id: string; receipt_id: string; reason_code: string; evidence_digest: string; task_id: string };
      expect(row).toMatchObject({ request_id: id, receipt_id: `approval-${id}`, reason_code: input.reason_code, evidence_digest: input.evidence_digest, task_id: input.task_id });
      expect((db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(id) as { state: string }).state).toBe("completed");
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_effects WHERE request_id=?").get(id) as { n: number }).n).toBe(1);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_effect_attempts WHERE request_id=?").get(id) as { n: number }).n).toBe(0);
      expect(existsSync(join(root, "state"))).toBe(false);
      expect(readdirSync(root)).toEqual([]);

      const events = new TaskTimeline(db).timeline(input.task_id);
      const recorded = events.find(event => event.event_id === payload.evidence_id);
      expect(recorded).toMatchObject({ task_id: input.task_id, kind: "evidence", title: "evidence.negative.recorded", status: input.reason_code });
      expect(recorded?.evidence_refs).toEqual(expect.arrayContaining([payload.evidence_id, input.evidence_digest]));
      expect(recorded?.payload).toMatchObject({ reason_code: input.reason_code, evidence_digest: input.evidence_digest });
      expect(recorded?.payload).not.toHaveProperty("summary");
      expect(JSON.stringify(recorded)).not.toMatch(/Bearer\s+\S+|token\s*[:=]|password\s*[:=]|secret\s*[:=]/i);

      expect(() => db.db.prepare("UPDATE negative_evidence SET summary=? WHERE evidence_id=?").run("mutated", payload.evidence_id)).toThrow(/immutable negative evidence/);
      expect(() => db.db.prepare("DELETE FROM negative_evidence WHERE evidence_id=?").run(payload.evidence_id)).toThrow(/immutable negative evidence/);
      expect(countRows(db)).toBe(1);
    } finally { dispose(db, root); }
  });

  it("rejects expired authority and stale settlement without leaving a claimed request persisted", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    try {
      seedKnownTask(db);
      const now = new Date("2026-08-18T16:00:00.000Z");
      const expiredNow = new Date(now.getTime() + 60_001);
      const staleInput = request("neg-stale-settlement", evidenceInput({ attempt_id: "attempt:stale-settlement" }), 2, clocked(now));
      approve(db, control, staleInput, now);
      const times = [now, expiredNow, expiredNow];
      const executor = new ApprovedCommandExecutor(db, undefined, undefined, {}, () => times.shift() ?? expiredNow);
      await expect(executor.execute(staleInput.request_id)).rejects.toThrow("CONTROL_STALE_FENCE");
      expect(countRows(db)).toBe(0);
      expect((db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(staleInput.request_id) as { state: string }).state).not.toBe("completed");
    } finally { dispose(db); }
  });

  it("cannot persist claimed evidence without settlement through the remaining test helper", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    try {
      const now = new Date("2026-08-18T16:30:00.000Z");
      const args = evidenceInput({ attempt_id: "attempt:must-settle" });
      const id = approve(db, control, request("neg-must-settle", args, 2, clocked(now)), now);
      const claimed = control.claim(id, "approved-command-executor", now);
      expect(() => appendSettledNegativeEvidence(db, { settle: () => { throw new Error("SETTLE_REFUSED"); } }, claimed, now)).toThrow("SETTLE_REFUSED");
      expect(countRows(db)).toBe(0);
      expect((db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(id) as { state: string }).state).toBe("claimed");
    } finally { dispose(db); }
  });

  it("rejects unknown task bindings and common credential forms in every exposed field", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const executor = new ApprovedCommandExecutor(db);
    try {
      const unknown = evidenceInput({ task_id: "task:unknown", attempt_id: "attempt:unknown" });
      const unknownResult = await executor.execute(approve(db, control, request("neg-unknown-task", unknown)));
      expect(unknownResult).toMatchObject({ state: "failed", failure_code: "NEGATIVE_EVIDENCE_INPUT_INVALID" });

      const secrets: Array<{ field: "summary" | "task_id" | "attempt_id" | "scope"; value: string }> = [
        { field: "summary", value: "OPENAI_API_KEY=sk-proj-abcdefghijklmnop" },
        { field: "summary", value: "api_key: sk-ant-api03-abcdefghijklmnop" },
        { field: "task_id", value: "AKIAIOSFODNN7EXAMPLE" },
        { field: "attempt_id", value: "Authorization: Basic dXNlcjpwYXNz" },
        { field: "scope", value: "Cookie: session=abcdefghijklmnop" },
        { field: "scope", value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
        { field: "summary", value: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
        { field: "summary", value: "glpat-0123456789abcdefghij" },
        { field: "scope", value: "npm_0123456789abcdefghij" },
        { field: "attempt_id", value: "gldt-0123456789abcdefghij" },
        { field: "task_id", value: "pypi-0123456789abcdefghij" },
      ];
      for (const [index, item] of secrets.entries()) {
        const overrides: Partial<NegativeEvidenceInputV1> = { attempt_id: `attempt:credential-${index}` };
        if (item.field === "scope") overrides.scope = [item.value];
        else overrides[item.field] = item.value;
        const args = evidenceInput(overrides);
        const result = await executor.execute(approve(db, control, request(`neg-credential-${index}`, args)));
        expect(result).toMatchObject({ state: "failed", failure_code: "NEGATIVE_EVIDENCE_INPUT_INVALID" });
      }
      expect(countRows(db)).toBe(0);
    } finally { dispose(db); }
  });

  it("returns the safe envelope and inserts zero rows for invalid payloads", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const executor = new ApprovedCommandExecutor(db);
    try {
      const cases: Array<{ id: string; args: NegativeEvidenceInputV1 }> = [
        { id: "neg-bad-digest", args: evidenceInput({ evidence_digest: "sha256:not-a-digest" as NegativeEvidenceInputV1["evidence_digest"] }) },
        { id: "neg-bad-reason", args: evidenceInput({ attempt_id: "attempt:bad-reason", reason_code: "not_a_reason" as NegativeEvidenceInputV1["reason_code"] }) },
        { id: "neg-secret", args: evidenceInput({ attempt_id: "attempt:secret", summary: "token: leaked-value" }) },
      ];
      for (const item of cases) {
        const result = await executor.execute(approve(db, control, request(item.id, item.args)));
        expect(result).toMatchObject({ state: "failed", failure_code: "NEGATIVE_EVIDENCE_INPUT_INVALID" });
      }
      expect(countRows(db)).toBe(0);
    } finally { dispose(db); }
  });

  it("rejects missing, rejected, expired, and consumed receipts without inserting", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const consumedAt = new Date("2026-08-18T14:00:00.000Z");
    const executor = new ApprovedCommandExecutor(db, undefined, undefined, {}, () => consumedAt);
    try {
      const missing = request("neg-missing", evidenceInput({ attempt_id: "attempt:missing" }));
      control.stage(missing);
      await expect(executor.execute(missing.request_id)).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");

      const rejected = reject(db, control, request("neg-rejected", evidenceInput({ attempt_id: "attempt:rejected" })));
      await expect(executor.execute(rejected)).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");

      const now = new Date("2026-08-18T13:00:00.000Z");
      const expiredInput = request("neg-expired", evidenceInput({ attempt_id: "attempt:expired" }), 2, clocked(now, 1));
      approve(db, control, expiredInput, now);
      await expect(executor.execute(expiredInput.request_id, "approved-command-executor", new Date(now.getTime() + 60_001))).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");

      const consumed = approve(db, control, request("neg-consumed", evidenceInput({ attempt_id: "attempt:consumed" }), 2, clocked(consumedAt)), consumedAt);
      await expect(executor.execute(consumed, "approved-command-executor", consumedAt)).resolves.toMatchObject({ state: "completed" });
      await expect(executor.execute(consumed, "approved-command-executor", consumedAt)).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");
      expect(countRows(db)).toBe(1);
    } finally { dispose(db); }
  });

  it("rejects the wrong action level after claiming and inserts zero rows", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const executor = new ApprovedCommandExecutor(db);
    try {
      const low = await executor.execute(approve(db, control, request("neg-level-1", evidenceInput({ attempt_id: "attempt:level-1" }), 1)));
      const high = await executor.execute(approve(db, control, request("neg-level-3", evidenceInput({ attempt_id: "attempt:level-3" }), 3)));
      expect(low).toMatchObject({ state: "failed", failure_code: "APPROVED_ACTION_LEVEL_TOO_LOW" });
      expect(high).toMatchObject({ state: "failed", failure_code: "APPROVED_ACTION_LEVEL_TOO_LOW" });
      expect(countRows(db)).toBe(0);
    } finally { dispose(db); }
  });

  it("returns an idempotent completed result or rejects replay without a second row", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const executor = new ApprovedCommandExecutor(db);
    try {
      const firstArgs = evidenceInput({ attempt_id: "attempt:replay" });
      const first = await executor.execute(approve(db, control, request("neg-replay-1", firstArgs)));
      expect(first).toMatchObject({ state: "completed" });
      await expect(executor.execute("neg-replay-1")).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");

      const conflict = await executor.execute(approve(db, control, request("neg-replay-2", { ...firstArgs, summary: "different summary same identity" })));
      expect(conflict).toMatchObject({ state: "failed", failure_code: "NEGATIVE_EVIDENCE_REPLAY_CONFLICT" });
      expect(countRows(db)).toBe(1);
      expect((first.result as { evidence_id: string }).evidence_id).toBe(negativeEvidenceId(firstArgs));
    } finally { dispose(db); }
  });

  it("does not change workflow or task terminal state when recording", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const executor = new ApprovedCommandExecutor(db);
    try {
      await executor.execute(approve(db, control, workflowCommand("neg-register", "workflow.register", 3, { spec: DEFAULT_AGENTOPS_LOOP })));
      await executor.execute(approve(db, control, workflowCommand("neg-start", "workflow.start", 2, { run_id: "run:neg", loop_id: DEFAULT_AGENTOPS_LOOP.loop_id, correlation_id: "task:neg", input: { task_id: "task:neg" }, budget: { max_steps: 8, max_attempts_per_node: 2, deadline: future(30) } })));
      const before = db.db.prepare("SELECT state,current_node,attempts,failure_code FROM workflow_runs WHERE run_id=?").get("run:neg");
      const result = await executor.execute(approve(db, control, request("neg-workflow", evidenceInput())));
      expect(result).toMatchObject({ state: "completed" });
      expect(db.db.prepare("SELECT state,current_node,attempts,failure_code FROM workflow_runs WHERE run_id=?").get("run:neg")).toEqual(before);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n).toBe(1);
    } finally { dispose(db); }
  });

  it("projects at most three newest records into generated JSON and Markdown only", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-neg-proj-"));
    const db = await initialized();
    const control = new ControlPlane(db);
    let executionTime = new Date("2026-08-18T15:00:00.000Z");
    const executor = new ApprovedCommandExecutor(db, join(root, "backups"), join(root, "state"), {}, () => executionTime);
    try {
      const origin = new Date("2026-08-18T15:00:00.000Z");
      const ids: string[] = [];
      for (let index = 0; index < 4; index++) {
        const args = evidenceInput({ attempt_id: `attempt:proj-${index}`, evidence_digest: digest(String(index)) });
        const at = new Date(origin.getTime() + index * 1000);
        const id = approve(db, control, request(`neg-proj-${index}`, args, 2, clocked(at)), at);
        executionTime = at;
        await expect(executor.execute(id, "approved-command-executor", at)).resolves.toMatchObject({ state: "completed" });
        ids.push(negativeEvidenceId(args));
      }
      expect(countRows(db)).toBe(4);
      expect(existsSync(join(root, "state"))).toBe(false);

      const generatedAt = new Date(origin.getTime() + 10_000);
      const output = await writeCurrentState(db, join(root, "state"), generatedAt);
      const json = JSON.parse(readFileSync(output.json, "utf8")) as { blocked: Array<{ evidence_id?: string; reason_code?: string; evidence_digest?: string; summary?: string }> };
      const markdownBlocked = blockedFromMarkdown(readFileSync(output.markdown, "utf8"));
      const probed: string[] = [];
      const passiveProbe = { inspect: async (id: "codex" | "claude" | "orca_read" | "gjc" | "live_resume") => { probed.push(id); return { installed: { ok: false, version: null, evidence: "missing_executable" }, configured: { ok: false, evidence: "configuration_unverified" }, protocol_compatible: { ok: false, protocol_version: null, evidence: "protocol_unverified" }, operational: { ok: false, evidence: "runtime_unverified" }, authorized: { ok: false, evidence: "authority_unverified" } }; } };
      const built = await buildCurrentState(db, generatedAt, { capabilityProbe: passiveProbe });
      expect(probed).toEqual(["codex", "claude", "orca_read", "gjc", "live_resume"]);
      const projected = json.blocked.filter(item => item.evidence_id !== undefined);
      expect(projected).toHaveLength(3);
      expect(projected.map(item => item.evidence_id)).toEqual([ids[3], ids[2], ids[1]]);
      expect(projected.every(item => item.reason_code === "failed_approach" && item.summary === undefined)).toBe(true);
      expect(markdownBlocked).toEqual(json.blocked);
      expect(built.blocked).toEqual(json.blocked);
      expect(() => db.db.prepare("INSERT INTO collaboration_rooms(room_id,room_type,name,description,visibility,created_by_identity_id,created_request_id,created_at) VALUES('room:neg','general','n','n','private','agent:neg','request:neg','2026-08-18T00:00:00.000Z')").run()).toThrow("COLLABORATION_DEPRECATED_USE_TASK_TIMELINE");
    } finally { dispose(db, root); }
  });
});
