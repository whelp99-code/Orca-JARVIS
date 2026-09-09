import { parseSecondBrainPageAccess, type PageAccessScope } from "./second-brain-page-access.js";
import { JarvisError } from "./db.js";
import type { SecondBrainAdapterBudgets } from "./second-brain-adapter-types.js";
import { parseSecondBrainBoundRecords } from "./second-brain-evidence-parser.js";
import { bindSecondBrainGenerationRead, SECOND_BRAIN_GENERATION_BINDING_KEY, secondBrainGenerationBinding } from "./second-brain-generation-read.js";
import type { MemoryReadFenceV1 } from "./second-brain-effect-v2.js";
import { SecondBrainReadBudget } from "./second-brain-read-budget.js";

type ScopedExpectation = {
  readonly method: "sb_read_page" | "sb_search" | "sb_generation_status" | "sb_request_status";
  readonly profile?: "scoped-record-read-v1" | "scoped-record-read-v2" | "scoped-record-read-v3" | "scoped-record-read-v4" | "scoped-record-read-v5";
  readonly scope?: PageAccessScope;
  readonly page_id?: string;
  readonly limit: number;
  readonly request_digest: string;
  readonly access_claim_digest: string;
  readonly authorized_until: string;
  readonly fence: MemoryReadFenceV1;
  readonly checked_at: Date;
  readonly budgets: SecondBrainAdapterBudgets;
  readonly max_age_ms: number;
  readonly expiry_ms: number;
};
const generationKeys = ["provider_instance_id", "generation_id", "generation_manifest_digest",
  "vault_head", "vault_tree", "tombstone_sequence", "tombstone_set_root"];
const checksum = /^sha256:[0-9a-f]{64}$/;
const fail = (): never => { throw new JarvisError("SECOND_BRAIN_SCOPED_RESPONSE_INVALID"); };
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function pageId(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed() && /^(wiki|daily|conflicts)\//.test(value)
    && value === value.normalize("NFC") && value === value.toLowerCase()
    && !value.includes("\\") && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    && value.split("/").every(part => !["", ".", "..", "_proposed"].includes(part));
}

/** Validate provider response identity and budgets; does not prove task correctness
 * or independently authorize the content. Caller retains its authenticated request. */
export function parseScopedSecondBrainResponse(value: unknown, expected: ScopedExpectation) {
  const budget = new SecondBrainReadBudget(expected.budgets);
  if (budget.consumeProvider(value, expected.method === "sb_read_page") !== undefined || !object(value)
    || value.profile !== (expected.profile ?? "scoped-record-read-v1")
    || !checksum.test(expected.request_digest) || value.request_digest !== expected.request_digest
    || !checksum.test(expected.access_claim_digest) || value.access_claim_digest !== expected.access_claim_digest
    || !Number.isSafeInteger(expected.limit) || expected.limit < 1 || expected.limit > (expected.method === "sb_search" ? 50 : 64)
    || !Number.isFinite(expected.checked_at.getTime())
    || !(expected.checked_at.getTime() < Date.parse(expected.authorized_until))
    || expected.fence.purpose !== (["sb_generation_status", "sb_request_status"].includes(expected.method) ? "memory_status" : "memory_read")
    || expected.fence.operation !== (["sb_generation_status", "sb_request_status"].includes(expected.method) ? "status" : "read")
    || !(Date.parse(expected.fence.not_before) <= expected.checked_at.getTime()
      && expected.checked_at.getTime() < Date.parse(expected.fence.expires_at))) return fail();
  const classified = expected.profile === "scoped-record-read-v3" || expected.profile === "scoped-record-read-v4" ||
    expected.profile === "scoped-record-read-v5";
  const payloadKeys = expected.method === "sb_request_status" ? ["request_status"] : expected.method === "sb_generation_status" ?
    ["schema_version", "pointer_health", "journal_health"] : expected.method === "sb_read_page" ? ["page_id", "content_digest", "records",
    ...(classified ? ["page_access"] : [])] : ["results"];
  if (!exact(value, ["profile", "request_digest", "access_claim_digest", ...generationKeys, ...payloadKeys])) return fail();
  const bound = bindSecondBrainGenerationRead(value, { fence: expected.fence, method: ["sb_generation_status",
    "sb_request_status"].includes(expected.method) ? "sb_read_page" : expected.method as "sb_read_page" | "sb_search",
    contract_profile: "schema4", unbound_generations: new Map() });
  if (bound === undefined) return fail();
  const generation = secondBrainGenerationBinding(bound);
  if (generation === undefined || (classified && (generation.tombstone_sequence < 0
    || generation.generation_id !== `sbgen:v1:${generation.generation_manifest_digest.slice(7)}`))) return fail();
  if (expected.method === "sb_request_status") {
    if (expected.profile !== "scoped-record-read-v4" && expected.profile !== "scoped-record-read-v5") return fail();
    return { generation, pages: [], request_status: value.request_status };
  }
  if (expected.method === "sb_generation_status") {
    if ((!classified && expected.profile !== "scoped-record-read-v2") || value.schema_version !== 1
      || value.pointer_health !== "healthy" || value.journal_health !== "healthy") return fail();
    return { generation, pages: [] };
  }
  const groups = new Map<string, { digest: string; records: unknown[] }>();
  function add(id: unknown, digest: unknown, records: unknown) {
    if (!pageId(id) || typeof digest !== "string" || !checksum.test(digest) || !Array.isArray(records)) return fail();
    const existing = groups.get(id);
    if (existing !== undefined && existing.digest !== digest) return fail();
    const group = existing ?? { digest, records: [] };
    group.records.push(...records); groups.set(id, group);
  }
  if (expected.method === "sb_read_page") {
    const requested = expected.page_id;
    if (requested === undefined || value.page_id !== (requested.includes("/") ? requested : `wiki/${requested}`)
      || !Array.isArray(value.records) || value.records.length > expected.limit) return fail();
    add(value.page_id, value.content_digest, value.records);
  } else {
    if (!Array.isArray(value.results) || value.results.length > Math.min(expected.limit, expected.budgets.max_hits, 50)) return fail();
    for (const row of value.results) {
      if (!object(row) || !exact(row, ["page_id", "content_digest", "record"])) return fail();
      add(row.page_id, row.content_digest, [row.record]);
    }
  }
  const pages = [...groups].map(([id, group]) => {
    const parsed = parseSecondBrainBoundRecords({ value: { records: group.records, [SECOND_BRAIN_GENERATION_BINDING_KEY]: generation },
      requestedPageId: id, checkedAt: expected.checked_at, budgets: expected.budgets, requestBudget: budget,
      maxAgeMs: expected.max_age_ms, expiryMs: expected.expiry_ms }, group.digest);
    if (parsed.kind === "invalid") return fail();
    return { page_id: id, content_digest: group.digest, parsed,
      ...(classified && expected.method === "sb_read_page" ? { access: parseSecondBrainPageAccess(value.page_access, expected.scope) } : {}) };
  });
  return { generation, pages };
}
