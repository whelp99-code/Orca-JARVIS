import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { JarvisError, timestamp, type Row } from "./authority-db-base.js";
import { ProgressDeliveryAuthorityDb } from "./authority-progress-delivery-store.js";
import type { OrcaObservationDelta, OrcaObservationSource } from "./types.js";

type PublicAnchor = { readonly keyId: string; readonly principal: string; readonly publicKeyPath: string };
type VerifierAnchor = PublicAnchor & { readonly recommendationWork?: {
	readonly sessionId: string; readonly incarnationId: string; readonly notBefore: string; readonly expiresAt: string;
} };
type ProviderAnchor = { readonly keyId: string; readonly provider: "codex" | "claude";
	readonly publicKeyPath: string; readonly notBefore: string; readonly expiresAt: string };
export type AuthorityAnchors = { readonly decision?: PublicAnchor; readonly verifier?: VerifierAnchor;
	readonly recommendationWork?: { readonly dispatch: ProviderAnchor; readonly progress: ProviderAnchor } };
const bootstrapTime = (value: string): boolean => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
	&& Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export abstract class InitializationAuthorityDb extends ProgressDeliveryAuthorityDb {
	recordOrcaObservations(
		source: OrcaObservationSource,
		deltas: OrcaObservationDelta[],
	): { inserted: number; replayed: number } {
		return this.orcaObservations.record(source, deltas);
	}
	async initialize(anchors: AuthorityAnchors = {}): Promise<void> {
		await this.migrate();
		const decision = anchors.decision;
		const verifier = anchors.verifier;
		if (!decision || !verifier) throw new JarvisError("ANCHORS_REQUIRED");
		const sealed = this.db.prepare("SELECT 1 FROM authority_configuration WHERE id=1").get();
		if (sealed) {
			await this.assertExactAnchor(decision, "decision");
			await this.assertExactAnchor(verifier, "verifier");
			await this.ensureRecommendationWorkAuthority(verifier, anchors.recommendationWork);
			await this.ensurePolicyKey();
			return;
		}
		await this.registerPublicAnchor(decision, "decision");
		await this.registerPublicAnchor(verifier, "verifier");
		await this.ensureRecommendationWorkAuthority(verifier, anchors.recommendationWork);
		await this.ensurePolicyKey();
		this.atomic(() => {
			this.db.prepare("INSERT INTO authority_configuration(id,sealed_at) VALUES(1,?)").run(timestamp());
			this.audit("authority_sealed", "authority", { decision_key_id: decision.keyId, verifier_key_id: verifier.keyId });
		});
	}
	protected async assertExactAnchor(
		anchor: { keyId: string; principal: string; publicKeyPath: string },
		purpose: "decision" | "verifier",
	): Promise<void> {
		const pem = createPublicKey(await readFile(anchor.publicKeyPath, "utf8"))
			.export({ type: "spki", format: "pem" })
			.toString();
		const existing = this.db
			.prepare(
				"SELECT k.public_key_pem,k.principal_id,p.purpose FROM trusted_authority_keys k JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE k.key_id=?",
			)
			.get(anchor.keyId) as Row | undefined;
		if (
			!existing ||
			existing.public_key_pem !== pem ||
			existing.principal_id !== anchor.principal ||
			existing.purpose !== purpose
		)
			throw new JarvisError("ANCHOR_SEALED_MISMATCH");
	}
	protected async registerPublicAnchor(
		anchor: { keyId: string; principal: string; publicKeyPath: string },
		purpose: "decision" | "verifier",
	): Promise<void> {
		const pem = await readFile(anchor.publicKeyPath, "utf8");
		const publicPem = createPublicKey(pem).export({ type: "spki", format: "pem" }).toString();
		const existing = this.db
			.prepare("SELECT public_key_pem,principal_id FROM trusted_authority_keys WHERE key_id=?")
			.get(anchor.keyId) as Row | undefined;
		if (existing && (existing.public_key_pem !== publicPem || existing.principal_id !== anchor.principal))
			throw new JarvisError("KEY_REGISTRY_MISMATCH");
		if (!existing)
			this.db
				.prepare(
					"INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES(?,?,?,?,?)",
				)
				.run(anchor.keyId, anchor.principal, "Ed25519", publicPem, timestamp());
		const mapped = this.db.prepare("SELECT purpose FROM authority_key_purposes WHERE key_id=?").get(anchor.keyId) as
			| Row
			| undefined;
		if (!mapped)
			this.db
				.prepare("INSERT INTO authority_key_purposes(key_id,purpose,created_at) VALUES(?,?,?)")
				.run(anchor.keyId, purpose, timestamp());
		if (mapped && mapped.purpose !== purpose) throw new JarvisError("KEY_PURPOSE_MISMATCH");
	}
	private async ensureRecommendationWorkAuthority(
		verifier: VerifierAnchor,
		providers: AuthorityAnchors["recommendationWork"],
	): Promise<void> {
		const binding = verifier.recommendationWork ?? {
			sessionId: `recommendation-verifier-session:${verifier.keyId}`,
			incarnationId: `recommendation-verifier-incarnation:${verifier.keyId}`,
			notBefore: "1970-01-01T00:00:00.000Z",
			expiresAt: "9999-12-31T23:59:59.999Z",
		};
		if (!binding.sessionId || !binding.incarnationId || !bootstrapTime(binding.notBefore)
			|| !bootstrapTime(binding.expiresAt) || binding.notBefore >= binding.expiresAt) {
			throw new JarvisError("RECOMMENDATION_WORK_BOOTSTRAP_INVALID");
		}
		const verifierId = `recommendation-work-verifier:${verifier.keyId}`;
		const prior = this.db.prepare("SELECT * FROM recommendation_work_verifier_bindings WHERE binding_id=?")
			.get(verifierId) as Row | undefined;
		if (prior && (prior.key_id !== verifier.keyId || prior.principal_id !== verifier.principal
			|| prior.session_id !== binding.sessionId || prior.incarnation_id !== binding.incarnationId
			|| prior.revocation_reference !== verifierId
			|| prior.not_before !== binding.notBefore || prior.expires_at !== binding.expiresAt)) {
			throw new JarvisError("RECOMMENDATION_WORK_BOOTSTRAP_MISMATCH");
		}
		if (!prior) this.db.prepare(`INSERT INTO recommendation_work_verifier_bindings(binding_id,key_id,
			principal_id,session_id,incarnation_id,revocation_reference,not_before,expires_at,created_at)
			VALUES(?,?,?,?,?,?,?,?,?)`).run(verifierId, verifier.keyId, verifier.principal, binding.sessionId,
				binding.incarnationId, verifierId, binding.notBefore, binding.expiresAt, timestamp());
		if (!providers) return;
		await this.ensureProviderBinding("dispatch", providers.dispatch);
		await this.ensureProviderBinding("progress", providers.progress);
	}
	private async ensureProviderBinding(purpose: "dispatch" | "progress", anchor: ProviderAnchor): Promise<void> {
		if (!anchor.keyId || (anchor.provider !== "codex" && anchor.provider !== "claude")
			|| !bootstrapTime(anchor.notBefore) || !bootstrapTime(anchor.expiresAt)
			|| anchor.notBefore >= anchor.expiresAt) throw new JarvisError("RECOMMENDATION_WORK_BOOTSTRAP_INVALID");
		const publicPem = createPublicKey(await readFile(anchor.publicKeyPath, "utf8"))
			.export({ type: "spki", format: "pem" }).toString();
		const bindingId = `recommendation-work-provider:${purpose}:${anchor.keyId}`;
		const prior = this.db.prepare("SELECT * FROM recommendation_work_provider_bindings WHERE purpose=?")
			.get(purpose) as Row | undefined;
		if (prior && (prior.binding_id !== bindingId || prior.key_id !== anchor.keyId
			|| prior.provider !== anchor.provider || prior.public_key_pem !== publicPem
			|| prior.revocation_reference !== bindingId
			|| prior.not_before !== anchor.notBefore || prior.expires_at !== anchor.expiresAt)) {
			throw new JarvisError("RECOMMENDATION_WORK_BOOTSTRAP_MISMATCH");
		}
		if (!prior) this.db.prepare(`INSERT INTO recommendation_work_provider_bindings(binding_id,key_id,purpose,
			provider,endpoint_scope,public_key_pem,revocation_reference,not_before,expires_at,created_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`).run(bindingId, anchor.keyId, purpose, anchor.provider,
				"recommendation-work", publicPem, bindingId, anchor.notBefore, anchor.expiresAt, timestamp());
	}
	protected async ensurePolicyKey(): Promise<void> {
		const path = `${this.filename}.policy-key.pem`;
		let privatePem: string;
		let publicPem: string;
		try {
			privatePem = await readFile(path, "utf8");
			publicPem = createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();
			await chmod(path, 0o600);
		} catch {
			const pair = generateKeyPairSync("ed25519");
			privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
			publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
			await writeFile(path, privatePem, { mode: 0o600, flag: "wx" });
		}
		const existing = this.db
			.prepare("SELECT public_key_pem FROM trusted_authority_keys WHERE key_id='local-policy-key'")
			.get() as Row | undefined;
		if (existing && existing.public_key_pem !== publicPem) throw new JarvisError("KEY_REGISTRY_MISMATCH");
		if (!existing)
			this.db
				.prepare(
					"INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES(?,?,?,?,?)",
				)
				.run("local-policy-key", "shadow-policy", "Ed25519", publicPem, timestamp());
		const mapped = this.db
			.prepare("SELECT purpose FROM authority_key_purposes WHERE key_id='local-policy-key'")
			.get() as Row | undefined;
		if (!mapped)
			this.db
				.prepare("INSERT INTO authority_key_purposes(key_id,purpose,created_at) VALUES(?,?,?)")
				.run("local-policy-key", "policy", timestamp());
		if (mapped && mapped.purpose !== "policy") throw new JarvisError("KEY_PURPOSE_MISMATCH");
	}
}
