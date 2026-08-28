import { createHash } from "node:crypto";
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

const PAGE_KEYS = ["body", "frontmatter"] as const;
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
  return Object.keys(value).every(key => allowed.includes(key));
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
  if (!exactKeys(input.value, PAGE_KEYS)) return invalid("SECOND_BRAIN_PAGE_MALFORMED");
  const frontmatter = record(input.value["frontmatter"]);
  const body = input.value["body"];
  if (frontmatter === undefined || typeof body !== "string") return invalid("SECOND_BRAIN_PAGE_MALFORMED");
  if (PROHIBITED_FIELDS.some(field => field in frontmatter)) return invalid("SECOND_BRAIN_PROHIBITED_FIELD");
  if (!exactKeys(frontmatter, FRONTMATTER_KEYS)) return invalid("SECOND_BRAIN_PAGE_MALFORMED");
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
  if (checkedMs >= validAt.getTime() + input.expiryMs) return invalid("SECOND_BRAIN_EVIDENCE_EXPIRED");
  return parseCitations(input, body, {
    pageId,
    version,
    status,
    tier,
    validAt,
  });
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
  };
}

function resolveDuplicates(rows: readonly SecondBrainEvidence[]): ParsedPage {
  const unique = new Map<string, SecondBrainEvidence>();
  for (const row of rows) {
    const key = `${row.page_id}\0${row.sid}`;
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
