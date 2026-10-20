import { z } from "zod";
import { CompanyDbFreshness } from "./company-db-freshness.js";
import { freshnessReadRequestSchema, reserveProgressRequestSchema, finishProgressRequestSchema,
  type CompanyFreshnessProvider } from "./company-freshness-contract.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
export * from "./company-freshness-contract.js";

const providerConfigSchema = z.discriminatedUnion("kind", [
  z.object({ schema_version: z.literal(2), kind: z.literal("unconfigured") }).strict(),
  z.object({ schema_version: z.literal(2), kind: z.literal("sb_company_db"),
    client_config_file: z.string().min(1).max(4096).startsWith("/") }).strict(),
]);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  return result.data;
}
const required = () => ({ schema_version: 2, outcome: "error", code: "COMPANY_FRESHNESS_REQUIRED" } as const);

/** Public selection entry point; wire schemas live below the transport/factory dependency boundary. */
export function loadCompanyFreshness(config: unknown, authority?: AuthorityDb): CompanyFreshnessProvider {
  const parsed = parse(providerConfigSchema, config);
  switch (parsed.kind) {
    case "sb_company_db": return new CompanyDbFreshness(parsed.client_config_file, authority);
    case "unconfigured": return {
      readFreshness(value) {
        const request = parse(freshnessReadRequestSchema, value);
        return { schema_version: 2, scope: request.scope, challenge: request.challenge, status: "unavailable", checkpoint: null };
      },
      reserveProgress(value) { parse(reserveProgressRequestSchema, value); return required(); },
      finishProgress(value) { parse(finishProgressRequestSchema, value); return required(); },
    };
    default: {
      const exhaustive: never = parsed;
      void exhaustive;
      throw new JarvisError("COMPANY_CONTRACT_INVALID");
    }
  }
}
