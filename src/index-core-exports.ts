export { AuthorityDb, JarvisError } from "./db.js";
export {
	OrcaReadonlyAdapter,
	classifyOrcaTerminal,
	defaultRunner,
	discoverOrcaBindings,
	observeOrca,
	parseOrcaBindings,
	type DiscoveredOrcaBinding,
	type DiscoverOrcaOptions,
	type OrcaObserveOptions,
	type OrcaRunner,
} from "./orca.js";
export {
	createOrcaRunner,
	decodeEnvWorktree,
	encodeEnvWorktree,
	LOCAL_ORCA_ENVIRONMENT,
	ORCA_ENV_PATH_PREFIX,
	parseOrcaEnvironments,
	withOrcaEnvironment,
} from "./orca-env.js";
export { canonicalize } from "./canonical.js";
export * from "./priority-engine.js";
export {
	Recommendations,
	RecommendationError,
	RECOMMENDATION_ERROR_CODES,
	type CreateRecommendationResult,
	type RecommendationActionMaterial,
	type RecommendationErrorCode,
	type RecommendationReadProjection,
	type ProjectedRecommendationAction,
	type RecommendationWarning,
} from "./recommendations.js";
export {
	assemblePersonalContext,
	CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE,
	CONTEXT_ASSEMBLER_INPUT_INVALID,
	ContextAssemblerError,
	type ContextAssemblerErrorCode,
	type ContextAssemblerInput,
	type ContextBudget,
	type MemoryEvidenceInput,
	type MemoryGapInput,
	type MemoryInput,
} from "./context-assembler.js";
export {
	CONTEXT_POLICY_CONFIG_INVALID,
	CONTEXT_POLICY_INPUT_INVALID,
	CONTEXT_POLICY_REASON_CODES,
	ContextPolicyError,
	evaluateContextPolicy,
	type ContextPolicyDecision,
	type ContextPolicyErrorCode,
	type ContextPolicyReasonCode,
} from "./context-policy.js";
export {
	createPersonalConnectorRegistry,
	PERSONAL_CONNECTOR_IDS,
	PERSONAL_CONNECTOR_REGISTRY_SESSION,
	PersonalConnectorConfigError,
	PersonalConnectorError,
	type PersonalConnectorDefinition,
	type PersonalConnectorFreshness,
	type PersonalConnectorId,
	type PersonalConnectorReadRequest,
	type PersonalConnectorReason,
	type PersonalConnectorRegistry,
	type PersonalConnectorResult,
	type PersonalConnectorState,
	type PersonalConnectorValue,
	type PersonalRegistrySessionContract,
	type PersonalSourceSnapshot,
	type SecondBrainConnectorRead,
} from "./personal-connectors.js";
export * from "./personal-contracts.js";
export {
	normalizeAndPersistPersonalObservations,
	normalizePersonalObservations,
	PERSONAL_OBSERVATION_ERROR_CODES,
	PersonalObservationNormalizationError,
	type OrcaTaskObservationInput,
	type PersonalObservationEnvironment,
	type PersonalObservationErrorCode,
	type PersonalObservationNormalizationInput,
	type PersonalObservationPersistence,
	type PersonalObservationPersistenceInput,
	type SignedPortfolioObservationInput,
} from "./personal-observations.js";
export {
	PersonalContractError,
	canonicalPersonalContractHash,
	canonicalPersonalContractJson,
	parseContextSnapshotV1,
	parseDailyLoopRunV1,
	parseMemoryCandidateV1,
	parseMemoryOutboxV1,
	parseNotificationIntentV1,
	parseObservationEnvelopeV1,
	parseRecommendationV1,
	parseRemoteApprovalReceiptV1,
	parseRemoteChallengeV1,
	parseRemotePrincipalV1,
} from "./personal-validation.js";
export type {
	ContextMemoryEvidenceBinding,
	ContextPersistenceInput,
	ReconstructedRecommendation,
	RecommendationActionTransition,
	RecommendationPersistenceInput,
	StoredContext,
	StoredObservation,
	StoredRecommendation,
} from "./personal-context-persistence.js";
export { parseProgressBatch, serializeProgressReport } from "./progress.js";
export {
	classifyProgressEvidence,
	parseProgressSignal,
	progressSignalPayload,
	verifyProgressSignal,
} from "./progress-signal.js";
export {
	ingestCodexAppServerEvent,
	ingestClaudeHookEvent,
} from "./adapters.js";
export {
	evaluatePreGjcFixture,
	runPreGjcFixture,
	preGjcEvidenceId,
	REQUIRED_PRE_GJC_EVIDENCE,
} from "./pre-gjc.js";
export {
	PreGjcShadow,
	type OrcaResumeAdapter,
	type ShadowKey,
	type AuthorityReceipt,
} from "./pre-gjc-shadow.js";
export {
	OrcaTerminalResumeAdapter,
	type OrcaCommand,
	type LiveResumeIntent,
} from "./orca-resume.js";
export {
	LiveSupervisor,
	type LiveBinding,
	type LiveObservation,
	type LiveObservationReader,
	type LiveSupervisorCycle,
} from "./live-supervisor.js";
export {
	GjcCoordinatorClient,
	spawnGjc,
	GJC_ENV,
	GJC_PROTOCOL_VERSION,
	type GjcCall,
	type GjcRun,
	type GjcRunResult,
	type GjcRunner,
} from "./gjc.js";
export { GjcRuntimeService } from "./service.js";
export {
	createSecondBrainReadAdapter,
	SECOND_BRAIN_SENSITIVITIES,
	SECOND_BRAIN_SOURCE_ID,
	SECOND_BRAIN_TRUST,
	type SecondBrainAdapterBudgets,
	type SecondBrainAdapterOptions,
	type SecondBrainConflict,
	type SecondBrainEvidence,
	type SecondBrainReadAdapter,
	type SecondBrainReadOutcome,
	type SecondBrainSensitivity,
} from "./second-brain-adapter.js";
export {
	createSecondBrainTransport,
	SecondBrainTransportError,
	SECOND_BRAIN_PROTOCOL_VERSION,
	type SecondBrainCallOptions,
	type SecondBrainDiagnostic,
	type SecondBrainDisposition,
	type SecondBrainMethod,
	type SecondBrainOutcome,
	type SecondBrainReadMethod,
	type SecondBrainTransport,
} from "./second-brain-transport.js";
export {
	verifyDecisionReceipt,
	verifyPolicyAuthorization,
	verifyVerificationEvidence,
	receiptPayload,
	policyPayload,
	verificationPayload,
	signReceipt,
	signPolicy,
	signVerificationEvidence,
	RECEIPT_DOMAIN,
	POLICY_DOMAIN,
	VERIFICATION_DOMAIN,
} from "./receipt.js";
export {
	TaskTimeline,
	type TaskTimelineContext,
	type TaskTimelineEvent,
	type TaskTimelineKind,
	type TaskTimelineSource,
	type TaskTimelineSummary,
} from "./recommendation-timeline.js";
export type {
	CensusSnapshot,
	CensusWork,
	ContinuationInput,
	DecisionReceipt,
	GuardBindings,
	PolicyAuthorization,
	VerificationEvidence,
	ProgressAssessment,
	ProgressBatch,
	ProgressState,
	ProgressTransition,
	ProgressTransitionEvidence,
	StoredProgressReport,
	ProgressSignal,
	ProgressSignalKey,
	ProgressEvidenceInput,
	ProgressClassification,
	ProgressReasonCode,
} from "./types.js";