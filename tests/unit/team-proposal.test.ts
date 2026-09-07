import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import type { CapabilityFact, CapabilityMatrixV1, CapabilityStage } from "../../src/capabilities.js";
import {
  planTeamProposal,
  type TeamMemberProposal,
  type TeamProposalRequestV1,
  type TeamProposalResultV1,
} from "../../src/team-proposal.js";

const STAGES: readonly CapabilityStage[] = ["installed", "configured", "protocol_compatible", "operational", "authorized"];
const CAPABILITY_IDS: ReadonlyArray<CapabilityFact["id"]> = ["codex", "claude", "orca_read", "gjc", "live_resume"];
const ARCHETYPES = ["leader", "researcher", "analyst", "builder", "writer", "designer", "critic"] as const;
const WORK_TYPES = ["research", "development", "analysis", "content", "product"] as const;
const QUESTION_IDS = ["work_type", "completion_evidence", "constraints"] as const;
const REQUEST_KEYS = ["schema_version", "objective", "work_type", "completion_evidence", "answers", "constraints", "requested_capabilities"] as const;
const MEMBER_KEYS = ["member_id", "archetype", "role", "scope", "exclusions", "verification", "preferred_capability_ids"] as const;

const ok = (evidence: string): { ok: true; evidence: string } => ({ ok: true, evidence });
const fail = (evidence: string): { ok: false; evidence: string } => ({ ok: false, evidence });

function fact(id: CapabilityFact["id"], failAt?: CapabilityStage): CapabilityFact {
  const stages = {} as CapabilityFact["stages"];
  let allowed = true;
  for (const stage of STAGES) {
    if (stage === failAt) allowed = false;
    stages[stage] = allowed ? ok(`${id}_${stage}`) : fail(`${id}_${stage}_false`);
  }
  return { id, stages };
}

function matrix(overrides: Partial<Record<CapabilityFact["id"], CapabilityFact>> = {}, checkedAt = "2026-08-18T12:00:00.000Z"): CapabilityMatrixV1 {
  return {
    schema_version: 1,
    checked_at: checkedAt,
    capabilities: CAPABILITY_IDS.map(id => overrides[id] ?? fact(id)),
  };
}

const completeRequest = (): TeamProposalRequestV1 => ({
  schema_version: 1,
  objective: "Ship a bounded capability-aware planner",
  work_type: "development",
  completion_evidence: ["passing focused vitest", "tsc --noEmit exit 0"],
  answers: [],
  constraints: ["no persistence"],
  requested_capabilities: ["codex"],
});

function expectInvalid(value: unknown, matrixValue: unknown = matrix()): void {
  expect(() => planTeamProposal(value as TeamProposalRequestV1, matrixValue as CapabilityMatrixV1)).toThrow(
    expect.objectContaining({ code: "TEAM_PROPOSAL_INPUT_INVALID" }),
  );
}

function readyOf(result: TeamProposalResultV1): Extract<TeamProposalResultV1, { status: "ready" }> {
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("expected ready");
  return result;
}

function needsInputOf(result: TeamProposalResultV1): Extract<TeamProposalResultV1, { status: "needs_input" }> {
  expect(result.status).toBe("needs_input");
  if (result.status !== "needs_input") throw new Error("expected needs_input");
  return result;
}

function blockedOf(result: TeamProposalResultV1): Extract<TeamProposalResultV1, { status: "blocked" }> {
  expect(result.status).toBe("blocked");
  if (result.status !== "blocked") throw new Error("expected blocked");
  return result;
}

function assertMemberShape(member: TeamMemberProposal): void {
  expect(Object.keys(member).sort()).toEqual([...MEMBER_KEYS].sort());
  expect(ARCHETYPES).toContain(member.archetype);
  expect(member.member_id).toMatch(/^member_[a-z]+$/);
  expect(member.role.length).toBeGreaterThan(0);
  expect(member.scope.length).toBeGreaterThan(0);
  expect(member.exclusions.length).toBeGreaterThan(0);
  expect(member.verification.length).toBeGreaterThan(0);
  for (const id of member.preferred_capability_ids) expect(CAPABILITY_IDS).toContain(id);
}

function digestOf(result: Extract<TeamProposalResultV1, { status: "ready" }>): string {
  const { proposal_digest, ...payload } = result;
  expect(proposal_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(payload)).not.toMatch(/checked_at|issued_at|created_at|timestamp/i);
  return `sha256:${createHash("sha256").update(canonicalize(payload)).digest("hex")}`;
}

