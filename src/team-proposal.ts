import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { CapabilityFact, CapabilityMatrixV1, CapabilityStage } from "./capabilities.js";
import { JarvisError } from "./db.js";

export type TeamArchetype =
  | "leader"
  | "researcher"
  | "analyst"
  | "builder"
  | "writer"
  | "designer"
  | "critic";

export type TeamWorkType = "research" | "development" | "analysis" | "content" | "product";

export interface TeamProposalRequestV1 {
  schema_version: 1;
  objective: string;
  work_type?: TeamWorkType;
  completion_evidence?: ReadonlyArray<string>;
  answers?: ReadonlyArray<{ question_id: string; answer: string }>;
  constraints?: ReadonlyArray<string>;
  requested_capabilities?: ReadonlyArray<CapabilityFact["id"]>;
}

export interface TeamMemberProposal {
  member_id: string;
  archetype: TeamArchetype;
  role: string;
  scope: ReadonlyArray<string>;
  exclusions: ReadonlyArray<string>;
  verification: ReadonlyArray<string>;
  preferred_capability_ids: ReadonlyArray<CapabilityFact["id"]>;
}

export type TeamProposalResultV1 =
  | { schema_version: 1; status: "needs_input"; questions: ReadonlyArray<{ id: string; text: string; required: true }> }
  | { schema_version: 1; status: "blocked"; reasons: ReadonlyArray<{ capability_id: CapabilityFact["id"]; stage: CapabilityStage }> }
  | { schema_version: 1; status: "ready"; proposal_digest: string; objective: string; members: ReadonlyArray<TeamMemberProposal> };

const CAPABILITY_IDS: ReadonlyArray<CapabilityFact["id"]> = ["codex", "claude", "orca_read", "gjc", "live_resume"];
const STAGES: readonly CapabilityStage[] = ["installed", "configured", "protocol_compatible", "operational", "authorized"];
const WORK_TYPES: readonly TeamWorkType[] = ["research", "development", "analysis", "content", "product"];
const REQUEST_KEYS = ["schema_version", "objective", "work_type", "completion_evidence", "answers", "constraints", "requested_capabilities"] as const;
const MATRIX_KEYS = ["schema_version", "checked_at", "capabilities"] as const;
const FACT_KEYS = ["id", "stages"] as const;
const STAGE_KEYS = ["ok", "evidence"] as const;
const ANSWER_KEYS = ["question_id", "answer"] as const;
const QUESTION_IDS = ["work_type", "completion_evidence", "constraints"] as const;
const OBJECTIVE_LIMIT = 4096;
const FIELD_LIMIT = 512;
const LIST_LIMIT = 3;

const QUESTIONS: Record<(typeof QUESTION_IDS)[number], { id: (typeof QUESTION_IDS)[number]; text: string; required: true }> = {
  work_type: { id: "work_type", text: "What work type applies: research, development, analysis, content, or product?", required: true },
  completion_evidence: { id: "completion_evidence", text: "What completion evidence will prove the objective is done?", required: true },
  constraints: { id: "constraints", text: "What constraints bound the proposed team?", required: true },
};

const SPECIALISTS: Record<TeamWorkType, readonly Exclude<TeamArchetype, "leader">[]> = {
  research: ["researcher"],
  development: ["builder"],
  analysis: ["analyst"],
  content: ["writer"],
  product: ["designer"],
};

const MEMBER: Record<TeamArchetype, Omit<TeamMemberProposal, "preferred_capability_ids">> = {
  leader: { member_id: "member_leader", archetype: "leader", role: "Lead and integrate", scope: ["coordinate_delivery"], exclusions: ["grant_authority", "persist_proposal"], verification: ["confirm_objective_coverage"] },
  researcher: { member_id: "member_researcher", archetype: "researcher", role: "Gather sources", scope: ["gather_sources"], exclusions: ["implement_changes", "grant_authority"], verification: ["cite_completion_evidence"] },
  analyst: { member_id: "member_analyst", archetype: "analyst", role: "Analyze evidence", scope: ["analyze_evidence"], exclusions: ["implement_changes", "grant_authority"], verification: ["check_finding_consistency"] },
  builder: { member_id: "member_builder", archetype: "builder", role: "Implement changes", scope: ["implement_changes"], exclusions: ["grant_authority", "persist_proposal"], verification: ["run_required_checks"] },
  writer: { member_id: "member_writer", archetype: "writer", role: "Draft deliverable", scope: ["draft_deliverable"], exclusions: ["implement_changes", "grant_authority"], verification: ["match_completion_evidence"] },
  designer: { member_id: "member_designer", archetype: "designer", role: "Define product surface", scope: ["define_product_surface"], exclusions: ["implement_changes", "grant_authority"], verification: ["check_constraint_fit"] },
  critic: { member_id: "member_critic", archetype: "critic", role: "Review quality", scope: ["review_quality"], exclusions: ["implement_changes", "grant_authority"], verification: ["challenge_gaps"] },
};

