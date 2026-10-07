import { JarvisError } from "../../src/jarvis-error.js";
import { StaticVerifiedIssuer } from "../../src/integration/caller-context.js";
import {
  Core5FinanceReadGateway,
  type FinanceReadEnvelope,
  type PreparedFinanceRead,
} from "../../src/integration/finance-read-gateway.js";
import { CORE5_INTEGRATION_AUDIENCE } from "../../src/integration/types.js";
import {
  readAdmittedCompanyMemoryFixture,
  type CompanyMemoryReceiptEvidence,
} from "./company-memory-admitted-fixture.js";
import { readAdmittedMailCrmFixture, type MailCrmReceiptEvidence } from "./mail-crm-admitted-fixture.js";
import { readAdmittedCrmMemoryFixture, type CrmMemoryReceiptEvidence } from "./crm-memory-admitted-fixture.js";
import type { LocalWorkCard } from "./local-work-card-model.js";

export type FinanceReadAdapter = Readonly<{
  proof_level: "isolated-fixture";
  target_id: string;
  company_id: string;
  source_revision: string;
  company_memory_evidence: CompanyMemoryReceiptEvidence;
  mail_crm_evidence: MailCrmReceiptEvidence;
  crm_memory_evidence: CrmMemoryReceiptEvidence;
  work_card?: LocalWorkCard;
  prepare(value: unknown): PreparedFinanceRead;
  request(payload: FinanceReadEnvelope["payload"], version: number): unknown;
}>;

/** Explicit fixture composition. No provider, human authority or financial effect. */
export function createIsolatedFinanceReadAdapter(clock = () => new Date()): FinanceReadAdapter {
  const company_id = "company:fp5-fixture";
  const target_id = "price:fp5-fixture";
  const source_revision = "fixture:fp5-v1";
  const caller = Object.freeze({
    principal: "agent:jarvis",
    workspace: company_id,
    purpose: "finance.read",
    expiry: new Date(clock().getTime() + 60 * 60 * 1_000).toISOString(),
    audience: CORE5_INTEGRATION_AUDIENCE,
  });
  const gateway = new Core5FinanceReadGateway([{
    target_id, provider: "price", supported_versions: [2], capabilities: ["finance.read"],
    principal: "agent:jarvis", workspace: company_id, company_ids: [company_id],
  }], new StaticVerifiedIssuer(caller), { CORE5_INTEGRATION_ENABLED: "1" });
  return Object.freeze({
    proof_level: "isolated-fixture",
    target_id, company_id, source_revision,
    company_memory_evidence: readAdmittedCompanyMemoryFixture(),
    mail_crm_evidence: readAdmittedMailCrmFixture(),
    crm_memory_evidence: readAdmittedCrmMemoryFixture(),
    request(payload: FinanceReadEnvelope["payload"], version: number) {
      return {
        schema_version: version, capability: "finance.read", target_id, payload, caller,
        operation_id: `op:${crypto.randomUUID()}`,
        attempt_id: `attempt:${crypto.randomUUID()}`,
        lease_fence: `fence:${crypto.randomUUID()}`,
      };
    },
    prepare(value: unknown) {
      const prepared = gateway.prepare(value, clock());
      if (prepared.payload.source_revision !== source_revision) {
        throw new JarvisError("CORE5_FINANCE_SOURCE_STALE");
      }
      return prepared;
    },
  });
}

/** Compose recorded native bytes only in the explicit fp5-local startup branch. */
export async function createLocalCompositionAdapter(
  clock = () => new Date(),
  rtState: "UNBOUND" | "UNAPPROVED" | "CONFIRMED" | "SOURCE_CHANGED" | null = null,
): Promise<FinanceReadAdapter> {
  const { composeLocalWorkCard } = await import("./local-work-card-model.js");
  const { LOCAL_NATIVE_FINANCE_FIXTURE } = await import("./local-native-finance-fixture.js");
  const fixture = rtState === null ? LOCAL_NATIVE_FINANCE_FIXTURE
    : (await import("./local-native-rt-fixtures.js")).LOCAL_NATIVE_RT_FIXTURES[rtState];
  const work_card = await composeLocalWorkCard({
    ...fixture,
    // Observation of the recorded bytes, never a new producer read/freshness claim.
    observed_at: clock().toISOString(),
  });
  return Object.freeze({ ...createIsolatedFinanceReadAdapter(clock), work_card });
}
