import { z } from "zod";
const retention = z.object({ source: z.literal("policy"), days: z.number().int(), expires_at: z.string() }).strict();
const record = z.object({ record_token: z.string(), record_revision: z.string(), title: z.string(),
  excerpt: z.string().nullable(), citation: z.string(), sensitivity: z.string(), retention,
  freshness: z.string(), provenance: z.object({ source_class: z.literal("memory"), owner_class: z.string(),
    origin_label: z.string(), origin_revision: z.string().nullable() }).strict(),
  conflict_state: z.enum(["none", "unresolved"]), history_state: z.enum(["current", "superseded"]),
  actions: z.array(z.enum(["inspect", "correct", "forget", "export"])) }).strict();
export const MemoryStatusSchema = z.object({ schema_version: z.literal(1), resource: z.literal("memory-status"),
  state: z.string(), privacy_epoch: z.number().int(), checked_at: z.string(), fresh_until: z.string(),
  contract_schema: z.union([z.literal(3), z.literal(4)]).nullable(), mutations_enabled: z.boolean() }).strict();
export const MemorySearchSchema = z.object({ schema_version: z.literal(1), resource: z.literal("memory-search"),
  generated_at: z.string(), state: z.string(), query_revision: z.string(), resource_revision: z.string(),
  privacy_epoch: z.number().int(), provider_generation: z.string().nullable(), items: z.array(record).max(20),
  truncated: z.boolean(), omissions: z.array(z.string()), checked_at: z.string(), fresh_until: z.string() }).strict();
const page = z.object({ limit: z.number().int(), returned: z.number().int(), has_more: z.boolean(),
  next_cursor: z.string().nullable() }).strict();
export const MemoryConflictsSchema = z.object({ schema_version: z.literal(1),
  resource: z.literal("memory-conflicts"), generated_at: z.string(), state: z.string(),
  privacy_epoch: z.number().int(), items: z.array(z.object({ conflict_revision: z.string(), subject: z.string(),
    state: z.literal("unresolved"), sides: z.array(z.object({ sensitivity: z.string(),
      citation: z.string() }).strict()).length(2) }).strict()).max(20), truncated: z.boolean() }).strict();
export const MemoryCandidatesSchema = z.object({ schema_version: z.literal(1), resource: z.literal("memory-candidates"),
  generated_at: z.string(), state: z.string(), items: z.array(z.object({ candidate_id: z.string(),
    candidate_revision: z.string(), kind: z.string(), operation: z.string(), confidence: z.string(),
    sensitivity: z.string(), retention: z.object({ source: z.literal("policy"), days: z.number() }).strict(),
    expires_at: z.string(), reason: z.string(), conflict: z.string(), provenance: z.string(),
    review_state: z.string(), actions: z.array(z.string()) }).strict()).max(100), page }).strict();
export const MemoryEffectsSchema = z.object({ schema_version: z.literal(1), resource: z.literal("memory-effects"),
  generated_at: z.string(), state: z.string(), items: z.array(z.object({ request_id: z.string(),
    operation: z.string(), state: z.string(), failure_code: z.string().nullable(), updated_at: z.string(),
    proof_state: z.string(), export_lifecycle: z.unknown().nullable() }).strict()).max(100), page }).strict();
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
export type MemorySearch = z.infer<typeof MemorySearchSchema>;
export type MemoryRecord = z.infer<typeof record>;
export type MemoryConflicts = z.infer<typeof MemoryConflictsSchema>;
export type MemoryCandidates = z.infer<typeof MemoryCandidatesSchema>;
export type MemoryEffects = z.infer<typeof MemoryEffectsSchema>;
export type MemorySnapshot = { readonly state: "loading" | "ready" | "error"; readonly status?: MemoryStatus;
  readonly search?: MemorySearch; readonly conflicts?: MemoryConflicts;
  readonly candidates?: MemoryCandidates; readonly effects?: MemoryEffects;
  readonly message?: string };
