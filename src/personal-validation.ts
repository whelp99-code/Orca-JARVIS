import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { PERSONAL_CONTRACT_CANONICALIZATION_INVALID, type PersonalContractV1, type Sha256Digest } from "./personal-contracts.js";
import { PersonalContractError, digest, isParsedContract } from "./personal-validation-primitives.js";

export { PersonalContractError } from "./personal-validation-primitives.js";
export {
  parseObservationEnvelopeV1,
  parseContextSnapshotV1,
  parseRecommendationV1,
} from "./personal-validation-contracts-core.js";
export { parseDailyLoopRunV1, parseNotificationIntentV1 } from "./personal-validation-contracts-daily.js";
export { parseMemoryCandidateV1, parseMemoryOutboxV1 } from "./personal-validation-contracts-memory.js";
export { parseRemotePrincipalV1, parseRemoteChallengeV1, parseRemoteApprovalReceiptV1 } from "./personal-validation-contracts-remote.js";

export function canonicalPersonalContractJson(value: PersonalContractV1): string {
  if (!isParsedContract(value)) throw new PersonalContractError(PERSONAL_CONTRACT_CANONICALIZATION_INVALID);
  return canonicalize(value);
}
export function canonicalPersonalContractHash(value: PersonalContractV1): Sha256Digest {
  const result = `sha256:${createHash("sha256").update(canonicalPersonalContractJson(value)).digest("hex")}`;
  return digest(result);
}
