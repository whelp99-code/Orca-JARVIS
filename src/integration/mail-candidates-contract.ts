import { z } from "zod";

export const MAIL_CANDIDATE_RECENT_LIMIT = 5;
const count = z.int().nonnegative();
const unconnected = z.object({
  state: z.literal("unconnected"), reason: z.enum(["unconfigured", "refused"]).optional(),
}).strict();
export const crmCandidateMetadataSchema = z.object({
  id: z.string().min(1).max(2048), status: z.string().min(1).max(128),
  confirmed: z.boolean(), freshness: z.string().min(1).max(128), createdAt: z.iso.datetime(),
}).strict();
const fixtureCrm = z.discriminatedUnion("state", [
  unconnected,
  z.object({
    state: z.literal("read"), workspace_id: z.uuid(), candidate_count: count,
    recent: z.array(z.object({
      candidate_id: z.string().min(1), title: z.string().min(1).max(2048), received_at: z.iso.datetime(),
    }).strict()).max(MAIL_CANDIDATE_RECENT_LIMIT),
  }).strict().refine(value => value.candidate_count >= value.recent.length
    && new Set(value.recent.map(row => row.candidate_id)).size === value.recent.length
    && value.recent.every((row, index) => index === 0
      || Date.parse(row.received_at) <= Date.parse(value.recent[index - 1]?.received_at ?? ""))),
]);
export const nativeCrmCandidateReadSchema = z.object({
  state: z.literal("read"), workspace_id: z.uuid(), candidate_count: count,
  recent: z.array(crmCandidateMetadataSchema).max(MAIL_CANDIDATE_RECENT_LIMIT),
}).strict().refine(value => value.recent.length === Math.min(value.candidate_count, MAIL_CANDIDATE_RECENT_LIMIT)
  && new Set(value.recent.map(row => row.id)).size === value.recent.length
  && value.recent.every((row, index) => index === 0
    || Date.parse(row.createdAt) <= Date.parse(value.recent[index - 1]?.createdAt ?? "")));
const sbSource = z.discriminatedUnion("state", [
  unconnected,
  z.object({ state: z.literal("read"), workspace_id: z.uuid(), candidate_count: count }).strict(),
]);
const envelope = { schema_version: z.literal(1), authority: z.literal("none"), observed_at: z.iso.datetime() };
export const mailCandidatesSummarySchema = z.discriminatedUnion("proof_level", [
  z.object({ ...envelope, proof_level: z.literal("isolated-fixture"), crm: fixtureCrm, sb: sbSource }).strict(),
  z.object({ ...envelope, proof_level: z.literal("native-read"),
    crm: z.discriminatedUnion("state", [unconnected, nativeCrmCandidateReadSchema]), sb: sbSource }).strict(),
]);
export type MailCandidatesSummary = z.infer<typeof mailCandidatesSummarySchema>;
export type NativeCrmCandidateRead = z.infer<typeof nativeCrmCandidateReadSchema>;
export type NativeSbCandidateRead = Readonly<{ state: "read"; workspace_id: string; candidate_count: number }>;
