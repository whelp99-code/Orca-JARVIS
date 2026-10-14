import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { controlCommandDigest } from "./control-plane-contract.js";
import { JarvisError } from "./jarvis-error.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const companyTargetSchema = z.object({
  provider_instance_id: id,
  workspace_id: z.uuid(),
  candidate_id: z.string().min(1).max(2048).refine(value => value.normalize("NFC") === value
    && [...value].every(char => char.charCodeAt(0) >= 32
      && (char.length === 2 || char.charCodeAt(0) < 0xd800 || char.charCodeAt(0) > 0xdfff))),
  content_digest: digest,
}).strict();
export const companyArgumentsSchema = z.object({
  owner: id,
  projects: z.array(id).max(128).refine(value => new Set(value).size === value.length),
  policy_revision: id,
  deletion_sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  deletion_set_root: digest,
  processor_principal_id: id,
  operations: z.tuple([z.literal("accept"), z.literal("reject"), z.literal("mark_processed")]),
}).strict().refine(value => value.owner !== value.processor_principal_id);
const commandSchema = z.object({
  schema_version: z.literal(1),
  request_id: z.string().regex(/^company-handoff:v1:[a-f0-9]{64}:[1-9][0-9]*$/),
  action: z.literal("company.candidate.transition"),
  action_level: z.literal(3),
  target: companyTargetSchema,
  args: companyArgumentsSchema,
  reversible: z.literal(false),
  requested_by: id,
  requested_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  nonce: z.string().max(256),
}).strict();
export type CompanyCommand = z.infer<typeof commandSchema>;
const handoffSchema = z.object({
  idempotency_key: z.string().regex(/^company-handoff:v1:[a-f0-9]{64}$/),
  command: commandSchema,
  command_digest: digest,
}).strict();
export const companyPageSchema = z.object({
  handoffs: z.array(handoffSchema).max(1000),
  count: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.int().min(1).max(1000),
  offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().refine(value => value.handoffs.length === Math.min(value.limit, Math.max(0, value.count - value.offset)));

export function companyHandoffKey(command: Pick<CompanyCommand, "target" | "args">): string {
  return `company-handoff:v1:${createHash("sha256")
    .update("second-brain/company-handoff/v1\0")
    .update(canonicalize({ target: command.target, args: command.args })).digest("hex")}`;
}

export function parseCompanyCommand(value: unknown): CompanyCommand {
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("COMPANY_COMMAND_INVALID");
  const command = parsed.data;
  const key = companyHandoffKey(command);
  const generation = Number(command.request_id.slice(key.length + 1));
  if (!command.request_id.startsWith(`${key}:`) || !Number.isSafeInteger(generation)
    || command.nonce !== command.request_id || command.requested_by !== command.args.owner
    || Date.parse(command.expires_at) - Date.parse(command.requested_at) !== 86_400_000) {
    throw new JarvisError("COMPANY_COMMAND_INVALID");
  }
  return command;
}

export function parseCompanyHandoff(value: unknown) {
  const parsed = handoffSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("COMPANY_HANDOFF_INVALID");
  const item = parsed.data;
  const command = parseCompanyCommand(item.command);
  if (item.idempotency_key !== companyHandoffKey(command)
    || item.command_digest !== controlCommandDigest(command)) throw new JarvisError("COMPANY_HANDOFF_INVALID");
  return { ...item, command, generation: Number(command.request_id.slice(item.idempotency_key.length + 1)) };
}

export function validateCompanyAction(input: {
  action_level: number; target: Record<string, unknown>; args: Record<string, unknown>;
}): void {
  if (input.action_level !== 3 || !companyTargetSchema.safeParse(input.target).success
    || !companyArgumentsSchema.safeParse(input.args).success) throw new JarvisError("COMPANY_COMMAND_INVALID");
}
