import { parseCompanyJson } from "./company-candidate-json.js";
import { loadCompanyFreshness, type CompanyFreshnessProvider } from "./company-freshness.js";
import type { AuthorityDb } from "./db.js";
import { readCandidateCredential } from "./integration/candidate-reader-credential.js";

/** Operator-only file input. Requests and environment variables cannot select a provider. */
export function configuredCompanyFreshness(path: string | undefined, authority: AuthorityDb): CompanyFreshnessProvider {
  return loadCompanyFreshness(path === undefined ? { schema_version: 2, kind: "unconfigured" }
    : parseCompanyJson(readCandidateCredential(path)), authority);
}
