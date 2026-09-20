import { JarvisError } from "../jarvis-error.js";
import { CORE5_INTEGRATION_AUDIENCE, type VerifiedCallerContext } from "./types.js";

const FORBIDDEN_SELF_ASSERT = Object.freeze(["permission", "permissions", "authorized", "roles", "scopes"]);

export type CallerAssertion = {
  readonly principal: string;
  readonly workspace: string;
  readonly purpose: string;
  readonly expiry: string;
  readonly audience: string;
};

export type VerifiedIssuer = {
  verify(assertion: CallerAssertion, now: Date): VerifiedCallerContext;
};

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new JarvisError("CORE5_CALLER_INVALID", field);
  }
  return value;
}

export function rejectSelfAssertedPermission(request: Readonly<Record<string, unknown>>): void {
  for (const key of FORBIDDEN_SELF_ASSERT) {
    if (Object.prototype.hasOwnProperty.call(request, key)) {
      throw new JarvisError("CORE5_CALLER_SELF_ASSERTED_PERMISSION", key);
    }
  }
}

export class StaticVerifiedIssuer implements VerifiedIssuer {
  constructor(
    private readonly allowed: Readonly<{
      principal: string;
      workspace: string;
      audience: string;
    }>,
  ) {}

  verify(assertion: CallerAssertion, now: Date): VerifiedCallerContext {
    const principal = nonempty(assertion.principal, "principal");
    const workspace = nonempty(assertion.workspace, "workspace");
    const purpose = nonempty(assertion.purpose, "purpose");
    const expiry = nonempty(assertion.expiry, "expiry");
    const audience = nonempty(assertion.audience, "audience");
    if (principal !== this.allowed.principal) throw new JarvisError("CORE5_CALLER_UNVERIFIED", "principal");
    if (workspace !== this.allowed.workspace) throw new JarvisError("CORE5_CALLER_UNVERIFIED", "workspace");
    if (audience !== this.allowed.audience) throw new JarvisError("CORE5_CALLER_UNVERIFIED", "audience");
    if (audience !== CORE5_INTEGRATION_AUDIENCE) throw new JarvisError("CORE5_CALLER_UNVERIFIED", "audience");
    const expires = Date.parse(expiry);
    if (!Number.isFinite(expires) || expires <= now.getTime()) {
      throw new JarvisError("CORE5_CALLER_EXPIRED", expiry);
    }
    return Object.freeze({ principal, workspace, purpose, expiry, audience });
  }
}

export function verifyCallerRequest(
  request: Readonly<Record<string, unknown>>,
  issuer: VerifiedIssuer,
  now: Date,
): VerifiedCallerContext {
  rejectSelfAssertedPermission(request);
  const caller = request["caller"];
  if (typeof caller !== "object" || caller === null || Array.isArray(caller)) {
    throw new JarvisError("CORE5_CALLER_INVALID", "caller");
  }
  rejectSelfAssertedPermission(caller as Readonly<Record<string, unknown>>);
  const record = caller as Readonly<Record<string, unknown>>;
  return issuer.verify({
    principal: nonempty(record["principal"], "principal"),
    workspace: nonempty(record["workspace"], "workspace"),
    purpose: nonempty(record["purpose"], "purpose"),
    expiry: nonempty(record["expiry"], "expiry"),
    audience: nonempty(record["audience"], "audience"),
  }, now);
}
