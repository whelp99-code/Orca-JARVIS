import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./jarvis-error.js";
import { CompanyDbFreshness } from "./company-db-freshness.js";
import type { AuthorityDb } from "./db.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeSequence = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

const companyProgressOperations = [
  "decide_approve",
  "decide_reject",
  "accept",
  "reject",
  "complete",
  "mark_processed",
  "delete",
] as const;

const companyTerminalStates = [
  "approved",
  "rejected",
  "accepted",
  "completed",
  "processed_complete",
  "deleted",
] as const;

export type CompanyProgressOperation = (typeof companyProgressOperations)[number];
export type CompanyTerminalState = (typeof companyTerminalStates)[number];

export const companyOperationTerminalStates: {
  readonly [Operation in CompanyProgressOperation]: CompanyTerminalState;
} = Object.freeze({
  decide_approve: "approved",
  decide_reject: "rejected",
  accept: "accepted",
  reject: "rejected",
  complete: "completed",
  mark_processed: "processed_complete",
  delete: "deleted",
});

const companyScopeSchema = z.object({
  provider_instance_id: identifier,
  workspace_id: z.uuid(),
}).strict();

const storeCheckpointSchema = z.object({
  receipt_sequence: safeSequence,
  receipt_root: digest,
  terminal_sequence: safeSequence,
  terminal_root: digest,
  deletion_sequence: safeSequence,
  deletion_root: digest,
}).strict();

export const companyCheckpointSchema = z.object({
  operational_epoch: positiveSafeInteger,
  approval_policy_version: positiveSafeInteger,
  approval_binding_digest: digest,
  revocation_sequence: safeSequence,
  revocation_root: digest,
  stores: z.object({
    jarvis: storeCheckpointSchema,
    second_brain: storeCheckpointSchema,
  }).strict(),
  intent_sequence: safeSequence,
  intent_root: digest,
}).strict();

export type CompanyCheckpoint = z.infer<typeof companyCheckpointSchema>;
export type CompanyScope = z.infer<typeof companyScopeSchema>;

export const freshnessReadRequestSchema = z.object({
  schema_version: z.literal(2),
  scope: companyScopeSchema,
  installation_id: identifier,
  challenge: identifier,
  observed_checkpoint: companyCheckpointSchema,
}).strict();

export type FreshnessReadRequest = z.infer<typeof freshnessReadRequestSchema>;

function closedRead(status: "mismatch" | "unavailable" | "uncertain") {
  return z.object({
    schema_version: z.literal(2),
    scope: companyScopeSchema,
    challenge: identifier,
    status: z.literal(status),
    checkpoint: z.null(),
  }).strict();
}

export const freshnessReadResponseSchema = z.discriminatedUnion("status", [
  z.object({
    schema_version: z.literal(2),
    scope: companyScopeSchema,
    challenge: identifier,
    status: z.literal("ready"),
    checkpoint: companyCheckpointSchema,
  }).strict(),
  closedRead("mismatch"),
  closedRead("unavailable"),
  closedRead("uncertain"),
]);

export type FreshnessReadResponse = z.infer<typeof freshnessReadResponseSchema>;

export const reserveProgressRequestSchema = z.object({
  schema_version: z.literal(2),
  scope: companyScopeSchema,
  operation_id: digest,
  operation: z.enum(companyProgressOperations),
  expected_checkpoint: companyCheckpointSchema,
  event_digest: digest,
  challenge: identifier,
}).strict();

export type ReserveProgressRequest = z.infer<typeof reserveProgressRequestSchema>;

const freshnessRequiredErrorSchema = z.object({
  schema_version: z.literal(2),
  outcome: z.literal("error"),
  code: z.literal("COMPANY_FRESHNESS_REQUIRED"),
}).strict();

function heldReservation(outcome: "reserved" | "already_reserved") {
  return z.object({
    schema_version: z.literal(2),
    scope: companyScopeSchema,
    challenge: identifier,
    outcome: z.literal(outcome),
    checkpoint: companyCheckpointSchema,
    reservation_id: identifier,
  }).strict();
}

export const reserveProgressResponseSchema = z.discriminatedUnion("outcome", [
  heldReservation("reserved"),
  heldReservation("already_reserved"),
  z.object({
    schema_version: z.literal(2),
    scope: companyScopeSchema,
    challenge: identifier,
    outcome: z.literal("conflict"),
    checkpoint: z.null(),
    reservation_id: z.null(),
  }).strict(),
  freshnessRequiredErrorSchema,
]);

export type ReserveProgressResponse = z.infer<typeof reserveProgressResponseSchema>;

