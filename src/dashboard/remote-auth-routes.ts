import { RemoteApprovalService, type AssertionVerifier, type RemoteAssertion, type RemoteChallenge } from "../remote-approval.js";
import type { CommandApprovalReceipt } from "../control-plane.js";
import type { SqlSource } from "../terminal-work-memory.js";

export class RemoteAuthRoutes {
	private readonly service: RemoteApprovalService;
	constructor(source: SqlSource) {
		this.service = new RemoteApprovalService(source);
	}
	challenge(input: Parameters<RemoteApprovalService["issueChallenge"]>[0]): RemoteChallenge {
		return this.service.issueChallenge(input);
	}
	assertion(assertion: RemoteAssertion, receipt: CommandApprovalReceipt, verifier: AssertionVerifier): ReturnType<RemoteApprovalService["verifyAndTranslate"]> {
		return this.service.verifyAndTranslate(assertion, receipt, verifier);
	}
}
