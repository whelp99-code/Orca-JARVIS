import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { secondBrainUtf8Bytes, type SecondBrainReadBudget } from "./second-brain-read-budget.js";
import {
  SECOND_BRAIN_SENSITIVITIES,
  SECOND_BRAIN_SOURCE_ID,
  SECOND_BRAIN_TRUST,
  type SecondBrainAdapterBudgets,
  type SecondBrainConflict,
  type SecondBrainEvidence,
  type SecondBrainSensitivity,
} from "./second-brain-adapter-types.js";
import { SECOND_BRAIN_GENERATION_BINDING_KEY, secondBrainGenerationBinding } from "./second-brain-generation-read.js";
import { boundSecondBrainEvidence, type BoundRecordProjection } from "./second-brain-read-values.js";

const PAGE_KEYS = ["body", "frontmatter"] as const;
const BOUND_PAGE_KEYS = ["body", "frontmatter", "records", SECOND_BRAIN_GENERATION_BINDING_KEY] as const;
const RECORD_KEYS = ["schema_version", "record_id", "record_digest", "sid", "record_text",
  "record_text_digest", "citation_span_start", "citation_span_end", "source_identity_full",
  "content_identity_full", "citation_identity_full", "sensitivity", "source_owner_class",
  "source_owner_id_digest", "origin_label", "valid_from", "valid_until"] as const;
const FRONTMATTER_KEYS = ["compiled_by", "id", "sensitivity", "sources", "status", "title", "updated"] as const;
const PROHIBITED_FIELDS = ["secret", "raw_body", "raw_screen", "audio", "video"] as const;
const SID_PATTERN = /^[0-9a-f]{8,64}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

type ParsedPage =
  | { readonly kind: "current" | "stale"; readonly evidence: readonly SecondBrainEvidence[] }
  | { readonly kind: "conflicts"; readonly conflicts: readonly SecondBrainConflict[] }
  | { readonly kind: "invalid"; readonly code: string };
type PageParseInput = {
  readonly value: Readonly<Record<string, unknown>>;
  readonly requestedPageId: string;
  readonly checkedAt: Date;
  readonly budgets: SecondBrainAdapterBudgets;
  readonly maxAgeMs: number;
  readonly expiryMs: number;
  readonly requestBudget: SecondBrainReadBudget;
};

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}
function timestamp(date: Date): string { return date.toISOString(); }
function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function sensitivity(value: unknown): SecondBrainSensitivity | undefined {
  if (value === undefined) return "personal";
  return SECOND_BRAIN_SENSITIVITIES.find(candidate => candidate === value);
}
function invalid(code: string): ParsedPage { return { kind: "invalid", code }; }

export function parseSecondBrainPage(input: PageParseInput): ParsedPage {
  const budgetCode = input.requestBudget.consumeProvider(input.value, true);
  if (budgetCode !== undefined) return invalid(budgetCode);
  const bound = Object.hasOwn(input.value, "records");
  if (!exactKeys(input.value, bound ? BOUND_PAGE_KEYS : PAGE_KEYS)) return invalid("SECOND_BRAIN_PAGE_MALFORMED");
  const frontmatter = record(input.value["frontmatter"]);
  const body = input.value["body"];
  if (frontmatter === undefined || typeof body !== "string") return invalid("SECOND_BRAIN_PAGE_MALFORMED");
  if (PROHIBITED_FIELDS.some(field => field in frontmatter)) return invalid("SECOND_BRAIN_PROHIBITED_FIELD");
  const frontmatterKeys = Object.hasOwn(frontmatter, "sensitivity")
    ? FRONTMATTER_KEYS : FRONTMATTER_KEYS.filter(key => key !== "sensitivity");
  if (!exactKeys(frontmatter, frontmatterKeys)) return invalid("SECOND_BRAIN_PAGE_MALFORMED");
  const pageId = frontmatter["id"];
  const version = frontmatter["compiled_by"];
  const updated = frontmatter["updated"];
  const status = frontmatter["status"];
  const sources = frontmatter["sources"];
  const tier = sensitivity(frontmatter["sensitivity"]);
  if (typeof pageId !== "string" || pageId !== input.requestedPageId) return invalid("SECOND_BRAIN_SOURCE_ID_MISSING");
  if (typeof version !== "string" || version.length === 0 || secondBrainUtf8Bytes(version) > 128) {
    return invalid("SECOND_BRAIN_SOURCE_VERSION_MISSING");
  }
  if (typeof updated !== "string" || !/^\d{4}-\d\d-\d\d$/.test(updated)) return invalid("SECOND_BRAIN_TIME_INVALID");
  if ((status !== "active" && status !== "conflict") || sources !== ""
    || typeof frontmatter["title"] !== "string" || frontmatter["title"].length === 0
    || secondBrainUtf8Bytes(frontmatter["title"]) > 256) {
    return invalid(status === "active" || status === "conflict" ? "SECOND_BRAIN_PAGE_MALFORMED" : "SECOND_BRAIN_STATUS_INVALID");
  }
  if (tier === undefined) return invalid("SECOND_BRAIN_SENSITIVITY_INVALID");
  const validAt = new Date(`${updated}T00:00:00.000Z`);
  const checkedMs = input.checkedAt.getTime();
  if (!Number.isFinite(validAt.getTime()) || validAt.toISOString().slice(0, 10) !== updated
    || validAt.getTime() > checkedMs) return invalid("SECOND_BRAIN_TIME_INVALID");
  if (bound) return parseBoundRecords(input, frontmatter, tier);
  if (checkedMs >= validAt.getTime() + input.expiryMs) return invalid("SECOND_BRAIN_EVIDENCE_EXPIRED");
  return parseCitations(input, body, {
    pageId,
    version,
    status,
    tier,
    validAt,
  });
}