export const finishProgressRequestSchema = z.object({
  schema_version: z.literal(2),
  scope: companyScopeSchema,
  operation_id: digest,
  reservation_id: identifier,
  expected_checkpoint: companyCheckpointSchema,
  evidence_digest: digest,
  terminal_state: z.enum(companyTerminalStates),
  challenge: identifier,
}).strict();

export type FinishProgressRequest = z.infer<typeof finishProgressRequestSchema>;

function recordedFinish(outcome: "recorded" | "already_recorded") {
  return z.object({
    schema_version: z.literal(2),
    scope: companyScopeSchema,
    challenge: identifier,
    outcome: z.literal(outcome),
    checkpoint: companyCheckpointSchema,
  }).strict();
}

export const finishProgressResponseSchema = z.discriminatedUnion("outcome", [
  recordedFinish("recorded"),
  recordedFinish("already_recorded"),
  z.object({
    schema_version: z.literal(2),
    scope: companyScopeSchema,
    challenge: identifier,
    outcome: z.literal("conflict"),
    checkpoint: z.null(),
  }).strict(),
  freshnessRequiredErrorSchema,
]);

export type FinishProgressResponse = z.infer<typeof finishProgressResponseSchema>;

const commandOperationIdInputSchema = z.object({
  scope: companyScopeSchema,
  request_id: z.string().min(1).max(2048),
  command_digest: digest,
  operation: z.enum(companyProgressOperations).exclude(["delete"]),
}).strict();
const operationIdInputSchema = z.union([
  commandOperationIdInputSchema,
  z.object({ scope: companyScopeSchema, deletion_plan_digest: digest, operation: z.literal("delete") }).strict(),
]);

const unconfiguredConfigSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal("unconfigured"),
}).strict();
const providerConfigSchema = z.discriminatedUnion("kind", [
  unconfiguredConfigSchema,
  z.object({
    schema_version: z.literal(2), kind: z.literal("sb_company_db"),
    client_config_file: z.string().min(1).max(4096).startsWith("/"),
  }).strict(),
]);

const OPERATION_DOMAIN = "second-brain/company-operation/v1";

export interface CompanyFreshnessProvider {
  readonly kind?: "sb_company_db";
  readFreshness(request: FreshnessReadRequest): FreshnessReadResponse;
  reserveProgress(request: ReserveProgressRequest): ReserveProgressResponse;
  finishProgress(request: FinishProgressRequest): FinishProgressResponse;
}

function parseContract<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  return parsed.data;
}

function domainDigest(domain: string, canonical: string): string {
  return `sha256:${createHash("sha256").update(`${domain}\0`).update(canonical).digest("hex")}`;
}

export function companyOperationId(input: z.infer<typeof operationIdInputSchema>): string {
  const parsed = parseContract(operationIdInputSchema, input);
  return domainDigest(OPERATION_DOMAIN, canonicalize(parsed));
}

function unavailableRead(request: FreshnessReadRequest): FreshnessReadResponse {
  return parseContract(freshnessReadResponseSchema, {
    schema_version: 2,
    scope: request.scope,
    challenge: request.challenge,
    status: "unavailable",
    checkpoint: null,
  });
}

function freshnessRequired(): ReserveProgressResponse & FinishProgressResponse {
  return parseContract(freshnessRequiredErrorSchema, {
    schema_version: 2,
    outcome: "error",
    code: "COMPANY_FRESHNESS_REQUIRED",
  });
}

class UnconfiguredCompanyFreshness implements CompanyFreshnessProvider {
  readFreshness(request: FreshnessReadRequest): FreshnessReadResponse {
    return unavailableRead(parseContract(freshnessReadRequestSchema, request));
  }

  reserveProgress(request: ReserveProgressRequest): ReserveProgressResponse {
    parseContract(reserveProgressRequestSchema, request);
    return freshnessRequired();
  }

  finishProgress(request: FinishProgressRequest): FinishProgressResponse {
    parseContract(finishProgressRequestSchema, request);
    return freshnessRequired();
  }
}

export function loadCompanyFreshness(config: unknown, authority?: AuthorityDb): CompanyFreshnessProvider {
  const parsed = parseContract(providerConfigSchema, config);
  switch (parsed.kind) {
    case "sb_company_db": return new CompanyDbFreshness(parsed.client_config_file, authority);
    case "unconfigured": return new UnconfiguredCompanyFreshness();
    default: {
      const exhaustive: never = parsed;
      void exhaustive;
      throw new JarvisError("COMPANY_CONTRACT_INVALID");
    }
  }
}
