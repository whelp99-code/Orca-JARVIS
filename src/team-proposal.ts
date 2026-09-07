import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { CapabilityFact, CapabilityMatrixV1, CapabilityStage } from "./capabilities.js";
import { invalid, parseRequest, parseMatrix, QUESTION_IDS, STAGES } from "./team-proposal-input.js";

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

export interface TeamTaskRequirements {
  readonly work_type: TeamWorkType;
  readonly constraints: readonly string[];
  readonly completion_evidence: readonly string[];
}

export type TeamProposalResultV1 =
  | { schema_version: 1; status: "needs_input"; questions: ReadonlyArray<{ id: string; text: string; required: true }> }
  | { schema_version: 1; status: "blocked"; reasons: ReadonlyArray<{ capability_id: CapabilityFact["id"]; stage: CapabilityStage }> }
  | {
    schema_version: 1; status: "ready"; proposal_digest: string; objective: string;
    requirements: TeamTaskRequirements; members: ReadonlyArray<TeamMemberProposal>;
  };

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
  leader: {
    member_id: "member_leader",
    archetype: "leader",
    role: "Lead and integrate",
    scope: ["coordinate_delivery"],
    exclusions: ["grant_authority", "persist_proposal"],
    verification: ["confirm_objective_coverage"],
  },
  researcher: {
    member_id: "member_researcher",
    archetype: "researcher",
    role: "Gather sources",
    scope: ["gather_sources"],
    exclusions: ["implement_changes", "grant_authority"],
    verification: ["cite_completion_evidence"],
  },
  analyst: {
    member_id: "member_analyst",
    archetype: "analyst",
    role: "Analyze evidence",
    scope: ["analyze_evidence"],
    exclusions: ["implement_changes", "grant_authority"],
    verification: ["check_finding_consistency"],
  },
  builder: {
    member_id: "member_builder",
    archetype: "builder",
    role: "Implement changes",
    scope: ["implement_changes"],
    exclusions: ["grant_authority", "persist_proposal"],
    verification: ["run_required_checks"],
  },
  writer: {
    member_id: "member_writer",
    archetype: "writer",
    role: "Draft deliverable",
    scope: ["draft_deliverable"],
    exclusions: ["implement_changes", "grant_authority"],
    verification: ["match_completion_evidence"],
  },
  designer: {
    member_id: "member_designer",
    archetype: "designer",
    role: "Define product surface",
    scope: ["define_product_surface"],
    exclusions: ["implement_changes", "grant_authority"],
    verification: ["check_constraint_fit"],
  },
  critic: {
    member_id: "member_critic",
    archetype: "critic",
    role: "Review quality",
    scope: ["review_quality"],
    exclusions: ["implement_changes", "grant_authority"],
    verification: ["challenge_gaps"],
  },
};

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
  const payload = {
    schema_version: 1 as const, status: "ready" as const, objective: request.objective, members,
    requirements: {
      work_type: workType, constraints: request.constraints, completion_evidence: request.completion_evidence,
    },
  };
  return { ...payload, proposal_digest: `sha256:${createHash("sha256").update(canonicalize(payload)).digest("hex")}` };
}
