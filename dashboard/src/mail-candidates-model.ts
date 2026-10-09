import { z } from "zod";

export const MAIL_CANDIDATE_RECENT_LIMIT = 5;
const count = z.int().nonnegative();
const crmSource = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unconnected") }).strict(),
  z.object({
    state: z.literal("read"), workspace_id: z.uuid(), candidate_count: count,
    recent: z.array(z.object({
      candidate_id: z.string().min(1), title: z.string().min(1).max(2048),
      received_at: z.iso.datetime(),
    }).strict()).max(MAIL_CANDIDATE_RECENT_LIMIT),
  }).strict().refine(value => value.candidate_count >= value.recent.length
    && new Set(value.recent.map(row => row.candidate_id)).size === value.recent.length
    && value.recent.every((row, index) => index === 0
      || Date.parse(row.received_at) <= Date.parse(value.recent[index - 1]?.received_at ?? ""))),
]);
const sbSource = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unconnected") }).strict(),
  z.object({ state: z.literal("read"), workspace_id: z.uuid(), candidate_count: count }).strict(),
]);
export const mailCandidatesSummarySchema = z.object({
  schema_version: z.literal(1), proof_level: z.literal("isolated-fixture"),
  authority: z.literal("none"), observed_at: z.iso.datetime(),
  crm: crmSource, sb: sbSource,
}).strict();
export type MailCandidatesSummary = z.infer<typeof mailCandidatesSummarySchema>;
export type MailCandidatesReadAdapter = Readonly<{
  workspace_id: string;
  read(signal: AbortSignal): Promise<unknown>;
}>;
