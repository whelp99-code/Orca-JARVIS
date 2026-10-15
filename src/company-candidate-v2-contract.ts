import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { companyArgumentsSchema, companyTargetSchema } from "./company-candidate-contract.js";
import { controlCommandDigest } from "./control-plane-contract.js";
import { JarvisError } from "./jarvis-error.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const companyTargetV2Schema = companyTargetSchema.extend({
  candidate_id: z.string().refine(value => {
    const chars = [...value];
    return chars.length >= 1 && chars.length <= 2048 && value.normalize("NFC") === value
      && chars.every(char => {
        const point = char.codePointAt(0);
        return point !== undefined && point >= 32 && (point < 127 || point > 159)
          && (point < 0xd800 || point > 0xdfff);
      });
  }),
});

export const companyArgumentsV2Schema = companyArgumentsSchema.safeExtend({
  deletion_sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER).refine(value => !Object.is(value, -0)),
  approver_principal_id: id,
  approval_policy_version: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  approval_binding_digest: digest,
}).refine(value => value.approver_principal_id !== value.owner
  && value.approver_principal_id !== value.processor_principal_id
    && value.projects.every((project, index, projects) => {
      const previous = projects[index - 1];
      return index === 0 || (previous !== undefined && previous < project);
    }));

const commandSchema = z.object({
  schema_version: z.literal(2),
  request_id: z.string().regex(/^company-handoff:v2:[a-f0-9]{64}:[1-9][0-9]*$/),
  action: z.literal("company.candidate.transition"),
  action_level: z.literal(3),
  target: companyTargetV2Schema,
  args: companyArgumentsV2Schema,
  reversible: z.literal(false),
  requested_by: id,
  requested_at: z.iso.datetime({ precision: 3 }),
  expires_at: z.iso.datetime({ precision: 3 }),
  nonce: z.string().max(256),
}).strict();
export type CompanyCommandV2 = z.infer<typeof commandSchema>;

const handoffSchema = z.object({
  idempotency_key: z.string().regex(/^company-handoff:v2:[a-f0-9]{64}$/),
  command: commandSchema,
  command_digest: digest,
}).strict();

export const companyPageV2Schema = z.object({
  handoffs: z.array(handoffSchema).max(1000),
  count: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.int().min(1).max(1000),
  offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().refine(value => value.handoffs.length === Math.min(value.limit, Math.max(0, value.count - value.offset)));

export function companyHandoffKeyV2(command: { target: CompanyCommandV2["target"]; args: CompanyCommandV2["args"] }): string {
  return `company-handoff:v2:${createHash("sha256")
    .update("second-brain/company-handoff/v2\0")
    .update(canonicalize({ target: command.target, args: command.args })).digest("hex")}`;
}

function identityChecked(value: unknown): CompanyCommandV2 {
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("COMPANY_COMMAND_INVALID");
  const command = parsed.data;
  const key = companyHandoffKeyV2(command);
  const generation = Number(command.request_id.slice(key.length + 1));
  if (!command.request_id.startsWith(`${key}:`) || !Number.isSafeInteger(generation)
    || command.nonce !== command.request_id || command.requested_by !== command.args.owner
    || Date.parse(command.expires_at) - Date.parse(command.requested_at) !== 86_400_000) {
    throw new JarvisError("COMPANY_COMMAND_INVALID");
  }
  return command;
}

export function decodeCompanyCommandV2(value: unknown): CompanyCommandV2 {
  return identityChecked(value);
}

export function parseCompanyCommandV2(value: unknown, now: Date): CompanyCommandV2 {
  const command = identityChecked(value);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || Date.parse(command.requested_at) > nowMs || Date.parse(command.expires_at) <= nowMs) {
    throw new JarvisError("COMPANY_COMMAND_INVALID");
  }
  return command;
}

export function parseCompanyHandoffV2(value: unknown) {
  const parsed = handoffSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("COMPANY_HANDOFF_INVALID");
  const item = parsed.data;
  const command = decodeCompanyCommandV2(item.command);
  if (item.idempotency_key !== companyHandoffKeyV2(command)
    || item.command_digest !== controlCommandDigest(command)) throw new JarvisError("COMPANY_HANDOFF_INVALID");
  return { ...item, command, generation: Number(command.request_id.slice(item.idempotency_key.length + 1)) };
}
