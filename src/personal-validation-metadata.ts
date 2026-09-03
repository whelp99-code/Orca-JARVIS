import {
  AUTHORITY_KINDS,
  FRESHNESS_STATES,
  HOST_IDS,
  POLICY_DECISIONS,
  POLICY_REASON_CODES,
  SOURCE_KINDS,
  SOURCE_PROVIDERS,
  type Evidence,
  type Freshness,
  type PolicyDecision,
  type SourceMetadata,
} from "./personal-contracts.js";
import {
  invalid,
  record,
  closed,
  literal,
  text,
  digest,
  timestamp,
  sourceId,
  evidenceId,
  list,
  type ParsedBase,
} from "./personal-validation-primitives.js";

export function parseSource(value: unknown): SourceMetadata {
  const input = record(value);
  closed(input, ["source_id", "source_kind", "host_id", "source_version", "evidence_ref"]);
  const id = sourceId(input.source_id);
  const kind = literal(input.source_kind, SOURCE_KINDS);
  const host = literal(input.host_id, HOST_IDS);
  const provider = literal(id.split(":")[3], SOURCE_PROVIDERS);
  let expectedKind: (typeof SOURCE_KINDS)[number];
  switch (provider) {
    case "jarvis":
      expectedKind = "authority";
      break;
    case "orca":
    case "portfolio":
    case "calendar":
    case "mail":
    case "messenger":
      expectedKind = "live_adapter";
      break;
    case "task-timeline":
      expectedKind = "timeline";
      break;
    case "second-brain":
      expectedKind = "second_brain";
      break;
    case "gateway":
      expectedKind = "gateway";
      break;
    case "mac-client":
    case "phone-client":
      expectedKind = "client";
      break;
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
  const client = provider === "mac-client" || provider === "phone-client";
  if (
    kind !== expectedKind ||
    (client && host !== `host:pos:${provider}`) ||
    (!client && (host === "host:pos:mac-client" || host === "host:pos:phone-client"))
  )
    invalid();
  if (
    (provider === "second-brain" && host !== "host:pos:linux-second-brain") ||
    (provider !== "second-brain" && !client && host !== "host:pos:linux-control-plane")
  )
    invalid();
  return {
    source_id: id,
    source_kind: kind,
    host_id: host,
    source_version: text(input.source_version, 128),
    evidence_ref: text(input.evidence_ref, 512),
  };
}
export function parseAuthority(value: unknown): ParsedBase<unknown>["authority"] {
  const input = record(value);
  closed(input, ["authority_kind", "principal_id", "request_id", "receipt_id"]);
  const kind = literal(input.authority_kind, AUTHORITY_KINDS);
  switch (kind) {
    case "none":
      if (input.principal_id !== null || input.request_id !== null || input.receipt_id !== null) invalid();
      return { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null };
    case "control_receipt":
      return {
        authority_kind: kind,
        principal_id: text(input.principal_id, 128),
        request_id: text(input.request_id, 128),
        receipt_id: text(input.receipt_id, 128),
      };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
export function parseFreshness(value: unknown): Freshness {
  const input = record(value);
  closed(input, ["state", "checked_at", "fresh_until"]);
  return { state: literal(input.state, FRESHNESS_STATES), checked_at: timestamp(input.checked_at), fresh_until: timestamp(input.fresh_until) };
}
export function parsePolicy(value: unknown): PolicyDecision {
  const input = record(value);
  closed(input, ["decision", "policy_version", "reason_codes"]);
  return {
    decision: literal(input.decision, POLICY_DECISIONS),
    policy_version: text(input.policy_version, 128),
    reason_codes: list(input.reason_codes, (item) => literal(item, POLICY_REASON_CODES)),
  };
}
export function parseEvidence(value: unknown): Evidence {
  const input = record(value);
  closed(input, ["evidence_id", "digest", "kind", "source_id", "observed_at"]);
  return {
    evidence_id: evidenceId(input.evidence_id),
    digest: digest(input.digest),
    kind: text(input.kind, 128),
    source_id: sourceId(input.source_id),
    observed_at: timestamp(input.observed_at),
  };
}