type ParsedRequest = {
  objective: string;
  work_type: TeamWorkType | undefined;
  completion_evidence: readonly string[];
  has_constraints: boolean;
  requested_capabilities: ReadonlyArray<CapabilityFact["id"]>;
};

const invalid = (): never => { throw new JarvisError("TEAM_PROPOSAL_INPUT_INVALID"); };
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
};
const allowedKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid();
};
const nfcString = (value: unknown, max: number): string => {
  if (typeof value !== "string") return invalid();
  if (value !== value.normalize("NFC") || value.trim().length === 0) return invalid();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > max) return invalid();
  return value;
};
const unknownList = (value: unknown, maxItems: number): unknown[] => {
  if (!Array.isArray(value) || value.length > maxItems) return invalid();
  return value;
};
const stringList = (value: unknown, maxItems: number, maxBytes: number): string[] => unknownList(value, maxItems).map(item => nfcString(item, maxBytes));
const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

function parseAnswers(value: unknown): ReadonlyArray<{ question_id: (typeof QUESTION_IDS)[number]; answer: string }> {
  const seen = new Set<string>();
  return unknownList(value, LIST_LIMIT).map(item => {
    const input = object(item);
    exactKeys(input, ANSWER_KEYS);
    const question_id = nfcString(input.question_id, 64);
    if (!(QUESTION_IDS as readonly string[]).includes(question_id) || seen.has(question_id)) invalid();
    seen.add(question_id);
    return { question_id: question_id as (typeof QUESTION_IDS)[number], answer: nfcString(input.answer, FIELD_LIMIT) };
  });
}

function parseWorkType(value: unknown): TeamWorkType {
  if (typeof value !== "string" || !(WORK_TYPES as readonly string[]).includes(value)) invalid();
  return value as TeamWorkType;
}

function parseCapabilities(value: unknown): CapabilityFact["id"][] {
  const seen = new Set<string>();
  return unknownList(value, CAPABILITY_IDS.length).map(item => {
    if (typeof item !== "string" || !(CAPABILITY_IDS as readonly string[]).includes(item) || seen.has(item)) return invalid();
    seen.add(item);
    return item as CapabilityFact["id"];
  });
}

function parseRequest(value: unknown): ParsedRequest {
  const input = object(value);
  allowedKeys(input, REQUEST_KEYS);
  if (!Object.hasOwn(input, "schema_version") || !Object.hasOwn(input, "objective") || input.schema_version !== 1) invalid();
  const answers = Object.hasOwn(input, "answers") ? parseAnswers(input.answers) : [];
  const answeredWorkType = answers.find(item => item.question_id === "work_type");
  const workTypeField = Object.hasOwn(input, "work_type") ? parseWorkType(input.work_type) : undefined;
  if (answeredWorkType !== undefined && !(WORK_TYPES as readonly string[]).includes(answeredWorkType.answer)) invalid();
  const answeredEvidence = answers.find(item => item.question_id === "completion_evidence");
  const evidenceField = Object.hasOwn(input, "completion_evidence") ? stringList(input.completion_evidence, LIST_LIMIT, FIELD_LIMIT) : undefined;
  if (Object.hasOwn(input, "constraints")) stringList(input.constraints, LIST_LIMIT, FIELD_LIMIT);
  return {
    objective: nfcString(input.objective, OBJECTIVE_LIMIT),
    work_type: workTypeField ?? (answeredWorkType !== undefined ? parseWorkType(answeredWorkType.answer) : undefined),
    completion_evidence: evidenceField ?? (answeredEvidence !== undefined ? [answeredEvidence.answer] : []),
    has_constraints: Object.hasOwn(input, "constraints") || answers.some(item => item.question_id === "constraints"),
    requested_capabilities: Object.hasOwn(input, "requested_capabilities") ? parseCapabilities(input.requested_capabilities) : [],
  };
}

