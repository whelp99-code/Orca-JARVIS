import { z } from "zod";
import { JarvisError } from "../jarvis-error.js";
import { verifyCallerRequest, type VerifiedIssuer } from "./caller-context.js";
import { isCore5IntegrationEnabled } from "./flag.js";
import { CORE5_INTEGRATION_CAPABILITIES, type VerifiedCallerContext } from "./types.js";

export const CORE5_INTEGRATION_V2_CAPABILITIES = Object.freeze([
  ...CORE5_INTEGRATION_CAPABILITIES, "finance.read",
] as const);

const identifier = z.string().min(1).max(256);
const financePayload = z.object({
  company_id: identifier,
  case_id: identifier.optional(),
  report_id: identifier.optional(),
  source_revision: identifier,
  view: z.enum(["reconciliation", "owner_report", "discrepancy"]),
}).strict().refine(value => (value.case_id === undefined) !== (value.report_id === undefined), {
  message: "Exactly one case_id or report_id is required",
}).readonly();

const financeEnvelope = z.object({
  schema_version: z.literal(2),
  capability: z.literal("finance.read"),
  operation_id: identifier,
  attempt_id: identifier,
  lease_fence: identifier,
  target_id: identifier,
  payload: financePayload,
  caller: z.object({
    principal: identifier,
    workspace: identifier,
    purpose: identifier,
    expiry: identifier,
    audience: identifier,
  }).strict().readonly(),
}).strict().refine(value => new Set([
  value.operation_id, value.attempt_id, value.lease_fence,
]).size === 3, { message: "Operation, attempt and fence must be distinct" }).readonly();

export type FinanceReadEnvelope = z.infer<typeof financeEnvelope>;
export type RegisteredFinanceReadTarget = {
  readonly target_id: string;
  readonly provider: "price";
  readonly supported_versions: readonly number[];
  readonly capabilities: readonly string[];
  readonly principal: "agent:jarvis";
  readonly workspace: string;
  readonly company_ids: readonly string[];
};
export type PreparedFinanceRead = Omit<FinanceReadEnvelope, "caller"> & {
  readonly caller: VerifiedCallerContext;
};

export function parseFinanceReadEnvelope(value: unknown): FinanceReadEnvelope {
  const parsed = financeEnvelope.safeParse(value);
  if (!parsed.success) throw new JarvisError("CORE5_FINANCE_INPUT_INVALID");
  return parsed.data;
}

/** Prepares only a bounded read against a registered Price target.
 * Registration and caller verification come from trusted composition, not the request.
 * This does not issue authority, call a provider, or settle an execution result.
 */
export class Core5FinanceReadGateway {
  constructor(
    private readonly targets: readonly RegisteredFinanceReadTarget[],
    private readonly issuer: VerifiedIssuer,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  prepare(value: unknown, now: Date): PreparedFinanceRead {
    const envelope = parseFinanceReadEnvelope(value);
    if (!isCore5IntegrationEnabled(this.env)) throw new JarvisError("CORE5_INTEGRATION_DISABLED");
    const target = this.targets.find(item => item.target_id === envelope.target_id);
    if (target === undefined) throw new JarvisError("CORE5_FINANCE_TARGET_UNREGISTERED");
    if (!target.supported_versions.includes(2) || !target.capabilities.includes("finance.read")) {
      throw new JarvisError("CORE5_FINANCE_VERSION_UNSUPPORTED");
    }
    const caller = verifyCallerRequest(envelope, this.issuer, now);
    if (caller.principal !== target.principal || caller.workspace !== target.workspace
      || caller.purpose !== "finance.read") throw new JarvisError("CORE5_FINANCE_CALLER_SCOPE_DENIED");
    if (!target.company_ids.includes(envelope.payload.company_id)) {
      throw new JarvisError("CORE5_FINANCE_COMPANY_SCOPE_DENIED");
    }
    return Object.freeze({ ...envelope, caller });
  }
}
