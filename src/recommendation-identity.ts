import { deflateRawSync, inflateRawSync } from "node:zlib";
import { canonicalize } from "./canonical.js";
import type { Sha256Digest } from "./personal-contracts.js";
import { persistenceHash, persistenceText } from "./personal-persistence-values.js";

const PREFIX = "task18:v1:";

export function encodeRecommendationProvenance(value: unknown): string {
  return `${PREFIX}${deflateRawSync(Buffer.from(canonicalize(value), "utf8"), { level: 9 }).toString("base64url")}`;
}

export type RecommendationIdentity = {
  readonly identity_digest: Sha256Digest;
  readonly provenance_digest: Sha256Digest;
  readonly provenance: unknown;
};

export function storedRecommendationIdentity(
  canonicalDigest: unknown,
  contextEvidenceDigest: unknown,
  envelopeJson: unknown,
): RecommendationIdentity {
  const envelope: unknown = JSON.parse(persistenceText(envelopeJson));
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new TypeError("stored recommendation envelope required");
  }
  const payload = Reflect.get(envelope, "payload");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("stored recommendation payload required");
  }
  const basis = Reflect.get(payload, "confidence_basis");
  if (typeof basis !== "string") throw new TypeError("stored recommendation provenance required");
  if (!basis.startsWith(PREFIX)) throw new TypeError("stored recommendation provenance version required");
  const provenance: unknown = JSON.parse(inflateRawSync(Buffer.from(basis.slice(PREFIX.length), "base64url")).toString("utf8"));
  const provenanceDigest = persistenceHash(provenance);
  return {
    provenance,
    provenance_digest: provenanceDigest,
    identity_digest: persistenceHash({
      canonical_digest: persistenceText(canonicalDigest),
      context_evidence_digest: persistenceText(contextEvidenceDigest),
      provenance_digest: provenanceDigest,
    }),
  };
}
