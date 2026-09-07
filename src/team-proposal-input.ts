import type { CapabilityFact, CapabilityStage } from "./capabilities.js";
import type { TeamWorkType } from "./team-proposal.js";
import { JarvisError } from "./db.js";
import { canonicalize } from "./canonical.js";

const CAPABILITY_IDS: ReadonlyArray<CapabilityFact["id"]> = ["codex", "claude", "orca_read", "gjc", "live_resume"];
export const STAGES: readonly CapabilityStage[] = ["installed", "configured", "protocol_compatible", "operational", "authorized"];
const WORK_TYPES: readonly TeamWorkType[] = ["research", "development", "analysis", "content", "product"];
const REQUEST_KEYS = ["schema_version", "objective", "work_type", "completion_evidence", "answers", "constraints", "requested_capabilities"] as const;
const MATRIX_KEYS = ["schema_version", "checked_at", "capabilities"] as const;
const FACT_KEYS = ["id", "stages"] as const;
const STAGE_KEYS = ["ok", "evidence"] as const;
const ANSWER_KEYS = ["question_id", "answer"] as const;
export const QUESTION_IDS = ["work_type", "completion_evidence", "constraints"] as const;
const OBJECTIVE_LIMIT = 4096;
const FIELD_LIMIT = 512;
const LIST_LIMIT = 3;

type ParsedRequest = {
  objective: string;
  work_type: TeamWorkType | undefined;
  completion_evidence: readonly string[];
  constraints: readonly string[];
  has_constraints: boolean;
  requested_capabilities: ReadonlyArray<CapabilityFact["id"]>;
};

export const invalid = (): never => { throw new JarvisError("TEAM_PROPOSAL_INPUT_INVALID"); };
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
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

export function parseRequest(value: unknown): ParsedRequest {
  const input = object(value);
  allowedKeys(input, REQUEST_KEYS);
  if (!Object.hasOwn(input, "schema_version") || !Object.hasOwn(input, "objective") || input.schema_version !== 1) invalid();
  const answers = Object.hasOwn(input, "answers") ? parseAnswers(input.answers) : [];
  const answeredWorkType = answers.find(item => item.question_id === "work_type");
  const workTypeField = Object.hasOwn(input, "work_type") ? parseWorkType(input.work_type) : undefined;
  if (answeredWorkType !== undefined && !(WORK_TYPES as readonly string[]).includes(answeredWorkType.answer)) invalid();
  const answeredEvidence = answers.find(item => item.question_id === "completion_evidence");
  const evidenceField = Object.hasOwn(input, "completion_evidence") ? stringList(input.completion_evidence, LIST_LIMIT, FIELD_LIMIT) : undefined;
  const constraintsField = Object.hasOwn(input, "constraints") ? stringList(input.constraints, LIST_LIMIT, FIELD_LIMIT) : undefined;
  const answeredConstraints = answers.find(item => item.question_id === "constraints");
  if (workTypeField !== undefined && answeredWorkType !== undefined && workTypeField !== answeredWorkType.answer) invalid();
  for (const [field, answer] of [[evidenceField, answeredEvidence], [constraintsField, answeredConstraints]] as const) {
    if (field !== undefined && answer !== undefined && canonicalize(field) !== canonicalize([answer.answer])) invalid();
  }
  return {
    objective: nfcString(input.objective, OBJECTIVE_LIMIT),
    work_type: workTypeField ?? (answeredWorkType !== undefined ? parseWorkType(answeredWorkType.answer) : undefined),
    completion_evidence: evidenceField ?? (answeredEvidence !== undefined ? [answeredEvidence.answer] : []),
    constraints: constraintsField ?? (answeredConstraints !== undefined ? [answeredConstraints.answer] : []),
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

export function parseMatrix(value: unknown): Map<CapabilityFact["id"], CapabilityFact> {
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