function parseBoundRecords(
  input: PageParseInput,
  frontmatter: Readonly<Record<string, unknown>>,
  pageSensitivity: SecondBrainSensitivity,
): ParsedPage {
  const generation = secondBrainGenerationBinding(input.value);
  const values = input.value["records"];
  const version = frontmatter["compiled_by"];
  if (generation === undefined || !Array.isArray(values) || values.length > 64
    || typeof version !== "string") return invalid("SECOND_BRAIN_RECORDS_MALFORMED");
  const evidence: SecondBrainEvidence[] = [];
  for (const value of values) {
    const row = record(value);
    if (row === undefined || !exactKeys(row, RECORD_KEYS) || row["schema_version"] !== 1) {
      return invalid("SECOND_BRAIN_RECORDS_MALFORMED");
    }
    const recordId = row["record_id"]; const recordDigest = row["record_digest"];
    const sid = row["sid"]; const text = row["record_text"]; const textDigest = row["record_text_digest"];
    const source = row["source_identity_full"]; const content = row["content_identity_full"];
    const citation = row["citation_identity_full"]; const owner = row["source_owner_class"];
    const ownerDigest = row["source_owner_id_digest"]; const origin = row["origin_label"];
    const validFrom = row["valid_from"]; const validUntil = row["valid_until"];
    const start = row["citation_span_start"]; const end = row["citation_span_end"];
    const tier = sensitivity(row["sensitivity"]);
    if (typeof recordId !== "string" || typeof recordDigest !== "string" || typeof sid !== "string"
      || typeof text !== "string" || typeof textDigest !== "string" || typeof source !== "string"
      || typeof content !== "string" || typeof citation !== "string" || typeof ownerDigest !== "string"
      || typeof origin !== "string" || typeof validFrom !== "string" || typeof validUntil !== "string"
      || typeof start !== "number" || typeof end !== "number" || tier === undefined
      || tier !== pageSensitivity || !/^sbrecord:v1:[0-9a-f]{64}$/.test(recordId)
      || !DIGEST_PATTERN.test(recordDigest) || !DIGEST_PATTERN.test(textDigest)
      || !/^[0-9a-f]{64}$/.test(source) || !/^[0-9a-f]{64}$/.test(content)
      || !/^[0-9a-f]{64}$/.test(citation) || !DIGEST_PATTERN.test(ownerDigest)
      || (owner !== "provider_owned" && owner !== "external_read_only")
      || !SID_PATTERN.test(sid) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || secondBrainUtf8Bytes(text) > input.budgets.max_excerpt_bytes
      || secondBrainUtf8Bytes(origin) > 512 || /(?:^|[/\\])(?:home|Users|Volumes)(?:[/\\]|$)/.test(origin)) {
      return invalid("SECOND_BRAIN_RECORDS_MALFORMED");
    }
    const core = Object.fromEntries(Object.entries(row)
      .filter(([key]) => key !== "record_id" && key !== "record_digest"));
    const expected = `sha256:${createHash("sha256").update("second-brain/memory-record/v1\0")
      .update(canonicalize(core)).digest("hex")}`;
    const from = Date.parse(validFrom); const until = Date.parse(validUntil);
    if (recordDigest !== expected || recordId !== `sbrecord:v1:${expected.slice(7)}`
      || textDigest !== digest(text) || content !== textDigest.slice(7)
      || !Number.isFinite(from) || !Number.isFinite(until) || from >= until
      || validFrom.length !== 24 || validUntil.length !== 24
      || validFrom.startsWith("0000-") || validUntil.startsWith("0000-")
      || new Date(from).toISOString() !== validFrom || new Date(until).toISOString() !== validUntil) {
      return invalid("SECOND_BRAIN_RECORD_IDENTITY_INVALID");
    }
    const projection: BoundRecordProjection = { recordId, recordDigest, sid, text, textDigest,
      source, content, citation, owner, ownerDigest, origin, validFrom, validUntil, tier, version };
    evidence.push(boundSecondBrainEvidence({ pageId: input.requestedPageId,
      checkedAt: input.checkedAt, maxAgeMs: input.maxAgeMs, expiryMs: input.expiryMs,
      generation, row: projection }));
  }
  return resolveDuplicates(evidence);
}

