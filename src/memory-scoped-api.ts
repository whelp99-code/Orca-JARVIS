/** Public scoped memory preparation, execution and reconciliation exports. */
export { proposeMemoryCandidateScope, validateMemoryCandidateScopeProposal, MEMORY_CANDIDATE_SCOPE_DOMAIN,
  type MemoryCandidateScopeInput, type MemoryCandidateScopeProposal } from "./memory-candidate-scope.js";
export { stageMemoryScopeReview, readApprovedMemoryScopeReview } from "./memory-scope-review.js";
export { prepareMemoryScopedWriteIdentity } from "./memory-scoped-write-identity.js";
export { prepareMemoryScopedWritePayload, prepareMemoryScopedWriteFromDispatch } from "./memory-scoped-write-payload.js";
export { publishAutomaticMemoryCandidate } from "./memory-auto-publication.js";
export { createFileMemoryWriteScopeResolver, type MemoryWriteScopeResolver, type AuthorizedMemoryWriteScope } from "./memory-access-policy.js";
export { prepareMemoryScopedWriteWithPolicy } from "./memory-scoped-write-policy.js";
export { prepareMemoryScopedWriteRequest, type MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";

export { parseMemoryScopedWriteRequestJson, snapshotMemoryScopedWriteArguments } from "./memory-scoped-write-codec.js";

export { MemoryScopedWriteSpool } from "./memory-scoped-write-spool.js";

export { publishMemoryScopedWriteRequest, type MemoryScopedPublicationOptions } from "./memory-scoped-write-publication.js";

export { registerMemoryScopedOutbox } from "./memory-scoped-outbox.js";

export { readCurrentMemoryScopedOutbox, readCurrentDispatchedMemoryScopedOutbox } from "./memory-scoped-outbox-reader.js";

export { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch, recoverMemoryScopedOutboxDispatches,
  type MemoryScopedOutboxLease } from "./memory-scoped-outbox-worker.js";

export { parseSecondBrainScopedWriteAccepted, type SecondBrainScopedWriteAccepted } from "./second-brain-scoped-write-result.js";
export { recordMemoryScopedOutboxAcceptance } from "./memory-scoped-outbox-result.js";

export { verifySecondBrainScopedProof } from "./second-brain-scoped-proof.js";

export { verifyMemoryScopedProviderWrite } from "./memory-scoped-provider-authority.js";

export { parseSecondBrainRecoveredRequestStatus, parseSecondBrainScopedRequestStatus } from "./second-brain-scoped-request-status.js";

export { claimMemoryScopedReconciliation, readMemoryScopedReconciliationRequest,
  requireMemoryScopedReconciliationLease, releaseMemoryScopedReconciliation,
  type MemoryScopedReconcileLease, type MemoryScopedReconcileOptions } from "./memory-scoped-reconciliation.js";

export { observeMemoryScopedCompletion } from "./memory-scoped-completion-observation.js";

export { readMemoryScopedCompletionProof } from "./memory-scoped-completion-proof.js";

export { readMemoryScopedSettlementAuthority } from "./memory-scoped-settlement-authority.js";

export { readMemoryScopedSettlement, settleMemoryScopedCompletion } from "./memory-scoped-settlement.js";

export { createProductionScopedProviderVerifier, type ScopedProviderProductionOptions } from "./memory-scoped-provider-production.js";

export { createPhoneMemoryProviderVerifier, type PhoneMemoryProviderVerifierOptions } from "./phone-memory-provider-verifier.js";

export { createMemoryScopedJournalClient, type MemoryScopedJournalClientOptions } from "./memory-scoped-journal-client.js";
export { recoverMemoryScopedJournalAcceptance } from "./memory-scoped-journal-recovery.js";
export { reconcileMemoryScopedOnce, type MemoryScopedReconcileOnceOptions } from "./memory-scoped-reconcile-once.js";
export { createProductionScopedReconciler, type ScopedReconcileProductionOptions } from "./memory-scoped-reconcile-production.js";
export { type PhoneMemoryReconcileOptions } from "./phone-memory-reconcile.js";
export { parsePhoneMemoryProviderCli, openPhoneMemoryProviderCli, type PhoneMemoryProviderCliOptions } from "./phone-memory-provider-cli.js";
export { readPhoneMemoryContext, PhoneMemoryClientError } from "./phone-memory-client.js";
/** Load the optional MCP server only when requested, preserving core import IO. */
export async function createPhoneMemoryClientMcp(credentialsPath: string) {
  const client = await import("./phone-memory-client-mcp.js");
  return client.createPhoneMemoryClientMcp(credentialsPath);
}
