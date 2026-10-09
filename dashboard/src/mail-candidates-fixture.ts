import type { MailCandidatesReadAdapter, MailCandidatesSummary } from "./mail-candidates-model.js";

const workspace_id = "d4eb0c28-aa98-4d22-8f01-ff65e5e11220";
/** Explicit fp5-local startup only. No native credentials, provider or personal-memory fallback. */
export function createMailCandidatesFixture(): MailCandidatesReadAdapter {
  const value: MailCandidatesSummary = {
    schema_version: 1, proof_level: "isolated-fixture", authority: "none",
    observed_at: "2026-10-09T00:00:00.000Z",
    crm: { state: "read", workspace_id, candidate_count: 7,
      recent: Array.from({ length: 5 }, (_, index) => ({
        candidate_id: `fixture-mail-candidate-${5 - index}`,
        title: `격리 메일 후보 ${5 - index} · 프로젝트 자료 확인`,
        received_at: `2026-10-0${8 - index}T00:00:00.000Z`,
      })) },
    sb: { state: "read", workspace_id, candidate_count: 3 },
  };
  return { workspace_id, async read() { return value; } };
}
