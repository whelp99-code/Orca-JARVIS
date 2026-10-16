import { readFileSync } from "node:fs";
import { canonicalize } from "../../src/canonical.js";
import { loadCompanyFreshness, freshnessReadRequestSchema, reserveProgressRequestSchema } from "../../src/company-freshness.js";

const [config, method] = process.argv.slice(2);
if (!config) throw new Error("Missing client config");
const request: unknown = JSON.parse(readFileSync(0, "utf8"));
const provider = loadCompanyFreshness({ schema_version: 2, kind: "sb_company_db", client_config_file: config });
switch (method) {
  case "read_freshness": process.stdout.write(canonicalize(provider.readFreshness(freshnessReadRequestSchema.parse(request)))); break;
  case "reserve_progress": process.stdout.write(canonicalize(provider.reserveProgress(reserveProgressRequestSchema.parse(request)))); break;
  default: throw new Error("Unsupported fixture method");
}
