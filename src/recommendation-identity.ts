import { deflateRawSync, inflateRawSync } from "node:zlib";
import { canonicalize } from "./canonical.js";
import type { RecommendationV1, Sha256Digest } from "./personal-contracts.js";
import { parseRecommendationV1 } from "./personal-validation.js";
import { persistenceHash, persistenceText } from "./personal-persistence-values.js";
import {
  parseRecommendationProvenance,
  RecommendationProvenanceContractError,
  type RecommendationProvenance,
} from "./recommendation-provenance.js";

const PREFIX = "task18:v1:";
export const MAX_RECOMMENDATION_PROVENANCE_ENCODED_BYTES = 32_768;
export const MAX_RECOMMENDATION_PROVENANCE_INFLATED_BYTES = 262_144;
const MAX_RECOMMENDATION_ENVELOPE_BYTES = 65_536;

export class RecommendationIdentityError extends Error {
  readonly name = "RecommendationIdentityError";
  constructor() { super("RECOMMENDATION_PROVENANCE_INVALID"); }
}
function invalid(): never { throw new RecommendationIdentityError(); }

export function encodeRecommendationProvenance(value: RecommendationProvenance): string {
  const raw = Buffer.from(canonicalize(value), "utf8");
  if (raw.byteLength > MAX_RECOMMENDATION_PROVENANCE_INFLATED_BYTES) return invalid();
  const encoded = deflateRawSync(raw, { level: 9 }).toString("base64url");
  if (Buffer.byteLength(encoded, "ascii") > MAX_RECOMMENDATION_PROVENANCE_ENCODED_BYTES) return invalid();
  return `${PREFIX}${encoded}`;
}

export type RecommendationIdentity = {
  readonly identity_digest: Sha256Digest;
  readonly provenance_digest: Sha256Digest;
  readonly provenance: RecommendationProvenance;
  readonly recommendation: RecommendationV1;
};
function decode(value: string): RecommendationProvenance {
  if (!value.startsWith(PREFIX)) return invalid();
  const encoded = value.slice(PREFIX.length);
  if (encoded.length === 0 || Buffer.byteLength(encoded, "ascii") > MAX_RECOMMENDATION_PROVENANCE_ENCODED_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid();
  try {
    const compressed = Buffer.from(encoded, "base64url");
    if (compressed.byteLength > MAX_RECOMMENDATION_PROVENANCE_ENCODED_BYTES) return invalid();
    const inflated = inflateRawSync(compressed, { maxOutputLength: MAX_RECOMMENDATION_PROVENANCE_INFLATED_BYTES });
    return parseRecommendationProvenance(JSON.parse(inflated.toString("utf8")));
  } catch (error) {
    if (error instanceof RecommendationIdentityError) throw error;
    if (error instanceof RecommendationProvenanceContractError) return invalid();
    if (error instanceof Error) return invalid();
    return invalid();
  }
}

export function storedRecommendationIdentity(
  canonicalDigest: unknown,
  contextEvidenceDigest: unknown,
  envelopeJson: unknown,
): RecommendationIdentity {
  try {
    const envelopeText = persistenceText(envelopeJson);
    if (Buffer.byteLength(envelopeText, "utf8") > MAX_RECOMMENDATION_ENVELOPE_BYTES) return invalid();
    const recommendation = parseRecommendationV1(JSON.parse(envelopeText));
    const provenance = decode(recommendation.payload.confidence_basis);
    const provenanceDigest = persistenceHash(provenance);
    return {
      recommendation,
      provenance,
      provenance_digest: provenanceDigest,
      identity_digest: persistenceHash({
        canonical_digest: persistenceText(canonicalDigest),
        context_evidence_digest: persistenceText(contextEvidenceDigest),
        provenance_digest: provenanceDigest,
      }),
    };
  } catch (error) {
    if (error instanceof RecommendationIdentityError) throw error;
    if (error instanceof Error) return invalid();
    return invalid();
  }
}