function parseFact(value: unknown): CapabilityFact {
  const input = object(value);
  exactKeys(input, FACT_KEYS);
  if (typeof input.id !== "string" || !(CAPABILITY_IDS as readonly string[]).includes(input.id)) invalid();
  const stagesInput = object(input.stages);
  exactKeys(stagesInput, STAGES);
  const stages = {} as Record<CapabilityStage, { ok: boolean; evidence: string }>;
  for (const stage of STAGES) {
    const item = object(stagesInput[stage]);
    exactKeys(item, STAGE_KEYS);
    if (typeof item.ok !== "boolean" || typeof item.evidence !== "string") return invalid();
    stages[stage] = { ok: item.ok, evidence: item.evidence };
  }
  return { id: input.id as CapabilityFact["id"], stages };
}

function parseMatrix(value: unknown): Map<CapabilityFact["id"], CapabilityFact> {
  const input = object(value);
  exactKeys(input, MATRIX_KEYS);
  if (input.schema_version !== 1 || typeof input.checked_at !== "string") return invalid();
  const facts = new Map<CapabilityFact["id"], CapabilityFact>();
  for (const item of unknownList(input.capabilities, CAPABILITY_IDS.length)) {
    const parsed = parseFact(item);
    if (facts.has(parsed.id)) invalid();
    facts.set(parsed.id, parsed);
  }
  if (facts.size !== CAPABILITY_IDS.length) invalid();
  return facts;
}

function firstFalseStage(fact: CapabilityFact): CapabilityStage | null {
  for (const stage of STAGES) {
    const result = fact.stages[stage];
    if (result === undefined || !result.ok) return stage;
  }
  return null;
}

function membersFor(workType: TeamWorkType, requested: ReadonlyArray<CapabilityFact["id"]>): TeamMemberProposal[] {
  const archetypes: readonly TeamArchetype[] = ["leader", ...SPECIALISTS[workType]];
  return archetypes.map(archetype => ({ ...MEMBER[archetype], preferred_capability_ids: requested }));
}

export function planTeamProposal(input: TeamProposalRequestV1, matrix: CapabilityMatrixV1): TeamProposalResultV1 {
  const request = parseRequest(input);
  const facts = parseMatrix(matrix);
  const missing: Array<(typeof QUESTION_IDS)[number]> = [];
  if (request.work_type === undefined) missing.push("work_type");
  if (request.completion_evidence.length === 0) missing.push("completion_evidence");
  if (missing.length > 0) {
    const known = new Set<(typeof QUESTION_IDS)[number]>(missing);
    if (request.work_type !== undefined) known.add("work_type");
    if (request.completion_evidence.length > 0) known.add("completion_evidence");
    if (request.has_constraints) known.add("constraints");
    const ids = [...missing];
    for (const id of QUESTION_IDS) {
      if (ids.length >= 2) break;
      if (!known.has(id)) ids.push(id);
    }
    for (const id of QUESTION_IDS) {
      if (ids.length >= 2) break;
      if (!ids.includes(id)) ids.push(id);
    }
    return { schema_version: 1, status: "needs_input", questions: ids.map(id => QUESTIONS[id]) };
  }
  const reasons: Array<{ capability_id: CapabilityFact["id"]; stage: CapabilityStage }> = [];
  for (const id of request.requested_capabilities) {
    const fact = facts.get(id);
    if (fact === undefined) return invalid();
    const stage = firstFalseStage(fact);
    if (stage !== null) reasons.push({ capability_id: id, stage });
  }
  if (reasons.length > 0) return { schema_version: 1, status: "blocked", reasons };
  const workType = request.work_type;
  if (workType === undefined) return invalid();
  const members = membersFor(workType, request.requested_capabilities);
  const payload = { schema_version: 1 as const, status: "ready" as const, objective: request.objective, members };
  return { ...payload, proposal_digest: digest(payload) };
}