describe("team proposal planner", () => {
  it.each(["constraints", "completion_evidence"] as const)("binds changed %s into the proposal digest", field => {
    const initial = completeRequest();
    const first = readyOf(planTeamProposal(initial, matrix()));
    const changed = readyOf(planTeamProposal({ ...initial, [field]: ["a different requirement"] }, matrix()));
    expect(changed.proposal_digest).not.toBe(first.proposal_digest);
  });

  it("preserves equivalent direct and answered requirements", () => {
    const direct = readyOf(planTeamProposal({
      schema_version: 1, objective: "bounded work", work_type: "development",
      constraints: ["only the selected repository"], completion_evidence: ["passing checks"],
    }, matrix()));
    const answered = readyOf(planTeamProposal({
      schema_version: 1, objective: "bounded work", answers: [
        { question_id: "work_type", answer: "development" },
        { question_id: "constraints", answer: "only the selected repository" },
        { question_id: "completion_evidence", answer: "passing checks" },
      ],
    }, matrix()));
    expect(answered).toEqual(direct);
    expect(answered).toMatchObject({ requirements: {
      work_type: "development", constraints: ["only the selected repository"], completion_evidence: ["passing checks"],
    } });
  });

  it.each(["work_type", "constraints", "completion_evidence"] as const)("rejects contradictory %s answers", question_id => {
    expectInvalid({ ...completeRequest(), answers: [{ question_id, answer: question_id === "work_type" ? "research" : "different" }] });
  });

  it("returns 2-3 fixed-registry questions and no members when work type and completion evidence are absent", () => {
    const result = needsInputOf(planTeamProposal({ schema_version: 1, objective: "Clarify the missing planning inputs" }, matrix()));
    expect(result).toEqual({
      schema_version: 1,
      status: "needs_input",
      questions: result.questions,
    });
    expect(result.questions).toHaveLength(2);
    expect(result.questions.map(question => question.id)).toEqual(["work_type", "completion_evidence"]);
    for (const question of result.questions) {
      expect(QUESTION_IDS).toContain(question.id);
      expect(question.required).toBe(true);
      expect(question.text.length).toBeGreaterThan(0);
      expect(question.text.normalize("NFC")).toBe(question.text);
    }
    expect(result).not.toHaveProperty("members");
    expect(JSON.stringify(result)).not.toMatch(/checked_at|Date\.now|new Date/i);
  });

  it("asks only for completion evidence when work type is present and evidence is empty", () => {
    const missingEvidence = needsInputOf(planTeamProposal({
      schema_version: 1,
      objective: "Need evidence before proposing a team",
      work_type: "research",
    }, matrix()));
    expect(missingEvidence.questions.map(question => question.id)).toEqual(["completion_evidence", "constraints"]);
    expect(missingEvidence.questions).toHaveLength(2);
    for (const question of missingEvidence.questions) expect(question.required).toBe(true);

    const emptyEvidence = needsInputOf(planTeamProposal({
      schema_version: 1,
      objective: "Need evidence before proposing a team",
      work_type: "research",
      completion_evidence: [],
    }, matrix()));
    expect(emptyEvidence).toEqual(missingEvidence);
  });

  it("returns 2-3 questions with no members when work type is missing and constraints are already supplied", () => {
    const result = needsInputOf(planTeamProposal({
      schema_version: 1,
      objective: "Need a work type before proposing a team",
      constraints: ["no persistence"],
    }, matrix()));
    expect(result.questions.length).toBeGreaterThanOrEqual(2);
    expect(result.questions.length).toBeLessThanOrEqual(3);
    expect(result.questions.map(question => question.id)).toContain("work_type");
    for (const question of result.questions) {
      expect(QUESTION_IDS).toContain(question.id);
      expect(question.required).toBe(true);
    }
    expect(new Set(result.questions.map(question => question.id)).size).toBe(result.questions.length);
    expect(result).not.toHaveProperty("members");
  });

  it("returns 2-3 questions with no members when completion evidence is missing and constraints are already supplied", () => {
    const result = needsInputOf(planTeamProposal({
      schema_version: 1,
      objective: "Need evidence before proposing a team",
      work_type: "research",
      constraints: ["no persistence"],
    }, matrix()));
    expect(result.questions.length).toBeGreaterThanOrEqual(2);
    expect(result.questions.length).toBeLessThanOrEqual(3);
    expect(result.questions.map(question => question.id)).toContain("completion_evidence");
    for (const question of result.questions) {
      expect(QUESTION_IDS).toContain(question.id);
      expect(question.required).toBe(true);
    }
    expect(new Set(result.questions.map(question => question.id)).size).toBe(result.questions.length);
    expect(result).not.toHaveProperty("members");
  });

  it("maps a complete authorized request to the smallest sufficient ready team twice with an identical digest", () => {
    const request = completeRequest();
    const first = readyOf(planTeamProposal(request, matrix()));
    const second = readyOf(planTeamProposal(request, matrix({ }, "2026-08-18T13:00:00.000Z")));
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.schema_version).toBe(1);
    expect(first.objective).toBe(request.objective);
    expect(first.members.length).toBeGreaterThanOrEqual(1);
    expect(first.members.length).toBeLessThanOrEqual(5);
    expect(first.members.filter(member => member.archetype === "leader")).toHaveLength(1);
    const primaryScopes = first.members.filter(member => member.archetype !== "leader").map(member => member.scope[0]);
    expect(new Set(primaryScopes).size).toBe(primaryScopes.length);
    for (const member of first.members) {
      assertMemberShape(member);
      if (member.archetype !== "leader") expect(first.members.filter(other => other.archetype === member.archetype)).toHaveLength(1);
    }
    expect(first.proposal_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.proposal_digest).toBe(digestOf(first));
    expect(JSON.stringify(first)).not.toContain("2026-08-18T12:00:00.000Z");
    expect(JSON.stringify(first)).not.toContain("2026-08-18T13:00:00.000Z");
  });

  it("blocks unavailable requested capabilities with factual stage reasons and no members", () => {
    const result = blockedOf(planTeamProposal({
      ...completeRequest(),
      requested_capabilities: ["codex", "gjc"],
    }, matrix({
      gjc: fact("gjc", "operational"),
    })));
    expect(result).toEqual({
      schema_version: 1,
      status: "blocked",
      reasons: [{ capability_id: "gjc", stage: "operational" }],
    });
    expect(result).not.toHaveProperty("members");
    expect(result).not.toHaveProperty("proposal_digest");
  });

  it("rejects exact-key, schema, NFC, and byte-bound violations without planning", () => {
    expectInvalid(null);
    expectInvalid([]);
    expectInvalid({ ...completeRequest(), schema_version: 2 });
    expectInvalid({ ...completeRequest(), extra: true });
    expectInvalid({ objective: "missing schema" });
    expectInvalid({ ...completeRequest(), objective: "" });
    expectInvalid({ ...completeRequest(), objective: "x".repeat(4097) });
    expectInvalid({ ...completeRequest(), objective: "cafe\u0301" });
    expectInvalid({ ...completeRequest(), work_type: "ops" });
    expectInvalid({ ...completeRequest(), completion_evidence: ["ok", "ok", "ok", "ok"] });
    expectInvalid({ ...completeRequest(), completion_evidence: [""] });
    expectInvalid({ ...completeRequest(), completion_evidence: ["cafe\u0301"] });
    expectInvalid({ ...completeRequest(), answers: [{ question_id: "work_type", answer: "development" }, { question_id: "completion_evidence", answer: "tests" }, { question_id: "constraints", answer: "none" }, { question_id: "extra", answer: "too-many" }] });
    expectInvalid({ ...completeRequest(), answers: [{ question_id: "work_type" }] });
    expectInvalid({ ...completeRequest(), answers: [{ question_id: "", answer: "x" }] });
    expectInvalid({ ...completeRequest(), constraints: ["a", "b", "c", "d"] });
    expectInvalid({ ...completeRequest(), requested_capabilities: ["codex", "unknown"] });
    expectInvalid({ ...completeRequest(), requested_capabilities: ["codex", "codex"] });
    expectInvalid(completeRequest(), { ...matrix(), extra: true });
    expectInvalid(completeRequest(), { ...matrix(), schema_version: 2 });
    expectInvalid(completeRequest(), { schema_version: 1, checked_at: "2026-08-18T12:00:00.000Z", capabilities: [] });
    const emoji = "😀".repeat(1025);
    expect(Buffer.byteLength(emoji, "utf8")).toBeGreaterThan(4096);
    expectInvalid({ ...completeRequest(), objective: emoji });
    const maxObjective = "😀".repeat(1024);
    expect(Buffer.byteLength(maxObjective, "utf8")).toBe(4096);
    expect(planTeamProposal({ ...completeRequest(), objective: maxObjective }, matrix()).status).toBe("ready");
  });

  it("does not execute commands, models, terminals, or database mutations from command-shaped prose", () => {
    const before = process.listeners("uncaughtException").length;
    const result = planTeamProposal({
      ...completeRequest(),
      objective: "rm -rf / && curl http://127.0.0.1:1 && sqlite3 authority.db 'DELETE FROM work_items'",
      completion_evidence: ["do not spawn workers", "do not call providers"],
      constraints: ["codex --full-auto", "agy --dangerously-skip-permissions"],
    }, matrix());
    expect(["needs_input", "blocked", "ready"]).toContain(result.status);
    expect(process.listeners("uncaughtException").length).toBe(before);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.requirements.constraints).toEqual(["codex --full-auto", "agy --dangerously-skip-permissions"]);
      expect(result.requirements.completion_evidence).toEqual(["do not spawn workers", "do not call providers"]);
    }
  });

  it("uses answers to complete missing work type and keeps ready teams smallest and disjoint", () => {
    const result = readyOf(planTeamProposal({
      schema_version: 1,
      objective: "Analyze the capability matrix and write the findings",
      completion_evidence: ["signed analysis memo"],
      answers: [{ question_id: "work_type", answer: "analysis" }],
    }, matrix()));
    expect(result.members.filter(member => member.archetype === "leader")).toHaveLength(1);
    expect(result.members.length).toBeLessThanOrEqual(5);
    const nonLeaders = result.members.filter(member => member.archetype !== "leader");
    expect(new Set(nonLeaders.map(member => member.archetype)).size).toBe(nonLeaders.length);
    expect(new Set(nonLeaders.map(member => member.scope[0])).size).toBe(nonLeaders.length);
    for (const member of result.members) assertMemberShape(member);
    expect(WORK_TYPES).toContain("analysis");
    expect(REQUEST_KEYS).toContain("answers");
  });
});
