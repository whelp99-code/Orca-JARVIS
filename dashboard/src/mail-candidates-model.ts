export { MAIL_CANDIDATE_RECENT_LIMIT, mailCandidatesSummarySchema,
  type MailCandidatesSummary } from "../../src/integration/mail-candidates-contract.js";
export type MailCandidatesReadAdapter = Readonly<{
  workspace_id?: string;
  read(signal: AbortSignal): Promise<unknown>;
}>;
