import type Database from "better-sqlite3";
import { ControlPlane, type CommandApprovalReceipt } from "./control-plane.js";
import { JarvisError } from "./authority-db-base.js";
import { TerminalMemoryError, identifier, terminalDigest, timestamp } from "./terminal-memory-validation.js";
import type { SqlSource } from "./terminal-work-memory.js";
import type { AuthorityDb } from "./authority-db.js";
export type RemoteChallenge = Readonly<{
	challenge_id: string;
	principal_id: string;
	credential_id: string;
	session_id: string;
	command_digest: string;
	target_digest: string;
	args_digest: string;
	nonce: string;
	rp_id: string;
	origin: string;
	expires_at: string;
}>;
export type RemoteAssertion = Readonly<{
	challenge_id: string;
	principal_id: string;
	credential_id: string;
	session_id: string;
	command_digest: string;
	target_digest: string;
	args_digest: string;
	nonce: string;
	rp_id: string;
	origin: string;
	assertion_digest: string;
	sign_count: number;
	user_verified: true;
	asserted_at: string;
}>;
export type AssertionVerifier = (assertion: RemoteAssertion, publicKeyMetadata: string) => boolean;

const dbOf = (source: SqlSource): Database.Database => ("db" in source ? source.db : source);
const row = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

export class RemoteApprovalService {
	private readonly db: Database.Database;
	private readonly control: ControlPlane;
	constructor(source: SqlSource) {
		this.db = dbOf(source);
		this.control = new ControlPlane({ db: this.db } as AuthorityDb);
	}

	issueChallenge(
		input: Readonly<{
			challenge_id: string;
			command_request_id: string;
			principal_id: string;
			credential_id: string;
			session_id: string;
			command_digest: string;
			target_digest: string;
			args_digest: string;
			nonce: string;
			rp_id: string;
			origin: string;
			issued_at: string;
			expires_at: string;
		}>,
	): RemoteChallenge {
		const issued = timestamp(input.issued_at);
		const expires = timestamp(input.expires_at);
		if (Date.parse(expires) <= Date.parse(issued) || Date.parse(expires) - Date.parse(issued) > 15 * 60_000)
			throw new TerminalMemoryError("REMOTE_CHALLENGE_EXPIRY_INVALID");
		const principal = row(this.db.prepare("SELECT state FROM remote_principals WHERE principal_id=?").get(identifier(input.principal_id)));
		const credential = row(
			this.db
				.prepare("SELECT state,principal_id,public_key_cose,rp_id,origin FROM webauthn_credentials WHERE credential_id=?")
				.get(identifier(input.credential_id)),
		);
		const request = row(
			this.db
				.prepare("SELECT state,command_digest,expires_at FROM control_command_requests WHERE request_id=?")
				.get(identifier(input.command_request_id)),
		);
		if (
			principal?.state !== "active" ||
			credential?.state !== "active" ||
			credential.principal_id !== input.principal_id ||
			credential.rp_id !== input.rp_id ||
			credential.origin !== input.origin ||
			request?.state !== "approved" ||
			request.command_digest !== input.command_digest ||
			Date.parse(String(request.expires_at)) < Date.parse(expires)
		)
			throw new TerminalMemoryError("REMOTE_CHALLENGE_BINDING_INVALID");
		const challengeDigest = terminalDigest({
			challenge_id: input.challenge_id,
			command_request_id: input.command_request_id,
			principal_id: input.principal_id,
			credential_id: input.credential_id,
			session_id: input.session_id,
			command_digest: input.command_digest,
			target_digest: input.target_digest,
			args_digest: input.args_digest,
			nonce: input.nonce,
			rp_id: input.rp_id,
			origin: input.origin,
		});
		this.db
			.prepare(`INSERT INTO webauthn_challenges
      (challenge_id,command_request_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,
       challenge_digest,nonce_digest,rp_id,origin,state,issued_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'issued',?,?)`)
			.run(
				identifier(input.challenge_id),
				identifier(input.command_request_id),
				input.principal_id,
				input.credential_id,
				identifier(input.session_id),
				input.command_digest,
				input.target_digest,
				input.args_digest,
				challengeDigest,
				terminalDigest(input.nonce),
				input.rp_id,
				input.origin,
				issued,
				expires,
			);
		return {
			challenge_id: input.challenge_id,
			principal_id: input.principal_id,
			credential_id: input.credential_id,
			session_id: input.session_id,
			command_digest: input.command_digest,
			target_digest: input.target_digest,
			args_digest: input.args_digest,
			nonce: input.nonce,
			rp_id: input.rp_id,
			origin: input.origin,
			expires_at: expires,
		};
	}

	verifyAndTranslate(
		assertion: RemoteAssertion,
		receipt: CommandApprovalReceipt,
		verify: AssertionVerifier,
	): Readonly<{
		decision: "approved" | "rejected";
		receipt_id: string;
		assertion_digest: string;
	}> {
		const at = timestamp(assertion.asserted_at);
		const challenge = row(
			this.db.prepare("SELECT * FROM webauthn_challenges WHERE challenge_id=?").get(identifier(assertion.challenge_id)),
		);
		const credential = row(
			this.db.prepare("SELECT * FROM webauthn_credentials WHERE credential_id=?").get(identifier(assertion.credential_id)),
		);
		if (
			challenge === undefined ||
			credential === undefined ||
			challenge.state !== "issued" ||
			credential.state !== "active" ||
			challenge.principal_id !== assertion.principal_id ||
			challenge.credential_id !== assertion.credential_id ||
			challenge.session_id !== assertion.session_id ||
			challenge.command_digest !== assertion.command_digest ||
			challenge.target_digest !== assertion.target_digest ||
			challenge.args_digest !== assertion.args_digest ||
			challenge.rp_id !== assertion.rp_id ||
			challenge.origin !== assertion.origin ||
			String(challenge.nonce_digest) !== terminalDigest(assertion.nonce) ||
			Date.parse(String(challenge.expires_at)) <= Date.parse(at) ||
			assertion.user_verified !== true ||
			!Number.isSafeInteger(assertion.sign_count) ||
			assertion.sign_count <= Number(credential.sign_count) ||
			!verify(assertion, String(credential.public_key_cose))
		)
			throw new TerminalMemoryError("REMOTE_ASSERTION_INVALID");
		if (
			receipt.request_id !== challenge.command_request_id ||
			receipt.command_digest !== assertion.command_digest ||
			receipt.signer_principal_id !== "local-owner"
		)
			throw new TerminalMemoryError("REMOTE_RECEIPT_BINDING_INVALID");
		this.db
			.prepare(`INSERT INTO webauthn_assertions
      (assertion_id,challenge_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,
       nonce_digest,rp_id,origin,assertion_digest,sign_count,user_verified,asserted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
			.run(
				`assertion:${assertion.assertion_digest}`,
				assertion.challenge_id,
				assertion.principal_id,
				assertion.credential_id,
				assertion.session_id,
				assertion.command_digest,
				assertion.target_digest,
				assertion.args_digest,
				terminalDigest(assertion.nonce),
				assertion.rp_id,
				assertion.origin,
				assertion.assertion_digest,
				assertion.sign_count,
				1,
				at,
			);
		try {
			this.control.decide(receipt, new Date(at));
		} catch (error) {
			if (error instanceof JarvisError) throw error;
			throw new TerminalMemoryError("REMOTE_TRANSLATION_FAILED");
		}
		return {
			decision: receipt.decision === "approve" ? "approved" : "rejected",
			receipt_id: receipt.receipt_id,
			assertion_digest: assertion.assertion_digest,
		};
	}
}