type CitationContext = {
  readonly pageId: string;
  readonly version: string;
  readonly status: "active" | "conflict";
  readonly tier: SecondBrainSensitivity;
  readonly validAt: Date;
};

function parseCitations(input: PageParseInput, body: string, context: CitationContext): ParsedPage {
  const definitions = new Map<string, string>();
  for (const line of body.split("\n")) {
    const match = /^\[\^([0-9a-f]{8,64})\]:\s*(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) definitions.set(match[1], match[2]);
  }
  const evidence: SecondBrainEvidence[] = [];
  for (const rawLine of body.split("\n")) {
    const excerpt = rawLine.trim();
    if (excerpt.length === 0 || excerpt.startsWith("[^")) continue;
    const matches = [...excerpt.matchAll(/\[\^([0-9a-f]{8,64})\]/g)];
    for (const match of matches) {
      const sid = match[1];
      if (sid === undefined || !SID_PATTERN.test(sid)) return invalid("SECOND_BRAIN_CITATION_MISSING");
      const rawRef = definitions.get(sid);
      if (rawRef === undefined || rawRef.length === 0) return invalid("SECOND_BRAIN_SOURCE_REF_MISSING");
      const [sourceRef = "", suppliedDigest] = rawRef.split(" digest=");
      if (sourceRef.length === 0 || secondBrainUtf8Bytes(sourceRef) > 512
        || sourceRef.startsWith("/") || sourceRef.includes("\0")) {
        return invalid("SECOND_BRAIN_SOURCE_REF_MISSING");
      }
      const contentDigest = digest(excerpt);
      if (suppliedDigest !== undefined && (!DIGEST_PATTERN.test(suppliedDigest) || suppliedDigest !== contentDigest)) {
        return invalid("SECOND_BRAIN_DIGEST_MISMATCH");
      }
      const bytes = secondBrainUtf8Bytes(excerpt);
      if (bytes > input.budgets.max_excerpt_bytes) return invalid("SECOND_BRAIN_EXCERPT_OVERSIZE");
      evidence.push(buildEvidence(input, context, sid, sourceRef, excerpt, contentDigest));
    }
  }
  if (evidence.length === 0 && context.status !== "conflict") return invalid("SECOND_BRAIN_CITATION_MISSING");
  return resolveDuplicates(evidence);
}

function buildEvidence(
  input: PageParseInput,
  context: CitationContext,
  sid: string,
  sourceRef: string,
  excerpt: string,
  contentDigest: string,
): SecondBrainEvidence {
  const freshUntil = new Date(context.validAt.getTime() + input.maxAgeMs);
  const expiresAt = new Date(context.validAt.getTime() + input.expiryMs);
  const stale = input.checkedAt.getTime() >= freshUntil.getTime();
  const redacted = context.tier === "sensitive" || context.tier === "restricted";
  return {
    kind: "memory",
    page_id: context.pageId,
    sid,
    source_ref: sourceRef,
    source_id: SECOND_BRAIN_SOURCE_ID,
    source_version: context.version,
    sensitivity: context.tier,
    observed_at: timestamp(input.checkedAt),
    valid_at: timestamp(context.validAt),
    freshness: { state: stale ? "stale" : "fresh", checked_at: timestamp(input.checkedAt), fresh_until: timestamp(freshUntil) },
    expires_at: timestamp(expiresAt),
    trust: SECOND_BRAIN_TRUST,
    authority: "none",
    excerpt: redacted ? null : excerpt,
    content_digest: contentDigest,
    omission: redacted ? "policy_redacted" : null,
    record: null,
  };
}

function resolveDuplicates(rows: readonly SecondBrainEvidence[]): ParsedPage {
  const unique = new Map<string, SecondBrainEvidence>();
  for (const row of rows) {
    const key = row.record === null ? `legacy:${row.page_id}\0${row.sid}`
      : `record:${row.record.record_id}\0${row.record.record_digest}`;
    const prior = unique.get(key);
    if (prior !== undefined && prior.content_digest !== row.content_digest) {
      return {
        kind: "conflicts",
        conflicts: [{ conflict_id: `duplicate:${row.page_id}:${row.sid}`, page_id: row.page_id, state: "unresolved", left: prior, right: row }],
      };
    }
    unique.set(key, row);
  }
  const sorted = [...unique.values()].sort((left, right) => left.page_id.localeCompare(right.page_id)
    || left.sid.localeCompare(right.sid) || left.content_digest.localeCompare(right.content_digest));
  const stale = sorted.some(row => row.freshness.state === "stale");
  return { kind: stale ? "stale" : "current", evidence: sorted };
}
