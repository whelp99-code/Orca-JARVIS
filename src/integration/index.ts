export { isCore5IntegrationEnabled } from "./flag.js";
export { Core5CapabilityRegistry } from "./capability-registry.js";
export {
  StaticVerifiedIssuer,
  rejectSelfAssertedPermission,
  verifyCallerRequest,
  type CallerAssertion,
  type VerifiedIssuer,
} from "./caller-context.js";
export {
  Core5OperationLedger,
  approvalDigest,
  envelopeApprovalDigest,
} from "./operation-ledger.js";
export { applyCancellation, decideCancellation, type CancelDecision, type ExternalEffectWindow } from "./cancellation.js";
export { SyntheticReadOnlyExecutor } from "./synthetic-read-executor.js";
export {
  loadIntegrationFixture,
  loadIntegrationSchema,
  parseApprovalRef,
  parseCommandEnvelope,
  parseEvidenceRef,
  parseExecutionResult,
  parseVerifiedCaller,
} from "./schema.js";
export {
  CORE5_INTEGRATION_AUDIENCE,
  CORE5_INTEGRATION_CAPABILITIES,
  EXECUTION_STATUSES,
  type ApprovalRef,
  type CommandEnvelope,
  type Core5IntegrationCapability,
  type EvidenceRef,
  type ExecutionResult,
  type ExecutionStatus,
  type VerifiedCallerContext,
} from "./types.js";
