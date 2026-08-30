import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { PersonalOsRecord } from "./personal-os-eval-types.js";

export function computePersonalOsRecordDigest(record: PersonalOsRecord): string {
  const material = {
    authority: record.authority,
    evidence_link: record.evidence_link,
    fresh_until: record.fresh_until,
    id: record.id,
    kind: record.kind,
    observed_at: record.observed_at,
    relationship: record.relationship,
    session_id: record.session_id,
    support_for: record.support_for,
    state: record.state,
    subject: record.subject,
    trust: record.trust,
    valid_from: record.valid_from,
    valid_until: record.valid_until,
    value: record.value,
  };
  return `sha256:${createHash("sha256").update(canonicalize(material), "utf8").digest("hex")}`;
}
